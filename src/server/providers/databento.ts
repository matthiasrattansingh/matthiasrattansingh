// Databento historical API adapter for CME Globex (dataset GLBX.MDP3), which carries NYMEX
// energy futures by exact contract (raw symbols such as HOX6 and BZZ6).
//
// Marks use the close of the latest 1-minute OHLCV bar; the bar close is timestamped at the end
// of its minute (ts_event + 60 s). Historical-API availability lags real time; the declared delay
// is configurable and freshness is always judged from the exchange timestamp.
//
// Implemented against Databento's documented HTTP API (timeseries.get_range with JSON encoding).
import type { FetchResult, ProviderContext, QuoteProvider } from './index.ts';
import { redact } from './util.ts';
import { databentoSymbol } from '../../domain/contracts.ts';
import type { ProviderQuote } from '../quotes.ts';

const BASE = 'https://hist.databento.com/v0';
/** Databento treats data older than 24 hours as historical; newer data needs a live license. Small margin added. */
export const HISTORICAL_ONLY_LAG_MS = 24 * 3600_000 + 5 * 60_000;

function authHeader(key: string): string {
  return `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
}

/** Databento prices: decimal strings with pretty_px, otherwise fixed-point integers scaled by 1e9. */
export function parseDbnPrice(v: unknown): number {
  if (typeof v === 'number') return Math.abs(v) > 1e7 ? v / 1e9 : v;
  const s = String(v);
  if (s.includes('.')) return Number(s);
  const n = Number(s);
  return Math.abs(n) > 1e7 ? n / 1e9 : n;
}

/** Databento timestamps: ISO strings with pretty_ts, otherwise nanoseconds since the epoch. */
export function parseDbnTs(v: unknown): number {
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(BigInt(s) / 1_000_000n);
  return Date.parse(s);
}

export interface OhlcvBar {
  symbol: string;
  closeTsMs: number;
  close: number;
}

export function parseOhlcvNdjson(body: string, barSeconds: number): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const rec = JSON.parse(t) as { hd?: { ts_event?: unknown }; ts_event?: unknown; close?: unknown; symbol?: string };
    const ts = rec.hd?.ts_event ?? rec.ts_event;
    if (ts === undefined || rec.close === undefined || !rec.symbol) continue;
    out.push({ symbol: rec.symbol, closeTsMs: parseDbnTs(ts) + barSeconds * 1000, close: parseDbnPrice(rec.close) });
  }
  return out;
}

async function request(ctx: ProviderContext, path: string, params: Record<string, string>): Promise<string> {
  const key = ctx.env.databentoKey!;
  const url = `${BASE}/${path}?${new URLSearchParams(params).toString()}`;
  const res = await ctx.fetchImpl(url, { headers: { Authorization: authHeader(key), Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { detail?: unknown };
      if (j.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* keep raw */
    }
    throw new Error(redact(`Databento ${path} HTTP ${res.status}: ${detail}`, [key]));
  }
  return text;
}

async function availableEnd(ctx: ProviderContext): Promise<number> {
  try {
    const body = await request(ctx, 'metadata.get_dataset_range', { dataset: ctx.settings.databentoDataset });
    const j = JSON.parse(body) as { end?: string; end_date?: string };
    const end = j.end ?? j.end_date;
    if (end) return Math.min(Date.parse(end), ctx.nowMs);
  } catch {
    /* fall back to now */
  }
  return ctx.nowMs;
}

async function bars(ctx: ProviderContext, symbols: string[], schema: 'ohlcv-1m' | 'ohlcv-1h', startMs: number, endMs: number): Promise<OhlcvBar[]> {
  if (!symbols.length) return [];
  const body = await request(ctx, 'timeseries.get_range', {
    dataset: ctx.settings.databentoDataset,
    symbols: symbols.join(','),
    schema,
    stype_in: 'raw_symbol',
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    encoding: 'json',
    pretty_px: 'true',
    pretty_ts: 'true',
    map_symbols: 'true',
  });
  return parseOhlcvNdjson(body, schema === 'ohlcv-1m' ? 60 : 3600);
}

function toQuotes(contracts: string[], list: OhlcvBar[], ctx: ProviderContext, pick: 'last' | 'all'): FetchResult {
  const errors: string[] = [];
  const quotes: ProviderQuote[] = [];
  const bySymbol = new Map<string, OhlcvBar[]>();
  for (const b of list) bySymbol.set(b.symbol, [...(bySymbol.get(b.symbol) ?? []), b]);
  const requested = new Map(contracts.map((c) => [databentoSymbol(c), c]));
  for (const sym of bySymbol.keys()) {
    if (!requested.has(sym)) errors.push(`Databento returned unrequested symbol ${sym}; ignored (no substitution).`);
  }
  for (const [sym, contract] of requested) {
    const series = (bySymbol.get(sym) ?? []).sort((a, b) => a.closeTsMs - b.closeTsMs);
    if (!series.length) {
      errors.push(`${contract} (${sym}): no trades in the requested window.`);
      continue;
    }
    for (const b of pick === 'last' ? [series[series.length - 1]] : series) {
      quotes.push({
        contract,
        price: b.close,
        exchangeTs: new Date(b.closeTsMs).toISOString(),
        providerSymbol: sym,
        source: `Databento ${ctx.settings.databentoDataset} (CME Globex, historical API)`,
        delayMinutes: ctx.settings.databentoDelayMinutes,
        basis: '1-minute bar close (timestamp = bar end)',
      });
    }
  }
  return { quotes, errors };
}

export const databentoProvider: QuoteProvider = {
  id: 'databento',
  label: 'Databento — CME Globex MDP 3.0 (GLBX.MDP3)',
  kind: 'api',
  status(env) {
    return env.databentoKey ? { configured: true, reason: null } : { configured: false, reason: 'DATABENTO_API_KEY is not set in the server environment.' };
  },
  async fetchLatest(contracts, ctx) {
    if (!ctx.env.databentoKey) return { quotes: [], errors: ['DATABENTO_API_KEY is not set.'] };
    let end = await availableEnd(ctx);
    const symbols = contracts.map(databentoSymbol);
    const notes: string[] = [];
    let recent: OhlcvBar[];
    try {
      recent = await bars(ctx, symbols, 'ohlcv-1m', end - 90 * 60_000, end);
    } catch (e) {
      // Usage-based (free-credit) accounts without a live CME license can only read data older
      // than 24 hours. Fall back to the newest data allowed and say so; those quotes keep their
      // real exchange timestamps and therefore show as stale during the session.
      const boundary = ctx.nowMs - HISTORICAL_ONLY_LAG_MS;
      if (!/HTTP 4\d\d/.test((e as Error).message) || end <= boundary) throw e;
      notes.push(
        `Databento refused current-session data (${(e as Error).message}). Without a live CME data license the historical API only serves data older than 24 hours, so these quotes are at least a day old and are marked stale while NYMEX is open.`,
      );
      end = boundary;
      recent = await bars(ctx, symbols, 'ohlcv-1m', end - 90 * 60_000, end);
    }
    const first = toQuotes(contracts, recent, ctx, 'last');
    first.errors.unshift(...notes);
    const missing = contracts.filter((c) => !first.quotes.some((q) => q.contract === c));
    if (!missing.length) return { quotes: first.quotes, errors: first.errors.filter((e) => !e.includes('no trades')) };
    // Thin contracts or closed market: find the last traded hour, then its last minute.
    const hourly = await bars(ctx, missing.map(databentoSymbol), 'ohlcv-1h', end - 5 * 24 * 3600_000, end);
    const lastHour = new Map<string, number>();
    for (const b of hourly) lastHour.set(b.symbol, Math.max(lastHour.get(b.symbol) ?? 0, b.closeTsMs));
    const quotes = [...first.quotes];
    const errors = first.errors.filter((e) => !missing.some((m) => e.startsWith(m)));
    for (const c of missing) {
      const sym = databentoSymbol(c);
      const hourEnd = lastHour.get(sym);
      if (!hourEnd) {
        errors.push(`${c} (${sym}): no trades in the last 5 days.`);
        continue;
      }
      const minute = await bars(ctx, [sym], 'ohlcv-1m', hourEnd - 3600_000, Math.min(hourEnd, end));
      const r = toQuotes([c], minute, ctx, 'last');
      quotes.push(...r.quotes);
      errors.push(...r.errors);
    }
    return { quotes, errors };
  },
  async fetchWindow(contracts, startIso, endIso, ctx) {
    if (!ctx.env.databentoKey) return { quotes: [], errors: ['DATABENTO_API_KEY is not set.'] };
    const end = Math.min(Date.parse(endIso), await availableEnd(ctx));
    const list = await bars(ctx, contracts.map(databentoSymbol), 'ohlcv-1m', Date.parse(startIso) - 60_000, end);
    return toQuotes(contracts, list, ctx, 'all');
  },
};
