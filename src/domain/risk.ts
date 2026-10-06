// Account risk rules: peak-to-current drawdown, initial margin and buying power.
//
// Margin is never inferred. A figure is usable only if the user entered it with a source and
// an as-of date that is not older than the configured maximum age. Notional value is never
// treated as margin.
import { addDays, type IsoDate } from './calendar.ts';
import type { StrategyLeg } from './pnl.ts';

export interface MarginFigure {
  /** Contract code (e.g. HOX2026) or spread key (see spreadMarginKey). */
  key: string;
  perUnitUsd: number; // per contract, or per spread unit (one contract on each leg)
  source: string;
  asOfDate: IsoDate;
  enteredAt: string;
  note?: string | null;
}

export interface MarginRequirement {
  known: boolean;
  amount: number | null;
  basis: 'spread' | 'sum-of-legs' | 'unknown';
  figures: MarginFigure[];
  missing: string[];
  stale: string[];
  explanation: string;
}

export function spreadMarginKey(legs: StrategyLeg[]): string {
  return `SPREAD:${legs.map((l) => l.contract).sort().join('+')}`;
}

export function isMarginFigureFresh(f: MarginFigure, asOf: IsoDate, maxAgeDays: number): boolean {
  return f.asOfDate >= addDays(asOf, -maxAgeDays) && f.asOfDate <= asOf;
}

export function marginRequirement(
  legs: StrategyLeg[],
  contractsPerLeg: number,
  figures: Map<string, MarginFigure>,
  asOf: IsoDate,
  maxAgeDays: number,
): MarginRequirement {
  if (legs.length > 1) {
    const spread = figures.get(spreadMarginKey(legs));
    if (spread && spread.perUnitUsd > 0 && isMarginFigureFresh(spread, asOf, maxAgeDays)) {
      return {
        known: true,
        amount: spread.perUnitUsd * contractsPerLeg,
        basis: 'spread',
        figures: [spread],
        missing: [],
        stale: [],
        explanation: `Spread margin ${fmtUsd(spread.perUnitUsd)} per spread unit × ${contractsPerLeg} (source: ${spread.source}, as of ${spread.asOfDate}).`,
      };
    }
  }
  const used: MarginFigure[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  let amount = 0;
  for (const leg of legs) {
    const f = figures.get(leg.contract);
    if (!f || !(f.perUnitUsd > 0)) {
      missing.push(leg.contract);
      continue;
    }
    if (!isMarginFigureFresh(f, asOf, maxAgeDays)) {
      stale.push(leg.contract);
      continue;
    }
    used.push(f);
    amount += f.perUnitUsd * contractsPerLeg;
  }
  if (missing.length || stale.length) {
    const parts: string[] = [];
    if (missing.length) parts.push(`no verified initial margin configured for ${missing.join(', ')}`);
    if (stale.length) parts.push(`margin figure older than ${maxAgeDays} days (or dated in the future) for ${stale.join(', ')}`);
    return {
      known: false,
      amount: null,
      basis: 'unknown',
      figures: used,
      missing,
      stale,
      explanation: `Margin unknown: ${parts.join('; ')}. Enter the exchange/broker initial margin with its source and date in Settings → Margin.`,
    };
  }
  return {
    known: true,
    amount,
    basis: 'sum-of-legs',
    figures: used,
    missing: [],
    stale: [],
    explanation:
      legs.length > 1
        ? `Sum of outright leg margins (no spread-credit figure configured): ${used.map((f) => `${f.key} ${fmtUsd(f.perUnitUsd)}/contract`).join(' + ')} × ${contractsPerLeg}.`
        : `${used[0].key} ${fmtUsd(used[0].perUnitUsd)}/contract × ${contractsPerLeg} (source: ${used[0].source}, as of ${used[0].asOfDate}).`,
  };
}

export interface BuyingPower {
  equity: number;
  equityValid: boolean;
  reservedMargin: number | null;
  reservedKnown: boolean;
  buyingPower: number | null;
  verified: boolean;
  reasons: string[];
}

export function computeBuyingPower(equity: number, equityValid: boolean, reservations: MarginRequirement[], equityReasons: string[] = []): BuyingPower {
  const reasons: string[] = [];
  const unknown = reservations.filter((r) => !r.known);
  const reservedKnown = unknown.length === 0;
  const reservedMargin = reservedKnown ? reservations.reduce((s, r) => s + (r.amount ?? 0), 0) : null;
  if (!equityValid) reasons.push(`Equity is provisional (${equityReasons.join('; ') || 'missing or stale marks'}).`);
  if (!reservedKnown) reasons.push(...unknown.map((r) => `Reserved margin unknown for an open position or working order: ${r.explanation}`));
  const verified = equityValid && reservedKnown;
  return {
    equity,
    equityValid,
    reservedMargin,
    reservedKnown,
    buyingPower: reservedMargin === null ? null : equity - reservedMargin,
    verified,
    reasons,
  };
}

export interface MarginCheck {
  ok: boolean;
  reasons: string[];
  required: MarginRequirement;
  before: BuyingPower;
  buyingPowerAfter: number | null;
  reservedAfter: number | null;
}

export function checkOrderMargin(bp: BuyingPower, required: MarginRequirement): MarginCheck {
  const reasons: string[] = [];
  if (!required.known) reasons.push(required.explanation);
  if (!bp.verified) reasons.push(...bp.reasons);
  const reservedAfter = bp.reservedMargin !== null && required.amount !== null ? bp.reservedMargin + required.amount : null;
  const buyingPowerAfter = bp.buyingPower !== null && required.amount !== null ? bp.buyingPower - required.amount : null;
  if (!reasons.length && required.amount !== null && bp.buyingPower !== null && required.amount > bp.buyingPower) {
    reasons.push(`Required initial margin ${fmtUsd(required.amount)} exceeds buying power ${fmtUsd(bp.buyingPower)}.`);
  }
  return { ok: reasons.length === 0, reasons, required, before: bp, buyingPowerAfter, reservedAfter };
}

// ---------------------------------------------------------------------------
// Drawdown
// ---------------------------------------------------------------------------

export function drawdownFraction(peakEquity: number, equity: number): number {
  if (peakEquity <= 0) return 0;
  return Math.max(0, (peakEquity - equity) / peakEquity);
}

export function drawdownFloor(peakEquity: number, maxDrawdownPct: number): number {
  return peakEquity * (1 - maxDrawdownPct / 100);
}

/** True when marked equity reaches or breaches the drawdown limit (compared in cents). */
export function isDrawdownBreached(peakEquity: number, equity: number, maxDrawdownPct: number): boolean {
  return Math.round(equity * 100) <= Math.round(drawdownFloor(peakEquity, maxDrawdownPct) * 100);
}

export function fmtUsd(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
