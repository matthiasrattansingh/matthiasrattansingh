import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, quotes, setMargin, updateSettings, exactCrackQuotes } from './helpers.ts';
import { evaluate } from '../src/server/engine.ts';
import { valuate } from '../src/server/valuation.ts';
import { submitOrder, previewOrder } from '../src/server/orders.ts';
import { ingestInventories, manualInventoryRows } from '../src/server/eia.ts';
import { enterManualQuotes } from '../src/server/quotes.ts';
import * as repo from '../src/server/repo.ts';
import type { OrderRequestDto } from '../src/shared/types.ts';

// Tue 2026-10-06 10:00 ET (14:00Z): NYMEX open.
const T0 = '2026-10-06T14:00:00.000Z';

function markCrack(db: Parameters<typeof quotes>[0], nowMs: number, crack: number, exchangeIso: string) {
  return quotes(db, nowMs, exactCrackQuotes(crack, exchangeIso));
}

describe('seeded paper position', () => {
  it('starts with $100,000 equity, the $87.330 entry and unknown margin', () => {
    const { db, nowMs } = makeApp(T0);
    const v = valuate(db, nowMs);
    assert.equal(v.account.starting_equity, 100_000);
    assert.equal(v.positions.length, 1);
    const p = v.positions[0];
    assert.equal(p.entryValue, 87.33);
    assert.equal(p.barrels, 5_000);
    assert.deepEqual(p.legs, [
      { contract: 'HOX2026', weight: 1 },
      { contract: 'BZZ2026', weight: -1 },
    ]);
    assert.equal(p.entryKind, 'seed');
    assert.equal(p.margin!.known, false);
    assert.equal(v.accountDto.buyingPower.verified, false);
    assert.equal(p.drawdownTriggerValue, 84.33);
  });

  it('marks to market from the matching legs without replacing the entry', () => {
    const { db, nowMs } = makeApp(T0);
    // HO 3.5500 $/gal × 42 = 149.10; Brent 59.67 → crack 89.43 → +2.10 × 5,000 = +10,500
    quotes(db, nowMs, [
      ['HOX2026', 3.55, '2026-10-06T13:52:00Z'],
      ['BZZ2026', 59.67, '2026-10-06T13:52:00Z'],
    ]);
    const v = valuate(db, nowMs);
    const p = v.positions[0];
    assert.equal(p.mark!.valid, true);
    assert.ok(Math.abs(p.mark!.value! - 89.43) < 1e-9);
    assert.ok(Math.abs(p.mark!.unrealized! - 10_500) < 1e-6);
    assert.equal(p.entryValue, 87.33);
    assert.ok(Math.abs(v.equity - 110_500) < 1e-6);
    // The evaluation run after quote entry raised the high-water mark.
    assert.ok(Math.abs(repo.currentAccount(db).peak_equity - 110_500) < 1e-6);
  });
});

describe('stale quote handling', () => {
  it('labels P/L provisional and names the stale input; peak is not raised from provisional marks', () => {
    const app = makeApp(T0);
    markCrack(app.db, app.nowMs, 87.33, '2026-10-06T13:55:00Z'); // HO 3.5000, BZ 59.67
    app.setNow('2026-10-06T15:00:00.000Z'); // both quotes now 65 min old > 10 delay + 30 tolerance
    quotes(app.db, app.nowMs, [['BZZ2026', 57.67, '2026-10-06T14:58:00Z']]); // fresh Brent only: provisional crack 89.33
    const v = evaluate(app.db, app.nowMs, 'test').valuation;
    const p = v.positions[0];
    assert.equal(p.mark!.valid, false);
    assert.equal(v.accountDto.equityValid, false);
    assert.equal(v.accountDto.unrealized, null);
    assert.ok(Math.abs(v.accountDto.unrealizedProvisional! - 10_000) < 1e-6);
    assert.deepEqual(p.mark!.missing.map((m) => m.split(':')[0]), ['HOX2026']);
    assert.match(p.mark!.missing[0], /^HOX2026: stale/);
    assert.equal(repo.currentAccount(app.db).peak_equity, 100_000); // provisional gain did not move the peak
    assert.equal(v.accountDto.buyingPower.verified, false);
  });

  it('never substitutes another contract month for a missing leg', () => {
    const { db, nowMs } = makeApp(T0);
    quotes(db, nowMs, [
      ['HOZ2026', 3.5, '2026-10-06T13:55:00Z'], // a different HO month
      ['BZZ2026', 60, '2026-10-06T13:55:00Z'],
    ]);
    const p = valuate(db, nowMs).positions[0];
    assert.equal(p.mark!.valid, false);
    assert.ok(p.mark!.missing.some((m) => m.startsWith('HOX2026: unavailable')));
  });

  it('rejects continuous symbols and $/bbl prices for gallon contracts on entry', () => {
    const { db, nowMs } = makeApp(T0);
    const r1 = enterManualQuotes(db, [{ contract: 'HO1!', price: 2.5, exchangeTime: '2026-10-06T13:55:00Z', source: 'x' }], nowMs);
    assert.equal(r1.issues[0].code, 'invalid');
    const r2 = enterManualQuotes(db, [{ contract: 'HOX2026', price: 98.5, exchangeTime: '2026-10-06T13:55:00Z', source: 'x' }], nowMs);
    assert.match(r2.issues[0].message, /quoted in \$\/gal/);
    const r3 = enterManualQuotes(db, [{ contract: 'HOX2026', price: 2.5, exchangeTime: '2026-10-06T10:30', exchangeTimeZone: 'America/New_York', source: 'x' }], nowMs);
    assert.match(r3.issues[0].message, /in the future/);
  });
});

describe('drawdown limit and simulated liquidation', () => {
  it('liquidates all positions at the first valid mark when equity reaches the 15% limit', () => {
    const { db, nowMs } = makeApp(T0);
    // crack 84.33 → P/L −15,000 → equity 85,000 = exactly 15% below the $100k peak
    markCrack(db, nowMs, 84.33, '2026-10-06T13:55:00Z');
    const pos = repo.positionById(db, 1)!;
    assert.equal(pos.status, 'closed');
    assert.equal(pos.exitKind, 'drawdown');
    assert.ok(Math.abs(pos.exitValue! - 84.33) < 1e-9);
    assert.ok(Math.abs(pos.realizedGross! + 15_000) < 1e-6);
    assert.ok(pos.exitFills!.every((f) => f.price === f.markPrice), 'no slippage configured');
    const account = repo.currentAccount(db);
    assert.equal(account.status, 'halted');
    const events = repo.listEvents(db, { type: 'risk.' });
    assert.ok(events.some((e) => e.type === 'risk.drawdown_breach'));
    const fill = events.find((e) => e.type === 'risk.liquidation_fill')!;
    const detail = fill.detail as { marks: { contract: string; exchangeTs: string }[]; simulated: boolean };
    assert.equal(detail.simulated, true);
    assert.deepEqual(detail.marks.map((m) => m.contract).sort(), ['BZZ2026', 'HOX2026']);
    // Re-running the engine (e.g. a retried scheduled run) does not close twice.
    evaluate(db, nowMs, 'retry');
    assert.equal(repo.listEvents(db, { type: 'risk.liquidation_fill' }).length, 1);
  });

  it('does not liquidate just above the limit', () => {
    const { db, nowMs } = makeApp(T0);
    markCrack(db, nowMs, 84.34, '2026-10-06T13:55:00Z');
    assert.equal(repo.positionById(db, 1)!.status, 'open');
  });

  it('applies configured slippage to the liquidation fill', () => {
    const { db, nowMs } = makeApp(T0);
    updateSettings(db, { slippageTicksPerLeg: 2, commissionPerContractPerSide: 1.5 });
    markCrack(db, nowMs, 80, '2026-10-06T13:55:00Z');
    const pos = repo.positionById(db, 1)!;
    assert.equal(pos.status, 'closed');
    // closing a long crack: sell HO 2 ticks lower (−0.0084 $/bbl), buy BZ 2 ticks higher (−0.02)
    assert.ok(Math.abs(pos.exitValue! - (80 - 0.0084 - 0.02)) < 1e-9);
    assert.equal(pos.exitCommission, 15); // 2 legs × 5 contracts × $1.50
  });

  it('measures drawdown from the peak, not from starting equity', () => {
    const app = makeApp(T0);
    markCrack(app.db, app.nowMs, 91.33, '2026-10-06T13:55:00Z'); // +20,000 → peak 120,000
    assert.ok(Math.abs(repo.currentAccount(app.db).peak_equity - 120_000) < 1e-6);
    app.setNow('2026-10-06T14:20:00.000Z');
    markCrack(app.db, app.nowMs, 87.73, '2026-10-06T14:15:00Z'); // equity 102,000: 15% below 120,000
    assert.equal(repo.positionById(app.db, 1)!.status, 'closed');
  });

  it('waits for valid marks when only provisional equity breaches', () => {
    const app = makeApp(T0);
    markCrack(app.db, app.nowMs, 87.33, '2026-10-06T13:55:00Z');
    app.setNow('2026-10-06T15:30:00.000Z'); // HO (13:55) is now stale
    quotes(app.db, app.nowMs, [['BZZ2026', 67, '2026-10-06T15:28:00Z']]); // provisional crack 80 → equity 63,350
    evaluate(app.db, app.nowMs, 'test');
    assert.equal(repo.positionById(app.db, 1)!.status, 'open');
    assert.ok(repo.listEvents(app.db, { type: 'risk.provisional_breach' }).length >= 1);
  });

  it('defers liquidation while the exchange is closed and fills on the next session mark', () => {
    const app = makeApp('2026-10-09T20:40:00.000Z'); // Fri 16:40 ET
    markCrack(app.db, app.nowMs, 87.33, '2026-10-09T20:35:00Z');
    app.setNow('2026-10-10T15:00:00.000Z'); // Saturday
    markCrack(app.db, app.nowMs, 83, '2026-10-09T20:59:00Z'); // last Friday print, entered on Saturday
    const pending = repo.positionById(app.db, 1)!;
    assert.equal(pending.status, 'exit_pending');
    assert.equal(pending.exitPending!.kind, 'drawdown');
    assert.equal(repo.currentAccount(app.db).status, 'halted');
    app.setNow('2026-10-11T22:20:00.000Z'); // Sun 18:20 ET, session open
    markCrack(app.db, app.nowMs, 82.5, '2026-10-11T22:12:00Z');
    const closed = repo.positionById(app.db, 1)!;
    assert.equal(closed.status, 'closed');
    assert.ok(Math.abs(closed.exitValue! - 82.5) < 1e-9);
  });
});

describe('EIA three-week distillate exit', () => {
  const rows = (nowMs: number, levels: number[]) =>
    manualInventoryRows(
      { weekEnding: '2026-09-11', kind: 'actual', values: [{ series: 'distillate', levelKb: levels[0] }] },
      nowMs,
    ).rows.concat(
      ...['2026-09-18', '2026-09-25', '2026-10-02'].map((w, i) => manualInventoryRows({ weekEnding: w, kind: 'actual', values: [{ series: 'distillate', levelKb: levels[i + 1] }] }, nowMs).rows),
    );

  it('closes both legs at the first valid mark after EIA confirms three consecutive builds', () => {
    const app = makeApp(T0);
    markCrack(app.db, app.nowMs, 88, '2026-10-06T13:55:00Z');
    app.setNow('2026-10-07T14:31:00.000Z'); // Wed, one minute after the 10:30 ET release
    markCrack(app.db, app.nowMs, 88.2, '2026-10-07T14:25:00Z');
    ingestInventories(app.db, rows(app.nowMs, [120_000, 120_500, 121_000, 121_800]), app.nowMs, 'manual entry');
    const pending = repo.positionById(app.db, 1)!;
    assert.equal(pending.status, 'exit_pending');
    assert.equal(pending.exitPending!.kind, 'eia');
    // The 14:25 quote predates the data, so it must not be used for the exit fill.
    app.setNow('2026-10-07T14:45:00.000Z');
    markCrack(app.db, app.nowMs, 88.6, '2026-10-07T14:35:00Z');
    const closed = repo.positionById(app.db, 1)!;
    assert.equal(closed.status, 'closed');
    assert.equal(closed.exitKind, 'eia');
    assert.ok(Math.abs(closed.exitValue! - 88.6) < 1e-9);
    assert.ok(Math.abs(closed.realizedGross! - (closed.exitValue! - 87.33) * 5_000) < 1e-6);
    assert.ok(repo.listEvents(app.db, { type: 'eia.arrived' }).length === 1);
  });

  it('does not trigger on two builds or on estimates', () => {
    const app = makeApp(T0);
    app.setNow('2026-10-07T14:31:00.000Z');
    ingestInventories(app.db, rows(app.nowMs, [120_000, 119_000, 120_000, 121_000]), app.nowMs, 'manual entry');
    const est = manualInventoryRows({ weekEnding: '2026-10-09', kind: 'estimate', values: [{ series: 'distillate', changeKb: 1_500 }] }, app.nowMs).rows;
    ingestInventories(app.db, est, app.nowMs, 'manual entry');
    assert.equal(repo.positionById(app.db, 1)!.status, 'open');
  });
});

describe('simulated order entry', () => {
  const order = (key: string, extra: Partial<OrderRequestDto> = {}): OrderRequestDto => ({
    idempotencyKey: key,
    strategy: 'outright',
    direction: 'long',
    legs: [{ contract: 'BZF2027', weight: 1 }],
    quantity: { contracts: 1 },
    entryMethod: 'market',
    timeInForce: 'day',
    rationale: 'Testing order entry rules',
    exitRuleText: 'Stop at 55',
    exitRules: [{ type: 'stop_value', level: 55 }],
    ...extra,
  });

  function readyApp() {
    const app = makeApp(T0);
    quotes(app.db, app.nowMs, [
      ...exactCrackQuotes(87.33, '2026-10-06T13:55:00Z'),
      ['BZF2027', 59.4, '2026-10-06T13:55:00Z'],
    ]);
    return app;
  }

  it('blocks new orders while margin for the preloaded position is unknown', () => {
    const app = readyApp();
    setMargin(app.db, 'BZF2027', 7_000);
    const r = submitOrder(app.db, order('key-unknown-1'), app.nowMs);
    assert.equal(r.order.status, 'rejected');
    assert.ok(r.order.reasons.some((x) => /Reserved margin unknown/.test(x)));
  });

  it('rejects when verified required margin exceeds verified buying power', () => {
    const app = readyApp();
    setMargin(app.db, 'HOX2026', 10_000);
    setMargin(app.db, 'BZZ2026', 9_000); // reserved 95,000 → buying power 5,000
    setMargin(app.db, 'BZF2027', 7_000);
    const p = previewOrder(app.db, order('preview-1'), app.nowMs).preview;
    assert.equal(p.margin!.before.buyingPower, 5_000);
    assert.equal(p.margin!.required.amount, 7_000);
    assert.equal(p.ok, false);
    const r = submitOrder(app.db, order('key-insufficient-1'), app.nowMs);
    assert.equal(r.order.status, 'rejected');
    assert.ok(r.order.reasons.some((x) => /exceeds buying power/.test(x)));
    assert.equal(repo.openPositions(app.db, 1).length, 1);
  });

  it('accepts when margin is covered, shows before/after buying power, fills at the next mark', () => {
    const app = readyApp();
    setMargin(app.db, 'HOX2026', 6_000);
    setMargin(app.db, 'BZZ2026', 5_000); // reserved 55,000 → BP 45,000
    setMargin(app.db, 'BZF2027', 7_000);
    const r = submitOrder(app.db, order('key-ok-00001'), app.nowMs);
    assert.equal(r.order.status, 'working');
    assert.equal(r.preview!.margin!.before.buyingPower, 45_000);
    assert.equal(r.preview!.margin!.buyingPowerAfter, 38_000);
    // The existing 13:55 quote predates submission: no fill yet.
    assert.equal(repo.openPositions(app.db, 1).length, 1);
    app.setNow('2026-10-06T14:12:00.000Z');
    quotes(app.db, app.nowMs, [['BZF2027', 59.55, '2026-10-06T14:02:00Z']]);
    const positions = repo.openPositions(app.db, 1);
    assert.equal(positions.length, 2);
    assert.ok(Math.abs(positions[1].entryValue - 59.55) < 1e-9);
    assert.equal(repo.orderByKey(app.db, 'key-ok-00001')!.status, 'filled');
  });

  it('is idempotent: a retried submission returns the original order', () => {
    const app = readyApp();
    setMargin(app.db, 'HOX2026', 6_000);
    setMargin(app.db, 'BZZ2026', 5_000);
    setMargin(app.db, 'BZF2027', 7_000);
    const a = submitOrder(app.db, order('retry-key-1'), app.nowMs);
    const b = submitOrder(app.db, order('retry-key-1'), app.nowMs);
    assert.equal(b.duplicate, true);
    assert.equal(a.order.id, b.order.id);
    assert.equal(app.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM orders')!.n, 1);
  });

  it('enforces the weekday rule and the daily trade limit', () => {
    const app = readyApp();
    setMargin(app.db, 'HOX2026', 6_000);
    setMargin(app.db, 'BZZ2026', 5_000);
    setMargin(app.db, 'BZF2027', 7_000);
    assert.equal(submitOrder(app.db, order('daily-1-xxx'), app.nowMs).order.status, 'working');
    const second = submitOrder(app.db, order('daily-2-xxx'), app.nowMs);
    assert.equal(second.order.status, 'rejected');
    assert.ok(second.order.reasons.some((x) => /Daily limit reached/.test(x)));
    app.setNow('2026-10-10T15:00:00.000Z'); // Saturday
    const weekend = previewOrder(app.db, order('weekend-1', { entryMethod: 'limit', limitValue: 58, timeInForce: 'gtc' }), app.nowMs).preview;
    assert.ok(weekend.reasons.some((x) => /Monday–Friday/.test(x)));
  });

  it('requires whole contracts (barrels must be multiples of 1,000)', () => {
    const app = readyApp();
    const p = previewOrder(app.db, order('bbl-1', { quantity: { barrels: 2_500 } }), app.nowMs).preview;
    assert.ok(p.reasons.some((x) => /multiple of 1,000/.test(x)));
  });
});
