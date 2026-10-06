// Spread valuation and P/L arithmetic.
//
// All strategy values are expressed in $/bbl so that crack spreads, calendar spreads and
// outrights share one formula:
//
//   value ($/bbl) = Σ_legs weight × native price × toBarrelFactor
//   gross P/L ($) = direction × (current value − entry value) × barrels
//
// For the ULSD-vs-Brent crack: value = HO ($/gal) × 42 − BZ ($/bbl), and with 5 contracts
// per leg (5 × 1,000 bbl) gross P/L = (net crack − entry) × 5,000.
import { productOf, roundToTick } from './contracts.ts';

export type Direction = 1 | -1; // +1 long the strategy, -1 short the strategy
export type Weight = 1 | -1; // leg sign inside the strategy definition

export interface StrategyLeg {
  contract: string;
  weight: Weight;
}

export interface LegFill {
  contract: string;
  /** +1 = bought, -1 = sold (effective side after applying strategy direction). */
  side: 1 | -1;
  price: number; // native units
  markPrice: number; // native mark before slippage
}

export function barrelsFor(legs: StrategyLeg[], contractsPerLeg: number): number {
  // All supported strategies trade equal barrels on every leg (1,000 bbl per contract).
  const bpc = productOf(legs[0].contract).barrelsPerContract;
  return contractsPerLeg * bpc;
}

/** Strategy value in $/bbl from native leg prices. Throws if any leg price is missing. */
export function strategyValue(legs: StrategyLeg[], prices: Record<string, number | undefined>): number {
  let total = 0;
  for (const leg of legs) {
    const p = prices[leg.contract];
    if (p === undefined || !Number.isFinite(p)) throw new Error(`Missing price for ${leg.contract}`);
    total += leg.weight * p * productOf(leg.contract).toBarrelFactor;
  }
  return total;
}

/** NY Harbor ULSD crack vs Brent in $/bbl: HO ($/gal) × 42 − Brent ($/bbl). */
export function ulsdBrentCrack(hoPerGallon: number, brentPerBarrel: number): number {
  return hoPerGallon * 42 - brentPerBarrel;
}

export function grossPnl(direction: Direction, entryValue: number, currentValue: number, barrels: number): number {
  return direction * (currentValue - entryValue) * barrels;
}

/** Strategy value change that would produce `pnl` dollars. */
export function valueForPnl(direction: Direction, entryValue: number, pnl: number, barrels: number): number {
  return entryValue + pnl / (direction * barrels);
}

/**
 * Fill each leg at its mark, moved adversely by `slippageTicks` ticks when slippage is configured.
 * `action` = 'open' trades in the strategy direction, 'close' trades against it.
 */
export function fillLegs(
  legs: StrategyLeg[],
  direction: Direction,
  marks: Record<string, number>,
  action: 'open' | 'close',
  slippageTicks: number | null,
): { fills: LegFill[]; value: number } {
  const fills: LegFill[] = legs.map((leg) => {
    const mark = marks[leg.contract];
    if (mark === undefined) throw new Error(`Missing mark for ${leg.contract}`);
    const sideOpen = (direction * leg.weight) as 1 | -1;
    const side = (action === 'open' ? sideOpen : -sideOpen) as 1 | -1;
    const ticks = slippageTicks ?? 0;
    const tick = productOf(leg.contract).tickSize;
    const price = ticks ? roundToTick(leg.contract, mark + side * ticks * tick) : mark;
    return { contract: leg.contract, side, price, markPrice: mark };
  });
  const prices: Record<string, number> = {};
  for (const f of fills) prices[f.contract] = f.price;
  return { fills, value: strategyValue(legs, prices) };
}

/** Commission for one side (entry or exit) across all legs. Null when not configured. */
export function commissionForSide(legCount: number, contractsPerLeg: number, perContractPerSide: number | null): number | null {
  if (perContractPerSide === null || perContractPerSide === undefined) return null;
  return legCount * contractsPerLeg * perContractPerSide;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
