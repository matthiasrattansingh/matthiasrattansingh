import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { commissionForSide, fillLegs, grossPnl, strategyValue, ulsdBrentCrack, valueForPnl } from '../src/domain/pnl.ts';
import { GALLONS_PER_BARREL, PRODUCTS, toPerBarrel } from '../src/domain/contracts.ts';

const crackLegs = [
  { contract: 'HOX2026', weight: 1 as const },
  { contract: 'BZZ2026', weight: -1 as const },
];

describe('barrel / gallon conversion and contract multipliers', () => {
  it('uses 42 gallons per barrel and 1,000 bbl (42,000 gal) per contract', () => {
    assert.equal(GALLONS_PER_BARREL, 42);
    assert.equal(PRODUCTS.HO.contractSize, 42_000);
    assert.equal(PRODUCTS.HO.barrelsPerContract, 1_000);
    assert.equal(PRODUCTS.BZ.contractSize, 1_000);
    assert.equal(PRODUCTS.BZ.barrelsPerContract, 1_000);
  });
  it('converts HO $/gal to $/bbl and leaves Brent $/bbl unchanged', () => {
    assert.equal(toPerBarrel('HOX2026', 2.5), 105);
    assert.ok(Math.abs(toPerBarrel('HOX2026', 2.3456) - 98.5152) < 1e-9);
    assert.equal(toPerBarrel('BZZ2026', 65.43), 65.43);
  });
  it('one HO contract move of 1 cent/gal is $420', () => {
    // 0.01 $/gal × 42,000 gal = $420 = 0.42 $/bbl × 1,000 bbl
    assert.ok(Math.abs(grossPnl(1, toPerBarrel('HOX2026', 2.5), toPerBarrel('HOX2026', 2.51), 1_000) - 420) < 1e-6);
  });
});

describe('net crack and P/L arithmetic', () => {
  it('net crack = HO × 42 − Brent', () => {
    assert.ok(Math.abs(ulsdBrentCrack(2.5, 15.67) - 89.33) < 1e-9);
    assert.ok(Math.abs(strategyValue(crackLegs, { HOX2026: 2.5, BZZ2026: 15.67 }) - 89.33) < 1e-9);
  });
  it('gross open P/L = (current crack − 87.330) × 5,000', () => {
    assert.ok(Math.abs(grossPnl(1, 87.33, 89.33, 5_000) - 10_000) < 1e-6);
    assert.ok(Math.abs(grossPnl(1, 87.33, 84.33, 5_000) + 15_000) < 1e-6);
    assert.equal(grossPnl(1, 87.33, 87.33, 5_000), 0);
  });
  it('a short spread profits when the spread falls', () => {
    assert.ok(Math.abs(grossPnl(-1, 30, 28.5, 2_000) - 3_000) < 1e-6);
  });
  it('valueForPnl inverts the P/L formula (drawdown trigger level)', () => {
    assert.ok(Math.abs(valueForPnl(1, 87.33, -15_000, 5_000) - 84.33) < 1e-9);
  });
  it('refuses to value a strategy with a missing leg', () => {
    assert.throws(() => strategyValue(crackLegs, { HOX2026: 2.5 }), /Missing price for BZZ2026/);
  });
});

describe('fills, slippage and costs', () => {
  it('fills at the mark when no slippage is configured', () => {
    const { value, fills } = fillLegs(crackLegs, 1, { HOX2026: 2.5, BZZ2026: 15.67 }, 'open', null);
    assert.ok(Math.abs(value - 89.33) < 1e-9);
    assert.deepEqual(
      fills.map((f) => [f.contract, f.side]),
      [
        ['HOX2026', 1],
        ['BZZ2026', -1],
      ],
    );
  });
  it('applies slippage adversely on every leg (open and close)', () => {
    const open = fillLegs(crackLegs, 1, { HOX2026: 2.5, BZZ2026: 15.67 }, 'open', 1);
    // buy HO 1 tick higher (+0.0042 $/bbl), sell BZ 1 tick lower (−0.01 → +0.01 to spread cost)
    assert.ok(Math.abs(open.value - (89.33 + 0.0042 + 0.01)) < 1e-9);
    const close = fillLegs(crackLegs, 1, { HOX2026: 2.5, BZZ2026: 15.67 }, 'close', 1);
    assert.ok(Math.abs(close.value - (89.33 - 0.0042 - 0.01)) < 1e-9);
  });
  it('reports commissions as null (gross before costs) when not configured', () => {
    assert.equal(commissionForSide(2, 5, null), null);
    assert.equal(commissionForSide(2, 5, 2.5), 25);
  });
});
