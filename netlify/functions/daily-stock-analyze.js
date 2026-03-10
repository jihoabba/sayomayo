// Netlify Scheduled Function: daily-stock-analyze
// 평일 14:30 UTC (09:30 EST / 미국장 개장, 23:30 KST) 자동 실행
// 한국장(NAVER) 분석도 포함 — KST 09:00 = UTC 00:00이지만 미국장 시간에 통합 실행

const FIREBASE_PROJECT = 'sayomayo-ee086';
const FIREBASE_API_KEY = 'AIzaSyCRg5Ql00zUVYkUqO9Li7x5TdAP8UnoKaA';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const COLLECTION = 'stock_history';

const STOCKS = [
  { id: 'GOOGL',    name: '알파벳 A (구글)', symbol: 'GOOGL',      currency: 'USD' },
  { id: 'TSLA',     name: '테슬라',          symbol: 'TSLA',       currency: 'USD' },
  { id: 'CPNG',     name: '쿠팡',            symbol: 'CPNG',       currency: 'USD' },
  { id: 'COINBASE', name: '코인베이스',       symbol: 'COIN',       currency: 'USD' },
  { id: 'NAVER',    name: '네이버',           symbol: '035420.KS',  currency: 'KRW' },
];

const SIGNAL_LABELS = { BUY: '매수', HOLD: '보류', PARTIAL: '분할 매도', SELL: '매도' };

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

// ── Yahoo Finance ──

async function fetchYahoo(symbol, attempt = 0) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d&includePrePost=false`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sayomayo-bot/1.0)' },
  });
  if (r.status === 429 && attempt < 3) {
    await sleep((attempt + 1) * 3000);
    return fetchYahoo(symbol, attempt + 1);
  }
  return r;
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

  // Fetch USD/KRW
  let usdKrw = 1350;
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const d = await r.json();
    usdKrw = d.rates.KRW;
  } catch (e) { console.warn('USD/KRW fetch failed:', e.message); }

  // Fetch Yahoo Finance prices for all stocks
  const stockPrices = {};
  await Promise.allSettled(
    STOCKS.map(async (stock) => {
      try {
        const r = await fetchYahoo(stock.symbol);
        if (!r.ok) return;
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
          const prevClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose;
          const changePercent = meta.regularMarketChangePercent != null
            ? meta.regularMarketChangePercent
            : (prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : 0);
          const priceUSD = stock.currency === 'USD' ? meta.regularMarketPrice : null;
          const priceKRW = stock.currency === 'KRW'
            ? Math.round(meta.regularMarketPrice)
            : Math.round(meta.regularMarketPrice * usdKrw);
          stockPrices[stock.id] = { usd: priceUSD, krw: priceKRW, change: changePercent, currency: stock.currency };
        }
      } catch (e) { console.warn(`Yahoo fetch failed for ${stock.symbol}:`, e.message); }
    })
  );

  const now = new Date();
  const kstOptions = { timeZone: 'Asia/Seoul' };
  const estOptions = { timeZone: 'America/New_York' };
  const dateStr = now.toLocaleDateString('ko-KR', { ...kstOptions, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const timeStr = now.toLocaleTimeString('ko-KR', kstOptions);

  // Analyze each stock sequentially
  for (let i = 0; i < STOCKS.length; i++) {
    if (i > 0) await sleep(5000);
    const stock = STOCKS[i];
    const p = stockPrices[stock.id];

    try {
      const history = await loadHistory(stock.id);
      const lastEntry = history.length > 0 ? history[history.length - 1] : null;

      // Update previous entry's wasCorrect
      if (lastEntry && p && lastEntry.wasCorrect == null) {
        const wasCorrect = isCorrect(lastEntry.signal, lastEntry.priceKRW, p.krw);
        if (wasCorrect !== null) history[history.length - 1].wasCorrect = wasCorrect;
      }

      // Hit rate
      const hitRate = calcHitRate(history);
      const hitRateStr = hitRate !== null ? `${(hitRate * 100).toFixed(0)}%` : '데이터 부족';
      const lowHitRate = hitRate !== null && hitRate < 0.6;

      // Build prompt context
      let priceContext = '';
      if (p) {
        if (stock.currency === 'USD') {
          priceContext = `현재가: $${p.usd?.toLocaleString(undefined, { maximumFractionDigits: 2 })} (₩${p.krw.toLocaleString()}) | 1d변동: ${(p.change ?? 0).toFixed(2)}% | USD/KRW: ${Math.round(usdKrw)}`;
        } else {
          priceContext = `현재가: ₩${p.krw.toLocaleString()} | 1d변동: ${(p.change ?? 0).toFixed(2)}%`;
        }
      } else {
        priceContext = '가격 정보 없음 (최신 시장 데이터 기반으로 추정 분석)';
      }

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

      const supportCurrency = stock.currency === 'KRW' ? '원화' : '달러';
      const improvementField = lowHitRate
        ? `  "hitImprovement": "최근 적중률 ${hitRateStr}로 60% 미만. 분석 정확도 개선을 위한 구체적 제안 1-2문장.",\n`
        : '';

      const prompt = `당신은 경험 많은 주식 투자 분석가입니다. 24시간 스윙 트레이딩 관점으로 분석하세요 (다음 거래일 장 마감까지의 예측).

분석 일시: ${dateStr} ${timeStr} (KST)
종목: ${stock.name} (${stock.symbol})
${priceContext}
${prevContext}

다음 JSON 형식으로만 응답하세요. 다른 텍스트 없이 JSON만:
{
  "signal": "BUY" | "HOLD" | "PARTIAL" | "SELL",
  "analysis": "현재 시장 상황, 기술적 지표 흐름, 최근 뉴스 및 실적 감성을 종합한 24h 스윙 근거 2-3문장. 구체적 수치 포함.",
  "prevComment": ${lastEntry ? '"이전 분석의 적중 여부와 시장 변화 이유를 1-2문장으로."' : 'null'},
${improvementField}  "indicators": {
    "rsi": RSI 추정값 (숫자, 0-100),
    "trend": "상승" | "중립" | "하락",
    "volume": "증가" | "보통" | "감소",
    "sentiment": "긍정" | "중립" | "부정",
    "support": "주요 지지선 가격대 (${supportCurrency} 기준 문자열)"
  }
}

signal 기준 (24h 스윙 트레이딩):
- BUY: 다음 장 마감 기준 +0.5% 이상 상승 예상 → 매수
- HOLD: 방향 불명확, ±3% 이내 횡보 예상 → 현 포지션 유지
- PARTIAL: 하락 리스크 있음 → 분할 매도 권장
- SELL: 다음 장 마감 기준 -0.5% 이상 하락 예상 → 매도`;

      const response = await callClaude(apiKey, prompt);
      if (!response.ok) {
        console.error(`Claude error for ${stock.id}: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const textContent = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error(`No JSON in response for ${stock.id}`);
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
      await saveHistory(stock.id, history);
      console.log(`✓ ${stock.id}: ${parsed.signal}`);
    } catch (e) {
      console.error(`Error analyzing ${stock.id}:`, e.message);
    }
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, timestamp: now.toISOString() }) };
};
