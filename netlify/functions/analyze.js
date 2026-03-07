// Netlify Function: analyze
// Anthropic API를 서버 사이드에서 호출 — API 키가 클라이언트에 노출되지 않음

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callAnthropic(apiKey, prompt, attempt = 0) {
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

  // 429 Rate Limit: 지수 백오프 후 재시도 (최대 3회)
  if (response.status === 429 && attempt < 3) {
    const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
    const delay = retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 8000;
    await sleep(delay);
    return callAnthropic(apiKey, prompt, attempt + 1);
  }

  return response;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS_HEADERS, body: 'Method Not Allowed' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: 'ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.' }),
    };
  }

  let prompt;
  try {
    ({ prompt } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: '잘못된 요청 형식' }) };
  }

  if (!prompt) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: 'prompt 필드 없음' }) };
  }

  try {
    const response = await callAnthropic(apiKey, prompt);
    const data = await response.json();

    if (!response.ok) {
      return {
        statusCode: response.status,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: data.error?.message || `Anthropic API 오류 ${response.status}` }),
      };
    }

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `네트워크 오류: ${err.message}` }),
    };
  }
};
