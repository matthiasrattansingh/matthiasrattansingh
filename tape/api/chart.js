// Vercel serverless function: forwards Yahoo Finance chart requests so the
// browser can read them (Yahoo sends no CORS headers). Only the five TAPE
// symbols and a fixed query are allowed, so this can't be used as an open proxy.
const ALLOWED = new Set(['CL=F', 'BZ=F', 'RB=F', 'HO=F', 'NG=F']);

export default async function handler(req, res) {
  let symbol = String(req.query.symbol ?? '');
  if (symbol.includes('%')) symbol = decodeURIComponent(symbol);
  if (!ALLOWED.has(symbol)) {
    res.status(400).json({ error: 'unsupported symbol' });
    return;
  }
  try {
    const upstream = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (TAPE)' } },
    );
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(upstream.status).send(body);
  } catch {
    res.status(502).json({ error: 'upstream unavailable' });
  }
}
