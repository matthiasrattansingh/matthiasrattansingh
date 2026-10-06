// Quote ingestion: manual entry (including values transcribed from a TradingView chart/widget)
// and provider fetches. Every quote is stored against an exact contract with its displayed
// exchange time, the local observation time, its source and declared delay.
import { DateTime } from 'luxon';
import type { ProviderId } from '../shared/types.ts';
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import { evaluate, HttpError, iso, type EvaluateResult } from './engine.ts';
import { isContractCode, parseContract, PRODUCTS } from '../domain/contracts.ts';
import { FUTURE_TOLERANCE_MS } from '../domain/freshness.ts';

export interface ManualQuoteInput {
  contract: string;
  price: number;
  exchangeTime: string; // wall-clock "YYYY-MM-DDTHH:mm[:ss]" in exchangeTimeZone, or a full ISO instant with offset
  exchangeTimeZone?: string; // IANA; default America/New_York
  source: string;
  delayMinutes?: number | null;
  basis?: string | null;
  note?: string | null;
}

export interface QuoteIssue {
  contract: string;
  code: 'invalid' | 'confirm_large_move';
  message: string;
}

const LARGE_MOVE_FRACTION = 0.05;

export function parseExchangeTime(value: string, zone: string): string {
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(value.trim());
  const dt = hasOffset ? DateTime.fromISO(value.trim(), { setZone: true }) : DateTime.fromISO(value.trim(), { zone });
  if (!dt.isValid) throw new Error(`Unreadable exchange timestamp "${value}" (${dt.invalidExplanation ?? dt.invalidReason}).`);
  return dt.toUTC().toISO() as string;
}

export function validateQuoteValue(contract: string, price: number): string | null {
  if (!isContractCode(contract)) return `"${contract}" is not an exact contract code (e.g. HOX2026). Continuous or front-month symbols are not accepted.`;
  const spec = PRODUCTS[parseContract(contract).product];
  if (!Number.isFinite(price) || price <= 0) return `${contract}: price must be a positive number.`;
  const [lo, hi] = spec.sanityRange;
  if (price < lo || price > hi) {
    const hint = spec.unit === '$/gal' && price > hi ? ` ${spec.code} is quoted in $/gal — did you enter $/bbl? ($/bbl ÷ 42 = ${(price / 42).toFixed(4)} $/gal)` : '';
    return `${contract}: ${price} ${spec.unit} is outside the plausible range ${lo}–${hi} ${spec.unit}.${hint}`;
  }
  return null;
}

class DryRunRollback extends Error {
  result: unknown;
  constructor(result: unknown) {
    super('dry-run');
    this.result = result;
  }
}

export interface ManualEntryResult {
  inserted: number;
  duplicates: number;
  issues: QuoteIssue[];
  evaluation: EvaluateResult | null;
  dryRun: boolean;
  impact: {
    positions: { id: number; label: string; value: number | null; unrealized: number | null; valid: boolean }[];
    equity: number;
    equityValid: boolean;
    drawdownPct: number;
    actions: { type: string; summary: string }[];
  } | null;
}

export function enterManualQuotes(db: Db, inputs: ManualQuoteInput[], nowMs: number, opts: { dryRun?: boolean; confirmLargeMoves?: boolean } = {}): ManualEntryResult {
  if (!Array.isArray(inputs) || !inputs.length) throw new HttpError(400, 'Provide at least one quote.');
  const issues: QuoteIssue[] = [];
  const prepared: repo.NewQuote[] = [];
  const observedAt = iso(nowMs);
  for (const q of inputs) {
    const contract = String(q.contract ?? '').trim().toUpperCase();
    const price = Number(q.price);
    const err = validateQuoteValue(contract, price);
    if (err) {
      issues.push({ contract, code: 'invalid', message: err });
      continue;
    }
    if (!q.source || !String(q.source).trim()) {
      issues.push({ contract, code: 'invalid', message: `${contract}: source is required (e.g. "TradingView chart (transcribed)").` });
      continue;
    }
    let exchangeTs: string;
    try {
      exchangeTs = parseExchangeTime(String(q.exchangeTime ?? ''), q.exchangeTimeZone || 'America/New_York');
    } catch (e) {
      issues.push({ contract, code: 'invalid', message: `${contract}: ${(e as Error).message}` });
      continue;
    }
    const exMs = Date.parse(exchangeTs);
    if (exMs - nowMs > FUTURE_TOLERANCE_MS) {
      issues.push({ contract, code: 'invalid', message: `${contract}: exchange time ${exchangeTs} is in the future — check the time zone.` });
      continue;
    }
    if (nowMs - exMs > 30 * 24 * 3600_000) {
      issues.push({ contract, code: 'invalid', message: `${contract}: exchange time is more than 30 days old.` });
      continue;
    }
    const prev = repo.latestQuote(db, contract);
    if (prev && !opts.confirmLargeMoves && Math.abs(price - prev.price) / prev.price > LARGE_MOVE_FRACTION) {
      issues.push({
        contract,
        code: 'confirm_large_move',
        message: `${contract}: ${price} differs from the previous quote ${prev.price} by ${((Math.abs(price - prev.price) / prev.price) * 100).toFixed(1)}%. Confirm to save.`,
      });
      continue;
    }
    const delay = q.delayMinutes === null || q.delayMinutes === undefined || (q.delayMinutes as unknown) === '' ? null : Number(q.delayMinutes);
    prepared.push({
      contract,
      price,
      source: String(q.source).trim(),
      sourceKind: 'manual',
      provider: 'manual',
      providerSymbol: null,
      delayMinutes: delay !== null && Number.isFinite(delay) ? delay : null,
      exchangeTs,
      observedAt,
      basis: q.basis ?? 'manually entered (transcribed)',
      note: q.note ?? null,
    });
  }
  if (issues.length) return { inserted: 0, duplicates: 0, issues, evaluation: null, dryRun: !!opts.dryRun, impact: null };

  const run = (): ManualEntryResult => {
    let inserted = 0;
    let duplicates = 0;
    for (const q of prepared) {
      const r = repo.insertQuote(db, q);
      if (r.inserted) inserted++;
      else duplicates++;
    }
    if (inserted) {
      repo.addEvent(db, {
        accountId: repo.currentAccount(db).id,
        ts: observedAt,
        type: 'quote.manual',
        summary: `Manual quote entry: ${prepared.map((q) => `${q.contract} ${q.price} @ ${q.exchangeTs} (${q.source})`).join('; ')}`,
        detail: prepared,
      });
    }
    const evaluation = evaluate(db, nowMs, 'manual-quote');
    const v = evaluation.valuation;
    return {
      inserted,
      duplicates,
      issues: [],
      evaluation: opts.dryRun ? null : evaluation,
      dryRun: !!opts.dryRun,
      impact: {
        positions: v.positions.map((p) => ({ id: p.id, label: p.label, value: p.mark?.value ?? null, unrealized: p.mark?.unrealized ?? null, valid: p.mark?.valid ?? false })),
        equity: v.equity,
        equityValid: v.equityValid,
        drawdownPct: v.accountDto.drawdownPct,
        actions: evaluation.actions,
      },
    };
  };

  if (!opts.dryRun) return db.tx(run);
  try {
    db.tx(() => {
      throw new DryRunRollback(run());
    });
  } catch (e) {
    if (e instanceof DryRunRollback) return e.result as ManualEntryResult;
    throw e;
  }
  throw new Error('unreachable');
}

export interface ProviderQuote {
  contract: string;
  price: number;
  exchangeTs: string;
  providerSymbol: string;
  source: string;
  delayMinutes: number | null;
  basis: string;
}

export function ingestProviderQuotes(db: Db, provider: ProviderId, quotes: ProviderQuote[], nowMs: number): { inserted: number; rejected: string[] } {
  const rejected: string[] = [];
  let inserted = 0;
  const observedAt = iso(nowMs);
  db.tx(() => {
    for (const q of quotes) {
      const err = validateQuoteValue(q.contract, q.price);
      if (err) {
        rejected.push(err);
        continue;
      }
      if (Date.parse(q.exchangeTs) - nowMs > FUTURE_TOLERANCE_MS) {
        rejected.push(`${q.contract}: provider timestamp ${q.exchangeTs} is in the future; ignored.`);
        continue;
      }
      const r = repo.insertQuote(db, {
        contract: q.contract,
        price: q.price,
        source: q.source,
        sourceKind: 'api',
        provider,
        providerSymbol: q.providerSymbol,
        delayMinutes: q.delayMinutes,
        exchangeTs: q.exchangeTs,
        observedAt,
        basis: q.basis,
        note: null,
      });
      if (r.inserted) inserted++;
    }
  });
  return { inserted, rejected };
}
