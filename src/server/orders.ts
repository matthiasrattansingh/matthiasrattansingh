// Simulated order entry: validation, margin check and idempotent submission.
import type { ExitRule, LegDto, OrderDto, OrderPreviewDto, OrderRequestDto } from '../shared/types.ts';
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import { loadSettings } from './settings.ts';
import { valuate, markContract } from './valuation.ts';
import { evaluate, HttpError, iso, orderLabel } from './engine.ts';
import { contractLabel, isContractCode, lastTradingDay, parseContract, PRODUCTS, businessDaysToExpiry } from '../domain/contracts.ts';
import { checkOrderMargin, computeBuyingPower, marginRequirement } from '../domain/risk.ts';
import { etDate, etWallClockToUtc, isMarketOpen, isWeekday, nextSessionOpen, sessionEndUtc, sessionTradeDate } from '../domain/calendar.ts';
import { strategyValue } from '../domain/pnl.ts';
import { describeRule } from './valuation.ts';

interface Normalized {
  legs: LegDto[];
  contracts: number;
  direction: 1 | -1;
}

function normalize(req: OrderRequestDto, reasons: string[]): Normalized | null {
  if (!['crack', 'calendar', 'outright'].includes(req.strategy)) {
    reasons.push('Unknown strategy type.');
    return null;
  }
  if (req.direction !== 'long' && req.direction !== 'short') reasons.push('Direction must be long or short.');
  const rawLegs = Array.isArray(req.legs) ? req.legs : [];
  for (const l of rawLegs) {
    if (!l || typeof l.contract !== 'string' || !isContractCode(l.contract)) {
      reasons.push(`Invalid contract "${l?.contract ?? ''}". Use an exact contract month such as HOX2026.`);
      return null;
    }
  }
  const codes = rawLegs.map((l) => parseContract(l.contract));
  let legs: LegDto[] = [];
  if (req.strategy === 'outright') {
    if (codes.length !== 1) reasons.push('An outright order needs exactly one contract.');
    else legs = [{ contract: codes[0].code, weight: 1 }];
  } else if (req.strategy === 'crack') {
    if (codes.length !== 2) reasons.push('A crack spread needs a refined-product leg and a crude leg.');
    else {
      const product = codes.find((c) => PRODUCTS[c.product].kind === 'product');
      const crude = codes.find((c) => PRODUCTS[c.product].kind === 'crude');
      if (!product || !crude) reasons.push('A crack spread needs one product leg (HO or RB) and one crude leg (BZ or CL).');
      else legs = [{ contract: product.code, weight: 1 }, { contract: crude.code, weight: -1 }];
    }
  } else {
    if (codes.length !== 2) reasons.push('A calendar spread needs two contract months.');
    else if (codes[0].product !== codes[1].product) reasons.push('Calendar spread legs must be the same product.');
    else if (codes[0].code === codes[1].code) reasons.push('Calendar spread legs must be different months.');
    else {
      const [near, far] = [...codes].sort((a, b) => lastTradingDay(a.code).localeCompare(lastTradingDay(b.code)));
      legs = [{ contract: near.code, weight: 1 }, { contract: far.code, weight: -1 }];
    }
  }
  const q = req.quantity ?? {};
  let contracts = NaN;
  if (q.contracts !== undefined && q.contracts !== null) {
    contracts = Number(q.contracts);
    if (!Number.isInteger(contracts) || contracts < 1) reasons.push('Contracts must be a whole number ≥ 1.');
  } else if (q.barrels !== undefined && q.barrels !== null) {
    const bbl = Number(q.barrels);
    if (!(bbl > 0) || bbl % 1000 !== 0) reasons.push('Barrels must be a positive multiple of 1,000 (futures trade in whole contracts of 1,000 bbl / 42,000 gal).');
    contracts = bbl / 1000;
  } else reasons.push('Enter a size in contracts or barrels.');
  if (Number.isFinite(contracts) && contracts > 200) reasons.push('Size above 200 contracts per leg is outside this simulator’s limits.');
  if (!legs.length || !Number.isFinite(contracts)) return null;
  return { legs, contracts, direction: req.direction === 'short' ? -1 : 1 };
}

function validateExitRules(rules: ExitRule[], reasons: string[]): void {
  if (!Array.isArray(rules)) {
    reasons.push('Exit rules must be a list.');
    return;
  }
  for (const r of rules) {
    switch (r?.type) {
      case 'stop_value':
      case 'target_value':
        if (!Number.isFinite(Number(r.level))) reasons.push(`${r.type === 'stop_value' ? 'Stop' : 'Target'} level must be a number ($/bbl).`);
        break;
      case 'max_loss_usd':
        if (!(Number(r.amount) > 0)) reasons.push('Max-loss amount must be > 0.');
        break;
      case 'eia_distillate_builds':
        if (!Number.isInteger(r.weeks) || r.weeks < 1 || r.weeks > 10) reasons.push('EIA build rule needs 1–10 weeks.');
        break;
      case 'close_on_date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || !/^\d{2}:\d{2}$/.test(r.timeEt)) reasons.push('Time exit needs a date (YYYY-MM-DD) and ET time (HH:MM).');
        break;
      default:
        reasons.push('Unknown exit rule type.');
    }
  }
}

export function previewOrder(db: Db, req: OrderRequestDto, nowMs: number): { preview: OrderPreviewDto; normalized: Normalized | null } {
  const settings = loadSettings(db);
  const reasons: string[] = [];
  const warnings: string[] = [];
  const today = etDate(nowMs);
  const account = repo.currentAccount(db);

  const normalized = normalize(req, reasons);
  validateExitRules(req.exitRules ?? [], reasons);
  if (!req.rationale || req.rationale.trim().length < 10) reasons.push('Add a rationale (at least 10 characters).');
  if (!req.exitRuleText || req.exitRuleText.trim().length < 5) reasons.push('Describe the exit/stop rule.');
  if (req.entryMethod !== 'market' && req.entryMethod !== 'limit') reasons.push('Entry method must be market or limit.');
  if (req.entryMethod === 'limit' && !Number.isFinite(Number(req.limitValue))) reasons.push('Limit orders need a limit value ($/bbl for spreads; strategy value in $/bbl).');
  if (req.timeInForce !== 'day' && req.timeInForce !== 'gtc') reasons.push('Time in force must be day or GTC.');

  if (!isWeekday(today)) reasons.push('New simulated trades are accepted Monday–Friday (ET).');
  const tradesToday = repo.tradesOnDate(db, account.id, today);
  if (settings.dailyTradeLimit > 0 && tradesToday >= settings.dailyTradeLimit) {
    reasons.push(`Daily limit reached: ${tradesToday} trade(s) already submitted today (limit ${settings.dailyTradeLimit}; change in Settings).`);
  }
  if (account.status === 'halted') reasons.push(`Trading halted: ${account.halted_reason ?? 'account halted'}. Start a new paper account in Settings to continue.`);
  if (req.entryMethod === 'market' && !isMarketOpen(nowMs)) {
    reasons.push(`NYMEX is closed now (weekend, holiday or 17:00–18:00 ET maintenance break). Market orders need an open session — next open ${nextSessionOpen(nowMs)}.`);
  }

  let currentValue: number | null = null;
  let currentValueValid = false;
  let notional = 0;
  const legSummaries: OrderPreviewDto['summary']['legs'] = [];
  if (normalized) {
    const prices: Record<string, number> = {};
    let allValid = true;
    for (const leg of normalized.legs) {
      const m = markContract(db, leg.contract, nowMs, settings);
      const ltd = lastTradingDay(leg.contract);
      if (ltd < today) reasons.push(`${leg.contract} expired (computed last trading day ${ltd}).`);
      else {
        const bd = businessDaysToExpiry(leg.contract, today);
        if (settings.expiryGuardEnabled && nowMs >= Date.parse(etWallClockToUtc(ltd, settings.expiryGuardTimeEt))) {
          reasons.push(`${leg.contract} is inside the expiry-guard window (last trading day ${ltd}).`);
        } else if (bd <= 5) warnings.push(`${leg.contract} has ${bd} business day(s) to its computed last trading day (${ltd}); the expiry guard closes positions at ${settings.expiryGuardTimeEt} ET that day.`);
      }
      if (m.quote) {
        prices[leg.contract] = m.quote.price;
        notional += Math.abs(m.quote.price * PRODUCTS[parseContract(leg.contract).product].contractSize * normalized.contracts);
      }
      if (!m.freshness.valid) allValid = false;
      const side = normalized.direction * leg.weight === 1 ? 'buy' : 'sell';
      legSummaries.push({ contract: leg.contract, label: contractLabel(leg.contract), side, contracts: normalized.contracts, barrels: normalized.contracts * 1000 });
    }
    try {
      currentValue = strategyValue(normalized.legs, prices);
      currentValueValid = allValid;
    } catch {
      currentValue = null;
    }
    if (!currentValueValid) {
      warnings.push(
        currentValue === null
          ? 'No quote yet for at least one leg; the order can only fill once valid marks exist for every leg.'
          : 'At least one leg quote is stale; the order will wait for valid marks.',
      );
    }
    if (settings.fillPolicy === 'next_mark_after_submit') {
      warnings.push('Fill policy: fills at the first valid mark whose exchange time is at or after submission (prevents filling on delayed prices you have already seen).');
    }
  }

  let margin: OrderPreviewDto['margin'] = null;
  if (normalized) {
    const v = valuate(db, nowMs, settings);
    const margins = repo.marginMap(db);
    const required = marginRequirement(normalized.legs, normalized.contracts, margins, today, settings.marginMaxAgeDays);
    const reservations = [...v.positions.map((p) => p.margin!), ...v.orderMargins.values()];
    const bp = computeBuyingPower(v.equity, v.equityValid, reservations, v.accountDto.equityReasons);
    margin = checkOrderMargin(bp, required);
    if (!margin.ok) reasons.push(...margin.reasons);
  }

  const dirWord = req.direction === 'short' ? 'Short' : 'Long';
  const preview: OrderPreviewDto = {
    ok: reasons.length === 0,
    reasons,
    warnings,
    summary: {
      direction: dirWord,
      label: normalized ? orderLabel({ request: { ...req, legs: normalized.legs } }) : '—',
      legs: legSummaries,
      contractsPerLeg: normalized?.contracts ?? 0,
      barrels: (normalized?.contracts ?? 0) * 1000,
      entryMethod:
        req.entryMethod === 'limit'
          ? `Limit ${Number(req.limitValue).toFixed(3)} $/bbl (${req.timeInForce === 'gtc' ? 'GTC' : 'day'})`
          : `Market — next valid mark (${req.timeInForce === 'gtc' ? 'GTC' : 'day'})`,
      exitRuleText: req.exitRuleText ?? '',
      exitRules: (req.exitRules ?? []).map((r) => {
        try {
          return describeRule(r);
        } catch {
          return 'Invalid rule';
        }
      }),
      valueFormula: normalized ? repo.valueFormula(req.strategy, normalized.legs) : '',
      currentValue,
      currentValueValid,
      notionalNote: notional
        ? `Approximate notional ≈ $${Math.round(notional).toLocaleString('en-US')} (sum of legs). Notional is not margin and is not used for the margin check.`
        : 'Notional unavailable (no quotes).',
    },
    margin,
    tradesToday,
    dailyLimit: settings.dailyTradeLimit,
  };
  return { preview, normalized };
}

export function submitOrder(db: Db, req: OrderRequestDto, nowMs: number): { order: OrderDto; duplicate: boolean; preview: OrderPreviewDto | null } {
  if (!req || typeof req.idempotencyKey !== 'string' || req.idempotencyKey.length < 8 || req.idempotencyKey.length > 100) {
    throw new HttpError(400, 'idempotencyKey (8–100 chars) is required so retries cannot create duplicate trades.');
  }
  return db.tx(() => {
    const existing = repo.orderByKey(db, req.idempotencyKey);
    if (existing) return { order: existing, duplicate: true, preview: null };
    const { preview, normalized } = previewOrder(db, req, nowMs);
    const nowIso = iso(nowMs);
    const account = repo.currentAccount(db);
    const status = preview.ok ? 'working' : 'rejected';
    let expiresAt: string | null = null;
    if (preview.ok && req.timeInForce === 'day') {
      const td = sessionTradeDate(nowMs) ?? sessionTradeDate(nextSessionOpen(nowMs));
      expiresAt = td ? sessionEndUtc(td) : null;
    }
    const stored: OrderRequestDto = { ...req, legs: normalized?.legs ?? req.legs };
    const id = db.run(
      `INSERT INTO orders (account_id, idempotency_key, submitted_at, trade_date, status, request_json, reasons_json, margin_json, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      account.id,
      req.idempotencyKey,
      nowIso,
      etDate(nowMs),
      status,
      JSON.stringify(stored),
      JSON.stringify(preview.reasons),
      preview.margin ? JSON.stringify(preview.margin) : null,
      expiresAt,
      nowIso,
    ).lastInsertRowid;
    repo.addEvent(db, {
      accountId: account.id,
      ts: nowIso,
      type: status === 'working' ? 'order.accepted' : 'order.rejected',
      summary:
        status === 'working'
          ? `Order #${id} accepted (simulated): ${preview.summary.label}, ${preview.summary.entryMethod}. Rationale: ${req.rationale.trim()}`
          : `Order rejected: ${preview.summary.label}. ${preview.reasons.join(' ')}`,
      detail: { orderId: id, request: stored, margin: preview.margin, warnings: preview.warnings, reasons: preview.reasons },
      dedupeKey: `order:${req.idempotencyKey}`,
    });
    if (status === 'working') evaluate(db, nowMs, 'order-submit');
    return { order: repo.orderById(db, id)!, duplicate: false, preview };
  });
}

export function recordPass(db: Db, note: string, nowMs: number): { recorded: boolean } {
  const account = repo.currentAccount(db);
  const today = etDate(nowMs);
  const recorded = repo.addEvent(db, {
    accountId: account.id,
    ts: iso(nowMs),
    type: 'decision.pass',
    summary: `No new trade today (${today}).${note ? ` Note: ${note}` : ''}`,
    detail: { note },
    dedupeKey: `pass:${account.id}:${today}`,
  });
  return { recorded };
}
