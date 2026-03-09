// Netlify Function: stock-price
// Yahoo Finance API를 서버 사이드에서 호출 (CORS 우회)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }

  const symbols = ['GOOGL', 'TSLA', 'CPNG', 'COIN', '035420.KS'];
  const results = {};

  await Promise.allSettled(
    symbols.map(async (sym) => {
      try {
        const r = await fetchYahoo(sym);
        if (!r.ok) return;
        const data = await r.json();
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
          const prevClose = meta.chartPreviousClose || meta.previousClose || meta.regularMarketPreviousClose;
          const changePercent = meta.regularMarketChangePercent != null
            ? meta.regularMarketChangePercent
            : (prevClose ? ((meta.regularMarketPrice - prevClose) / prevClose) * 100 : 0);
          results[sym] = {
            price: meta.regularMarketPrice,
            change: changePercent,
            currency: meta.currency,
            previousClose: prevClose,
          };
        }
      } catch (e) {}
    })
  );

  return {
    statusCode: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(results),
  };
};
