// Generic HTTP/JSON quote adapter for any market-data API you are licensed to use.
// Configure in Settings: a URL template containing {symbol} (and optionally {apiKey}), the
// symbol template for exact contracts, JSON paths to the price/timestamp/symbol fields and the
// source's declared delay. The API key comes from CUSTOM_QUOTE_API_KEY and is injected
// server-side only.
import type { FetchResult, QuoteProvider } from './index.ts';
import { redact } from './util.ts';
import { templateSymbol } from '../../domain/contracts.ts';
import type { ProviderQuote } from '../quotes.ts';

export function getPath(obj: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

export function parseTimestamp(v: unknown, format: 'iso' | 'epoch_ms' | 'epoch_s'): number {
  if (v === null || v === undefined || v === '') return NaN;
  if (format === 'epoch_ms') return Number(v);
  if (format === 'epoch_s') return Number(v) * 1000;
  const s = String(v);
  // Require an explicit offset so an exchange-local wall-clock time is never misread as UTC.
  if (!/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) return NaN;
  return Date.parse(s);
}

export const customHttpProvider: QuoteProvider = {
  id: 'custom-http',
  label: 'Custom HTTP/JSON quote API',
  kind: 'api',
  status(env, settings) {
    const c = settings.customHttp;
    if (!c.urlTemplate) return { configured: false, reason: 'Set the URL template in Settings → Market data.' };
    if (c.urlTemplate.includes('{apiKey}') && !env.customQuoteKey) return { configured: false, reason: 'URL template uses {apiKey} but CUSTOM_QUOTE_API_KEY is not set.' };
    if (c.authHeader && !env.customQuoteKey) return { configured: false, reason: `Auth header ${c.authHeader} configured but CUSTOM_QUOTE_API_KEY is not set.` };
    if (!c.symbolPath) return { configured: true, reason: 'Warning: no symbol path configured, so the returned contract cannot be verified.' };
    return { configured: true, reason: null };
  },
  async fetchLatest(contracts, ctx): Promise<FetchResult> {
    const c = ctx.settings.customHttp;
    const key = ctx.env.customQuoteKey;
    const quotes: ProviderQuote[] = [];
    const errors: string[] = [];
    for (const contract of contracts) {
      const symbol = templateSymbol(contract, c.symbolTemplate);
      const url = c.urlTemplate.replaceAll('{symbol}', encodeURIComponent(symbol)).replaceAll('{apiKey}', encodeURIComponent(key ?? ''));
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (c.authHeader && key) headers[c.authHeader] = key;
        const res = await ctx.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as unknown;
        if (c.symbolPath) {
          const echoed = getPath(body, c.symbolPath);
          if (String(echoed ?? '').toUpperCase() !== symbol.toUpperCase()) {
            throw new Error(`returned symbol "${String(echoed)}" ≠ requested "${symbol}"; refusing to substitute a different contract`);
          }
        }
        const price = Number(getPath(body, c.pricePath));
        const tsMs = parseTimestamp(getPath(body, c.timestampPath), c.timestampFormat);
        if (!Number.isFinite(price)) throw new Error(`no numeric price at "${c.pricePath}"`);
        if (!Number.isFinite(tsMs)) throw new Error(`no usable timestamp at "${c.timestampPath}" (ISO values must include a UTC offset)`);
        quotes.push({
          contract,
          price,
          exchangeTs: new Date(tsMs).toISOString(),
          providerSymbol: symbol,
          source: c.sourceLabel || 'Custom HTTP quote API',
          delayMinutes: c.delayMinutes,
          basis: `JSON ${c.pricePath}`,
        });
      } catch (e) {
        errors.push(redact(`${contract} (${symbol}): ${(e as Error).message}`, [key]));
      }
    }
    return { quotes, errors };
  },
};
