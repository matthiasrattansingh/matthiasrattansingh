// FX basket from ECB euro foreign-exchange reference rates (via the Frankfurter API, no key).
// These are once-daily reference fixings (~16:00 CET on TARGET days), not live quotes; the
// dashboard labels them with their as-of date. Manual entry is available as a fallback.
import type { FxRowDto } from '../shared/types.ts';
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import type { AppContext } from './context.ts';
import { addDays, etDate } from '../domain/calendar.ts';
import { iso } from './engine.ts';

export const FX_META: Record<string, { ccy: string; invert: boolean; label: string; linkage: string }> = {
  EURUSD: { ccy: 'EUR', invert: true, label: 'EUR/USD', linkage: 'Largest weight in the dollar index; crude is priced in USD.' },
  USDJPY: { ccy: 'JPY', invert: false, label: 'USD/JPY', linkage: 'Major importer currency; macro-headline sensitive.' },
  USDCNY: { ccy: 'CNY', invert: false, label: 'USD/CNY', linkage: 'Largest crude importer.' },
  USDINR: { ccy: 'INR', invert: false, label: 'USD/INR', linkage: 'Large crude and product importer.' },
  USDCAD: { ccy: 'CAD', invert: false, label: 'USD/CAD', linkage: 'Crude-exporter currency.' },
  USDNOK: { ccy: 'NOK', invert: false, label: 'USD/NOK', linkage: 'North Sea (Brent-complex) exporter currency.' },
  GBPUSD: { ccy: 'GBP', invert: true, label: 'GBP/USD', linkage: 'Limited direct oil linkage.' },
};

export const FX_SOURCE = 'ECB reference rate via Frankfurter';

export async function fetchFx(ctx: AppContext, pairs: string[]): Promise<{ stored: number; errors: string[] }> {
  const known = pairs.filter((p) => FX_META[p]);
  if (!known.length) return { stored: 0, errors: [] };
  const end = etDate(ctx.now());
  const start = addDays(end, -10);
  const symbols = [...new Set(known.map((p) => FX_META[p].ccy))].join(',');
  const url = `${ctx.env.fxBase}/${start}..${end}?base=USD&symbols=${symbols}`;
  try {
    const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { rates?: Record<string, Record<string, number>> };
    const stored = storeFrankfurter(ctx.db, json, known, iso(ctx.now()));
    return { stored, errors: [] };
  } catch (e) {
    return { stored: 0, errors: [`FX fetch failed (${url.split('?')[0]}): ${(e as Error).message}`] };
  }
}

export function storeFrankfurter(db: Db, json: { rates?: Record<string, Record<string, number>> }, pairs: string[], observedAt: string): number {
  let stored = 0;
  for (const [date, rates] of Object.entries(json.rates ?? {})) {
    for (const pair of pairs) {
      const m = FX_META[pair];
      const r = rates[m.ccy];
      if (!(r > 0)) continue;
      repo.upsertFx(db, { pair, asOfDate: date, rate: m.invert ? 1 / r : r, source: FX_SOURCE, observedAt });
      stored++;
    }
  }
  return stored;
}

export function fxRows(db: Db, pairs: string[]): FxRowDto[] {
  return pairs
    .filter((p) => FX_META[p])
    .map((pair) => {
      const m = FX_META[pair];
      const hist = repo.fxHistory(db, pair, 5);
      const latest = hist[0];
      if (!latest) return { pair, label: m.label, linkage: m.linkage, value: null, asOfDate: null, change1d: null, change2d: null, source: null, note: 'No FX data recorded.' };
      const ch = (prev: (typeof hist)[number] | undefined) =>
        prev ? { abs: latest.rate - prev.rate, pct: ((latest.rate - prev.rate) / prev.rate) * 100, fromDate: prev.asOfDate } : null;
      return {
        pair,
        label: m.label,
        linkage: m.linkage,
        value: latest.rate,
        asOfDate: latest.asOfDate,
        change1d: ch(hist[1]),
        change2d: ch(hist[2]),
        source: latest.source,
        note: latest.source === FX_SOURCE ? 'Daily ECB reference fixing — not a live quote.' : null,
      };
    });
}
