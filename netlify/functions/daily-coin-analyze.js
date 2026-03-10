// Netlify Scheduled Function: daily-coin-analyze
// 매일 00:00 UTC (09:00 KST) 자동 실행 - 코인 24h 스윙 트레이딩 분석

const FIREBASE_PROJECT = 'sayomayo-ee086';
const FIREBASE_API_KEY = 'AIzaSyCRg5Ql00zUVYkUqO9Li7x5TdAP8UnoKaA';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const COLLECTION = 'coin_history';

const COINS = [
  { id: 'BTC', name: '비트코인', geckoId: 'bitcoin' },
  { id: 'ETH', name: '이더리움', geckoId: 'ethereum' },
  { id: 'XRP', name: '리플',    geckoId: 'ripple' },
  { id: 'SOL', name: '솔라나',  geckoId: 'solana' },
];

const SIGNAL_LABELS = { BUY: '추가 매수', HOLD: '보류', PARTIAL: '분할 매도', SELL: '전량 매도' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Firestore REST ──

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(toFirestoreValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      if (v !== undefined) fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFirestoreValue(val) {
  if (!val) return null;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return val.booleanValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return val.doubleValue;
  if ('stringValue' in val) return val.stringValue;
  if ('arrayValue' in val) return (val.arrayValue.values || []).map(fromFirestoreValue);
  if ('mapValue' in val) {
    const obj = {};
    for (const [k, v] of Object.entries(val.mapValue.fields || {})) {
      obj[k] = fromFirestoreValue(v);
    }
    return obj;
  }
  return null;
}

async function loadHistory(docId) {
  const url = `${BASE_URL}/${COLLECTION}/${docId}?key=${FIREBASE_API_KEY}`;
  const r = await fetch(url);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Firestore GET ${r.status}`);
  const data = await r.json();
  const histField = data.fields?.history;
  if (!histField) return [];
  return fromFirestoreValue(histField);
}

async function saveHistory(docId, history) {
  const url = `${BASE_URL}/${COLLECTION}/${docId}?key=${FIREBASE_API_KEY}&updateMask.fieldPaths=history`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { history: toFirestoreValue(history) } }),
  });
  if (!r.ok) throw new Error(`Firestore PATCH ${r.status}: ${await r.text()}`);
}

// ── Hit rate ──

function isCorrect(signal, priceBefore, priceAfter) {
  if (!priceBefore || !priceAfter) return null;
  const change = (priceAfter - priceBefore) / priceBefore;
  if (signal === 'BUY')     return change > 0.005;
  if (signal === 'SELL')    return change < -0.005;
  if (signal === 'PARTIAL') return change < -0.005;
  if (signal === 'HOLD')    return Math.abs(change) <= 0.05;
  return null;
}

function calcHitRate(history) {
  const checked = history.slice(-10).filter(e => e.wasCorrect !== null && e.wasCorrect !== undefined);
  if (!checked.length) return null;
  return checked.filter(e => e.wasCorrect).length / checked.length;
}

// ── Claude API ──

async function callClaude(apiKey, prompt, attempt = 0) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (response.status === 429 && attempt < 3) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
    const delay = retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 8000;
    await sleep(delay);
    return callClaude(apiKey, prompt, attempt + 1);
  }
  return response;
}

// ── Main ──

exports.handler = async () => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return { statusCode: 500, body: 'Missing API key' };
  }

  // Fetch prices
  let usdKrw = 1350;
  const coinPrices = {};

  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const d = await r.json();
    usdKrw = d.rates.KRW;
  } catch (e) { console.warn('USD/KRW fetch failed:', e.message); }

  try {
    const ids = COINS.map(c => c.geckoId).join(',');
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
    const d = await r.json();
    COINS.forEach(c => {
      const data = d[c.geckoId];
      if (data) {
        coinPrices[c.id] = {
          usd: data.usd,
          krw: Math.round(data.usd * usdKrw),
          change24h: data.usd_24h_change,
        };
      }
    });
  } catch (e) { console.warn('CoinGecko fetch failed:', e.message); }

  const now = new Date();
  const kstOptions = { timeZone: 'Asia/Seoul' };
  const dateStr = now.toLocaleDateString('ko-KR', { ...kstOptions, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('ko-KR', kstOptions);

  // Analyze each coin sequentially
  for (let i = 0; i < COINS.length; i++) {
    if (i > 0) await sleep(5000);
    const coin = COINS[i];
    const p = coinPrices[coin.id];

    try {
      const history = await loadHistory(coin.id);
      const lastEntry = history.length > 0 ? history[history.length - 1] : null;

      // Update previous entry's wasCorrect
      if (lastEntry && p && lastEntry.wasCorrect == null) {
        const wasCorrect = isCorrect(lastEntry.signal, lastEntry.priceKRW, p.krw);
        if (wasCorrect !== null) history[history.length - 1].wasCorrect = wasCorrect;
      }

      // Hit rate info
      const hitRate = calcHitRate(history);
      const hitRateStr = hitRate !== null ? `${(hitRate * 100).toFixed(0)}%` : '데이터 부족';
      const lowHitRate = hitRate !== null && hitRate < 0.6;

      // Build prompt context
      let priceContext = p
        ? `현재가: ₩${p.krw.toLocaleString()} ($${p.usd}) | 24h변동: ${p.change24h.toFixed(2)}% | USD/KRW: ${Math.round(usdKrw)}`
        : '가격 정보 없음 (최신 시장 데이터 기반으로 추정 분석)';

      let prevContext = '';
      if (lastEntry && p) {
        const wasCorrect = isCorrect(lastEntry.signal, lastEntry.priceKRW, p.krw);
        const vsChange = ((p.krw - lastEntry.priceKRW) / lastEntry.priceKRW * 100);
        const prevTime = new Date(lastEntry.timestamp).toLocaleString('ko-KR', kstOptions);
        prevContext = `\n[이전 분석 정보]
이전 분석 일시: ${prevTime}
이전 분석 당시 가격: ₩${Number(lastEntry.priceKRW).toLocaleString()}
이전 의견: ${lastEntry.signal} (${SIGNAL_LABELS[lastEntry.signal] || lastEntry.signal})
이전 분석 대비 현재 가격 변동: ${vsChange >= 0 ? '+' : ''}${vsChange.toFixed(2)}%
이전 의견 적중 여부: ${wasCorrect === null ? '판단 불가' : wasCorrect ? '✓ 적중' : '✗ 미적중'}
최근 적중률: ${hitRateStr}`;
      }

      const improvementField = lowHitRate
        ? `  "hitImprovement": "최근 적중률 ${hitRateStr}로 60% 미만. 분석 정확도 개선을 위한 구체적 제안 1-2문장.",\n`
        : '';

      const prompt = `당신은 경험 많은 암호화폐 투자 분석가입니다. 24시간 스윙 트레이딩 관점으로 분석하세요 (내일 오전 9시 KST까지의 예측).

분석 일시: ${dateStr} ${timeStr} (KST)
코인: ${coin.name} (${coin.id})
${priceContext}
${prevContext}

다음 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만:
{
  "signal": "BUY" | "HOLD" | "PARTIAL" | "SELL",
  "analysis": "현재 시장 상황, 기술적 지표 흐름, 최근 뉴스 감성을 종합한 24h 스윙 근거 2-3문장. 구체적 수치 포함.",
  "prevComment": ${lastEntry ? '"이전 분석의 적중 여부와 시장 변화 이유를 1-2문장으로."' : 'null'},
${improvementField}  "indicators": {
    "rsi": RSI 추정값 (숫자, 0-100),
    "trend": "상승" | "중립" | "하락",
    "volume": "증가" | "보통" | "감소",
    "sentiment": "긍정" | "중립" | "부정",
    "support": "주요 지지선 가격대 (원화 기준 문자열)"
  }
}

signal 기준 (24h 스윙 트레이딩):
- BUY: 내일 오전 9시 기준 +0.5% 이상 상승 예상 → 추가 매수
- HOLD: 방향 불명확, ±3% 이내 횡보 예상 → 현 포지션 유지
- PARTIAL: 하락 리스크 있음 → 분할 매도 권장
- SELL: 내일 오전 9시 기준 -0.5% 이상 하락 예상 → 전량 매도`;

      const response = await callClaude(apiKey, prompt);
      if (!response.ok) {
        console.error(`Claude error for ${coin.id}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const textContent = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error(`No JSON in response for ${coin.id}`);
        continue;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const newEntry = {
        timestamp: now.toISOString(),
        signal: parsed.signal,
        priceKRW: p ? p.krw : null,
        priceUSD: p ? p.usd : null,
        analysis: parsed.analysis,
        prevComment: parsed.prevComment || null,
        indicators: parsed.indicators || null,
        hitImprovement: parsed.hitImprovement || null,
        wasCorrect: null,
      };

      history.push(newEntry);
      if (history.length > 10) history.splice(0, history.length - 10);
      await saveHistory(coin.id, history);
      console.log(`✓ ${coin.id}: ${parsed.signal}`);
    } catch (e) {
      console.error(`Error analyzing ${coin.id}:`, e.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, timestamp: now.toISOString() }) };
};
