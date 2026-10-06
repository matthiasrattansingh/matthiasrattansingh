import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeContracts, databentoSymbol, isContractCode, lastTradingDay, parseContract, templateSymbol, tradingViewSymbol } from '../src/domain/contracts.ts';
import { checkOrderMargin, computeBuyingPower, drawdownFloor, drawdownFraction, isDrawdownBreached, marginRequirement, spreadMarginKey } from '../src/domain/risk.ts';
import { classifyQuote } from '../src/domain/freshness.ts';
import { consecutiveBuilds, evaluateDistillateExit, type InventoryObs } from '../src/domain/inventory.ts';
import { findDirectionalLanguage } from '../src/domain/neutrality.ts';
import { hourlySlotsBetween, isMarketOpen, nextEiaRelease, eiaReleaseForWeek } from '../src/domain/calendar.ts';

describe('contracts', () => {
  it('parses exact contract codes and rejects continuous symbols', () => {
    assert.deepEqual(parseContract('hox2026'), { code: 'HOX2026', product: 'HO', monthCode: 'X', month: 11, year: 2026 });
    assert.equal(isContractCode('HO1!'), false);
    assert.equal(isContractCode('BZ'), false);
    assert.throws(() => parseContract('NYMEX:HO1!'));
  });
  it('computes last trading days from CME rules', () => {
    assert.equal(lastTradingDay('HOX2026'), '2026-10-30');
    assert.equal(lastTradingDay('BZZ2026'), '2026-10-30');
    assert.equal(lastTradingDay('BZF2027'), '2026-11-30');
    assert.equal(lastTradingDay('CLX2026'), '2026-10-20'); // 25th is a Sunday
  });
  it('resolves M1/M2 explicitly by expiry, not by continuous alias', () => {
    assert.deepEqual(activeContracts('BZ', '2026-10-06', 2), ['BZZ2026', 'BZF2027']);
    assert.deepEqual(activeContracts('HO', '2026-10-06', 2), ['HOX2026', 'HOZ2026']);
    assert.deepEqual(activeContracts('HO', '2026-10-31', 1), ['HOZ2026']);
  });
  it('maps to provider symbols for the same exact contract', () => {
    assert.equal(databentoSymbol('HOX2026'), 'HOX6');
    assert.equal(tradingViewSymbol('BZZ2026'), 'NYMEX:BZZ2026');
    assert.equal(templateSymbol('BZZ2026', '{root}{month}{yy}'), 'BZZ26');
  });
});

describe('drawdown', () => {
  it('measures peak-to-current drawdown', () => {
    assert.equal(drawdownFraction(100_000, 85_000), 0.15);
    assert.equal(drawdownFraction(100_000, 120_000), 0);
    assert.equal(drawdownFloor(110_000, 15), 93_500);
  });
  it('treats reaching the limit exactly as a breach', () => {
    assert.equal(isDrawdownBreached(100_000, 85_000, 15), true);
    assert.equal(isDrawdownBreached(100_000, 85_000.01, 15), false);
    assert.equal(isDrawdownBreached(110_000, 93_500, 15), true);
    assert.equal(isDrawdownBreached(110_000, 93_600, 15), false);
  });
});

describe('margin and buying power', () => {
  const legs = [
    { contract: 'HOX2026', weight: 1 as const },
    { contract: 'BZZ2026', weight: -1 as const },
  ];
  const fig = (key: string, perUnitUsd: number, asOfDate = '2026-10-01') => [key, { key, perUnitUsd, source: 'test', asOfDate, enteredAt: '2026-10-01T00:00:00Z' }] as const;

  it('is unknown when any leg lacks a margin figure (never guessed from notional)', () => {
    const r = marginRequirement(legs, 5, new Map([fig('HOX2026', 9_000)]), '2026-10-06', 30);
    assert.equal(r.known, false);
    assert.equal(r.amount, null);
    assert.deepEqual(r.missing, ['BZZ2026']);
  });
  it('treats figures older than the max age as unverified', () => {
    const r = marginRequirement(legs, 5, new Map([fig('HOX2026', 9_000, '2026-08-01'), fig('BZZ2026', 7_000)]), '2026-10-06', 30);
    assert.equal(r.known, false);
    assert.deepEqual(r.stale, ['HOX2026']);
  });
  it('sums outright leg margins or uses a configured spread margin', () => {
    const sum = marginRequirement(legs, 5, new Map([fig('HOX2026', 9_000), fig('BZZ2026', 7_000)]), '2026-10-06', 30);
    assert.equal(sum.amount, 80_000);
    assert.equal(sum.basis, 'sum-of-legs');
    const spread = marginRequirement(legs, 5, new Map([fig('HOX2026', 9_000), fig('BZZ2026', 7_000), fig(spreadMarginKey(legs), 4_000)]), '2026-10-06', 30);
    assert.equal(spread.amount, 20_000);
    assert.equal(spread.basis, 'spread');
  });
  it('rejects an order when verified required margin exceeds verified buying power', () => {
    const reserved = marginRequirement(legs, 5, new Map([fig('HOX2026', 9_000), fig('BZZ2026', 7_000)]), '2026-10-06', 30);
    const bp = computeBuyingPower(100_000, true, [reserved]);
    assert.equal(bp.buyingPower, 20_000);
    const required = marginRequirement([{ contract: 'BZF2027', weight: 1 }], 3, new Map([fig('BZF2027', 7_000)]), '2026-10-06', 30);
    const check = checkOrderMargin(bp, required);
    assert.equal(check.ok, false);
    assert.match(check.reasons[0], /Required initial margin \$21,000\.00 exceeds buying power \$20,000\.00/);
    const ok = checkOrderMargin(bp, marginRequirement([{ contract: 'BZF2027', weight: 1 }], 2, new Map([fig('BZF2027', 7_000)]), '2026-10-06', 30));
    assert.equal(ok.ok, true);
    assert.equal(ok.buyingPowerAfter, 6_000);
    assert.equal(ok.reservedAfter, 94_000);
  });
  it('blocks orders when buying power cannot be verified', () => {
    const unknownReserved = marginRequirement(legs, 5, new Map(), '2026-10-06', 30);
    const bp = computeBuyingPower(100_000, true, [unknownReserved]);
    assert.equal(bp.verified, false);
    assert.equal(bp.buyingPower, null);
    const check = checkOrderMargin(bp, marginRequirement([{ contract: 'BZF2027', weight: 1 }], 1, new Map([fig('BZF2027', 7_000)]), '2026-10-06', 30));
    assert.equal(check.ok, false);
    const provisional = computeBuyingPower(100_000, false, [], ['HOX2026 stale']);
    assert.equal(provisional.verified, false);
  });
});

describe('quote freshness', () => {
  const q = (exchangeTs: string, delayMinutes: number | null = 10) => ({ contract: 'HOX2026', price: 2.5, exchangeTs, observedAt: exchangeTs, delayMinutes, source: 'test' });
  const tueOpen = Date.parse('2026-10-06T14:00:00Z'); // Tue 10:00 ET, market open
  it('reports unavailable with no quote', () => {
    const f = classifyQuote(null, tueOpen, 30);
    assert.equal(f.status, 'unavailable');
    assert.equal(f.valid, false);
  });
  it('accepts a delayed quote within delay + tolerance while the market is open', () => {
    const f = classifyQuote(q('2026-10-06T13:50:00Z'), tueOpen, 30);
    assert.equal(f.status, 'delayed');
    assert.equal(f.valid, true);
  });
  it('marks a quote stale once older than delay + tolerance during the session', () => {
    const f = classifyQuote(q('2026-10-06T13:15:00Z'), tueOpen, 30);
    assert.equal(f.status, 'stale');
    assert.equal(f.valid, false);
  });
  it('accepts the last quote of the latest session while the market is closed', () => {
    const sat = Date.parse('2026-10-10T16:00:00Z');
    assert.equal(isMarketOpen(sat), false);
    const f = classifyQuote(q('2026-10-09T20:55:00Z'), sat, 30); // Fri 16:55 ET
    assert.equal(f.status, 'closed-last');
    assert.equal(f.valid, true);
    const old = classifyQuote(q('2026-10-08T20:55:00Z'), sat, 30); // Thu
    assert.equal(old.status, 'stale');
  });
  it('rejects timestamps in the future (time-zone mistakes)', () => {
    assert.equal(classifyQuote(q('2026-10-06T15:00:00Z'), tueOpen, 30).status, 'invalid-future');
  });
});

describe('three-week distillate exit logic', () => {
  const obs = (weekEnding: string, levelKb: number | null, extra: Partial<InventoryObs> = {}): InventoryObs => ({
    series: 'distillate',
    weekEnding,
    levelKb,
    changeKb: null,
    kind: 'actual',
    source: 'EIA',
    releasedAt: '2026-10-07T14:30:00.000Z',
    ...extra,
  });
  const fourWeeks = [obs('2026-09-11', 120_000), obs('2026-09-18', 120_500), obs('2026-09-25', 121_000), obs('2026-10-02', 121_800)];

  it('counts consecutive weekly builds from EIA levels', () => {
    const s = consecutiveBuilds(fourWeeks);
    assert.equal(s.streak, 3);
    assert.deepEqual(
      s.weeks.map((w) => w.changeKb),
      [500, 500, 800],
    );
  });
  it('requires strictly positive changes and contiguous weeks', () => {
    assert.equal(consecutiveBuilds([...fourWeeks.slice(0, 3), obs('2026-10-02', 121_000)]).streak, 0); // flat is not a build
    assert.equal(consecutiveBuilds([obs('2026-09-04', 119_000), obs('2026-09-11', 120_000), obs('2026-09-25', 121_000), obs('2026-10-02', 121_800)]).streak, 1); // gap
  });
  it('ignores API survey figures and analyst estimates', () => {
    const withNoise = [...fourWeeks.slice(0, 3), obs('2026-10-02', null, { kind: 'estimate', changeKb: 900 }), obs('2026-10-02', null, { kind: 'api', changeKb: 1200 })];
    assert.equal(consecutiveBuilds(withNoise).streak, 2);
  });
  it('prefers a reported change over level differences', () => {
    const s = consecutiveBuilds([...fourWeeks.slice(0, 3), obs('2026-10-02', 121_800, { changeKb: -100 })]);
    assert.equal(s.streak, 0);
  });
  it('triggers only when the confirming release comes after position entry', () => {
    assert.equal(evaluateDistillateExit(fourWeeks, 3, '2026-10-06T14:00:00Z').met, true);
    assert.equal(evaluateDistillateExit(fourWeeks, 3, '2026-10-08T14:00:00Z').met, false);
    assert.equal(evaluateDistillateExit(fourWeeks.slice(1), 3, '2026-10-06T14:00:00Z').met, false);
  });
});

describe('schedule', () => {
  it('skips the 17:00–18:00 ET maintenance break and weekends for hourly marks', () => {
    const slots = hourlySlotsBetween(Date.parse('2026-10-06T19:30:00Z'), Date.parse('2026-10-06T23:30:00Z'));
    assert.deepEqual(slots, ['2026-10-06T20:00:00.000Z', '2026-10-06T22:00:00.000Z', '2026-10-06T23:00:00.000Z']);
    assert.deepEqual(hourlySlotsBetween(Date.parse('2026-10-10T00:00:00Z'), Date.parse('2026-10-11T21:30:00Z')), []);
  });
  it('defaults the EIA release to Wednesday 10:30 ET and honours overrides', () => {
    const r = nextEiaRelease(Date.parse('2026-10-06T12:00:00Z'))!;
    assert.equal(r.releaseUtc, '2026-10-07T14:30:00.000Z');
    assert.equal(r.weekEnding, '2026-10-02');
    const o = eiaReleaseForWeek('2026-10-14', [{ date: '2026-10-14', releaseDate: '2026-10-15', timeEt: '11:00' }])!;
    assert.equal(o.releaseUtc, '2026-10-15T15:00:00.000Z');
    assert.equal(o.source, 'user-override');
  });
});

describe('neutrality guard', () => {
  it('flags directional or recommendation language', () => {
    assert.ok(findDirectionalLanguage('You should buy the crack here').length > 0);
    assert.ok(findDirectionalLanguage('Looks bullish').length > 0);
    assert.deepEqual(findDirectionalLanguage('Brent M1–M2 moved from 0.95 to 0.82 over 48 hours.'), []);
  });
});
