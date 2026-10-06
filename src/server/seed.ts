// First-run seed: $100,000 simulated equity and the preloaded ULSD-vs-Brent crack position.
// The position is a simulated paper fill — no brokerage or exchange order exists or is created.
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import { iso } from './engine.ts';

export const STARTING_EQUITY = 100_000;
export const SEED_ENTRY_SPREAD = 87.33;

export function seedIfEmpty(db: Db, nowMs: number): boolean {
  if (db.getMeta('seeded')) return false;
  const nowIso = iso(nowMs);
  db.tx(() => {
    const accountId = repo.createAccount(db, STARTING_EQUITY, nowIso);
    const positionId = repo.insertPosition(db, {
      accountId,
      strategy: 'crack',
      label: 'Long NY Harbor ULSD vs Brent crack (HOX2026 / BZZ2026)',
      direction: 1,
      legs: [
        { contract: 'HOX2026', weight: 1 },
        { contract: 'BZZ2026', weight: -1 },
      ],
      contractsPerLeg: 5,
      barrels: 5_000,
      entryValue: SEED_ENTRY_SPREAD,
      entryFills: null,
      entryKind: 'seed',
      entryNote:
        'Preloaded simulated paper fill at a net spread of $87.330/bbl (HO $/gal × 42 − BZ $/bbl). Not an exchange execution; individual leg entry prices were not provided. The entry is fixed and is never replaced by a later mark. Original entry time not provided — the seed time is used.',
      openedAt: nowIso,
      orderId: null,
      rationale: 'Preloaded strategy: long NY Harbor ULSD versus Brent crack.',
      exitRuleText: 'Close both simulated legs when EIA data confirms U.S. distillate stocks have increased for three consecutive weeks.',
      exitRules: [{ type: 'eia_distillate_builds', weeks: 3 }],
      entryCommission: null,
    });
    db.run(
      "INSERT INTO notes (created_at, kind, title, body) VALUES (?, 'watch-only', ?, ?)",
      nowIso,
      'Crude options condor (watch-only)',
      'Watch-only. Excluded from positions, buying power, margin and P/L. Add strikes/expiry here for reference.',
    );
    repo.addEvent(db, {
      accountId,
      ts: nowIso,
      type: 'account.seeded',
      summary: `Paper account created with $${STARTING_EQUITY.toLocaleString('en-US')} simulated equity. Preloaded position #${positionId}: long 5 HOX2026 / short 5 BZZ2026 (5,000 bbl each) at net crack $87.330/bbl — simulated paper fill, margin unknown until verified.`,
      detail: { positionId, startingEquity: STARTING_EQUITY, entrySpread: SEED_ENTRY_SPREAD },
      dedupeKey: 'seed',
    });
    db.setMeta('seeded', nowIso);
    db.setMeta('created_at', nowIso);
  });
  return true;
}

/** Start a fresh paper account (only when flat). The old account and its history are kept. */
export function startNewAccount(db: Db, nowMs: number): number {
  return db.tx(() => {
    const current = repo.currentAccount(db);
    if (repo.openPositions(db, current.id).length) throw new Error('Close all open positions before starting a new paper account.');
    if (repo.workingOrders(db, current.id).length) throw new Error('Cancel working orders before starting a new paper account.');
    const nowIso = iso(nowMs);
    db.run("UPDATE accounts SET status = 'archived' WHERE id = ?", current.id);
    const id = repo.createAccount(db, STARTING_EQUITY, nowIso);
    repo.addEvent(db, {
      accountId: id,
      ts: nowIso,
      type: 'account.reset',
      summary: `New paper account #${id} started with $${STARTING_EQUITY.toLocaleString('en-US')} (previous account #${current.id} archived; its history is kept).`,
    });
    return id;
  });
}
