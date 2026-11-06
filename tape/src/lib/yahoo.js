// Live quotes from Yahoo Finance's public chart API (no key).
// Yahoo doesn't send CORS headers, so in `npm run dev` requests go through
// the Vite proxy at /yf (see vite.config.js). A direct call is tried as a
// second option. Any failure returns null and the card uses its seed snapshot.
import { loadJSON, saveJSON } from './storage.js';

const CACHE_KEY = 'tape.quotes.v1';
const CACHE_MS = 5 * 60 * 1000;
const DAYS = 6; // 6 closes = a 5-day sparkline

function urls(symbol) {
  const path = `/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
  const list = [];
  if (import.meta.env.VITE_YF_BASE) list.push(`${import.meta.env.VITE_YF_BASE}${path}`);
  list.push(`./yf${path}`); // Vite proxy in dev; Vercel rewrite to api/chart.js when hosted
  list.push(`https://query1.finance.yahoo.com${path}`);
  return list;
}

function isoDay(unixSeconds, tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/New_York' }).format(new Date(unixSeconds * 1000));
  } catch {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }
}

/** Parse a chart API response into { price, prevClose, series, asOf }. Exported for testing. */
export function parseChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const tz = r.meta?.exchangeTimezoneName;
  const closes = (r.timestamp ?? [])
    .map((t, i) => ({ t, c: r.indicators?.quote?.[0]?.close?.[i] }))
    .filter((x) => typeof x.c === 'number' && Number.isFinite(x.c));
  if (closes.length < 2) return null;
  const tail = closes.slice(-DAYS);
  const last = tail[tail.length - 1];
  const price = typeof r.meta?.regularMarketPrice === 'number' ? r.meta.regularMarketPrice : last.c;
  const series = tail.map((x) => x.c);
  series[series.length - 1] = price;
  return {
    price,
    prevClose: tail[tail.length - 2].c,
    series,
    asOf: isoDay(r.meta?.regularMarketTime ?? last.t, tz),
    live: true,
  };
}

async function fetchJSON(url, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchQuote(symbol) {
  for (const url of urls(symbol)) {
    try {
      const q = parseChart(await fetchJSON(url));
      if (q) return q;
    } catch {
      /* try the next route, then fall back silently */
    }
  }
  return null;
}

/** Fetch all symbols, using a 5-minute cache. Returns { [symbol]: quote|null }. */
export async function fetchQuotes(symbols) {
  const cached = loadJSON(CACHE_KEY);
  if (cached && Date.now() - cached.at < CACHE_MS && symbols.every((s) => s in cached.quotes)) return cached.quotes;
  const entries = await Promise.all(symbols.map(async (s) => [s, await fetchQuote(s)]));
  const quotes = Object.fromEntries(entries);
  if (entries.some(([, q]) => q)) saveJSON({ at: Date.now(), quotes }, CACHE_KEY);
  return quotes;
}
