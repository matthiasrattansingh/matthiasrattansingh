import { Db } from '../src/server/db.ts';
import { readEnv } from '../src/server/settings.ts';
import { seedIfEmpty } from '../src/server/seed.ts';
import { enterManualQuotes } from '../src/server/quotes.ts';
import { loadSettings, saveSettings } from '../src/server/settings.ts';
import * as repo from '../src/server/repo.ts';
import type { AppContext } from '../src/server/context.ts';
import type { AppSettings } from '../src/shared/types.ts';

/** In-memory ledger with a controllable clock. Seeds the $100k account + crack position at `startIso`. */
export function makeApp(startIso: string, envOverrides: Record<string, string> = {}) {
  const db = new Db(':memory:');
  let now = Date.parse(startIso);
  const app: AppContext = {
    db,
    env: readEnv(envOverrides),
    now: () => now,
    fetchImpl: (async () => {
      throw new Error('network disabled in tests');
    }) as unknown as typeof fetch,
    scheduler: null,
    log: () => {},
  };
  seedIfEmpty(db, now);
  return {
    app,
    db,
    setNow(iso: string) {
      now = Date.parse(iso);
    },
    get nowMs() {
      return now;
    },
  };
}

/** Enter a manual quote with an explicit UTC exchange timestamp. */
export function quote(db: Db, nowMs: number, contract: string, price: number, exchangeIso: string, delayMinutes = 10) {
  const r = enterManualQuotes(db, [{ contract, price, exchangeTime: exchangeIso, source: 'Test feed (transcribed)', delayMinutes }], nowMs, { confirmLargeMoves: true });
  if (r.issues.length) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r;
}

export function quotes(db: Db, nowMs: number, list: [string, number, string][], delayMinutes = 10) {
  const r = enterManualQuotes(
    db,
    list.map(([contract, price, exchangeTime]) => ({ contract, price, exchangeTime, source: 'Test feed (transcribed)', delayMinutes })),
    nowMs,
    { confirmLargeMoves: true },
  );
  if (r.issues.length) throw new Error(r.issues.map((i) => i.message).join('; '));
  return r;
}

export function setMargin(db: Db, key: string, perUnitUsd: number, asOfDate = '2026-10-05') {
  repo.upsertMargin(db, { key, perUnitUsd, source: 'Test margin schedule', asOfDate, enteredAt: '2026-10-05T12:00:00.000Z', note: null });
}

export function updateSettings(db: Db, patch: Partial<AppSettings>) {
  saveSettings(db, { ...loadSettings(db), ...patch }, '2026-10-05T12:00:00.000Z');
}

/** Exact quotes for a target crack: HO fixed at 3.5000 $/gal (147 $/bbl), Brent = 147 − crack. */
export function exactCrackQuotes(crack: number, exchangeIso: string): [string, number, string][] {
  return [
    ['HOX2026', 3.5, exchangeIso],
    ['BZZ2026', Math.round((147 - crack) * 100) / 100, exchangeIso],
  ];
}
