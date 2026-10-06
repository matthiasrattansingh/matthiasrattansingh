// Mark-to-market valuation of the paper account.
import type { AccountDto, ContractMarkDto, ExitRule, OrderDto, PositionDto, PositionMarkDto } from '../shared/types.ts';
import type { AppSettings } from '../shared/types.ts';
import type { Db } from './db.ts';
import { classifyQuote } from '../domain/freshness.ts';
import { activeContracts, businessDaysToExpiry, contractLabel, lastTradingDay, parseContract, PRODUCTS, type ProductCode } from '../domain/contracts.ts';
import { etDate, sessionTradeDate } from '../domain/calendar.ts';
import { grossPnl, strategyValue, valueForPnl } from '../domain/pnl.ts';
import {
  computeBuyingPower,
  drawdownFloor,
  drawdownFraction,
  isDrawdownBreached,
  marginRequirement,
  type MarginRequirement,
} from '../domain/risk.ts';
import { consecutiveBuilds } from '../domain/inventory.ts';
import * as repo from './repo.ts';
import { loadSettings } from './settings.ts';

export function markContract(db: Db, contract: string, nowMs: number, settings: AppSettings, role?: string): ContractMarkDto {
  const c = parseContract(contract);
  const quote = repo.latestQuote(db, c.code);
  const asOf = etDate(nowMs);
  return {
    contract: c.code,
    label: contractLabel(c.code),
    product: c.product,
    unit: PRODUCTS[c.product].unit,
    role,
    lastTradingDay: lastTradingDay(c.code),
    businessDaysToExpiry: businessDaysToExpiry(c.code, asOf),
    quote,
    freshness: classifyQuote(quote, nowMs, settings.staleToleranceMinutes),
  };
}

/** Contracts shown in the market snapshot, resolved explicitly by expiry rule (never a continuous alias). */
export function snapshotContracts(nowMs: number): { contract: string; role: string }[] {
  const asOf = etDate(nowMs);
  const out: { contract: string; role: string }[] = [];
  const add = (p: ProductCode, n: number) => {
    activeContracts(p, asOf, n).forEach((code, i) => out.push({ contract: code, role: `${PRODUCTS[p].shortName} M${i + 1}` }));
  };
  add('BZ', 2);
  add('HO', 2);
  add('CL', 2);
  add('RB', 1);
  return out;
}

export function markPosition(db: Db, pos: PositionDto, nowMs: number, settings: AppSettings, cache: Map<string, ContractMarkDto>): PositionMarkDto {
  const legs = pos.legs.map((l) => {
    let m = cache.get(l.contract);
    if (!m) {
      m = markContract(db, l.contract, nowMs, settings);
      cache.set(l.contract, m);
    }
    return m;
  });
  const missing: string[] = [];
  for (const m of legs) {
    if (!m.freshness.valid) missing.push(`${m.contract}: ${m.freshness.status} — ${m.freshness.reason}`);
  }
  const valid = missing.length === 0;
  const prices: Record<string, number | undefined> = {};
  for (const m of legs) if (m.quote) prices[m.contract] = m.quote.price;
  let value: number | null = null;
  try {
    value = strategyValue(pos.legs, prices);
  } catch {
    value = null;
  }
  const unrealized = value === null ? null : grossPnl(pos.direction, pos.entryValue, value, pos.barrels);
  return { valid, provisional: !valid, value, unrealized, missing, legs };
}

export interface Valuation {
  nowMs: number;
  settings: AppSettings;
  account: repo.AccountRow;
  positions: PositionDto[]; // open + exit_pending, with mark/margin populated
  workingOrders: OrderDto[];
  orderMargins: Map<number, MarginRequirement>;
  contractCache: Map<string, ContractMarkDto>;
  realizedGross: number;
  fees: number;
  equityValid: boolean;
  equity: number;
  accountDto: AccountDto;
}

export function orderLegsAndContracts(o: OrderDto): { legs: PositionDto['legs']; contracts: number } {
  const contracts = o.request.quantity.contracts ?? Math.round((o.request.quantity.barrels ?? 0) / 1000);
  return { legs: o.request.legs, contracts };
}

export function valuate(db: Db, nowMs: number, settings: AppSettings = loadSettings(db)): Valuation {
  const account = repo.currentAccount(db);
  const asOf = etDate(nowMs);
  const margins = repo.marginMap(db);
  const cache = new Map<string, ContractMarkDto>();
  const positions = repo.openPositions(db, account.id);
  const totals = db.get<{ realized: number; fees: number }>(
    `SELECT COALESCE(SUM(CASE WHEN status = 'closed' THEN realized_gross ELSE 0 END), 0) AS realized,
            COALESCE(SUM(COALESCE(entry_commission, 0) + COALESCE(exit_commission, 0)), 0) AS fees
     FROM positions WHERE account_id = ?`,
    account.id,
  )!;
  const realizedGross = Number(totals.realized);
  const fees = Number(totals.fees);

  const equityReasons: string[] = [];
  let unrealizedAll = 0;
  let allValid = true;
  for (const p of positions) {
    p.mark = markPosition(db, p, nowMs, settings, cache);
    p.margin = marginRequirement(p.legs, p.contractsPerLeg, margins, asOf, settings.marginMaxAgeDays);
    if (!p.mark.valid) {
      allValid = false;
      equityReasons.push(...p.mark.missing.map((m) => `#${p.id} ${m}`));
    }
    if (p.mark.unrealized !== null) unrealizedAll += p.mark.unrealized;
    else equityReasons.push(`#${p.id}: unrealized P/L excluded (no price for at least one leg)`);
  }
  const base = account.starting_equity + realizedGross - fees;
  const equity = base + unrealizedAll;

  const workingOrders = repo.workingOrders(db, account.id);
  const orderMargins = new Map<number, MarginRequirement>();
  for (const o of workingOrders) {
    const { legs, contracts } = orderLegsAndContracts(o);
    orderMargins.set(o.id, marginRequirement(legs, contracts, margins, asOf, settings.marginMaxAgeDays));
  }
  const reservations = [...positions.map((p) => p.margin!), ...orderMargins.values()];
  const bp = computeBuyingPower(equity, allValid, reservations, equityReasons);

  const peak = Math.max(account.peak_equity, allValid ? equity : account.peak_equity);
  const floor = drawdownFloor(peak, settings.maxDrawdownPct);
  for (const p of positions) {
    const others = unrealizedAll - (p.mark!.unrealized ?? 0);
    p.drawdownTriggerValue = valueForPnl(p.direction, p.entryValue, floor - (base + others), p.barrels);
    p.ruleStatus = describeRules(db, p);
  }

  const accountDto: AccountDto = {
    id: account.id,
    createdAt: account.created_at,
    startingEquity: account.starting_equity,
    status: account.status,
    haltedAt: account.halted_at,
    haltedReason: account.halted_reason,
    peakEquity: peak,
    peakAt: account.peak_at,
    realizedGross,
    fees,
    unrealized: allValid ? unrealizedAll : null,
    unrealizedProvisional: allValid ? null : unrealizedAll,
    equity,
    equityValid: allValid,
    equityReasons,
    totalPnl: equity - account.starting_equity,
    drawdownPct: drawdownFraction(peak, equity) * 100,
    maxDrawdownPct: settings.maxDrawdownPct,
    drawdownFloorEquity: floor,
    distanceToLimitUsd: equity - floor,
    provisionalBreach: !allValid && positions.length > 0 && isDrawdownBreached(peak, equity, settings.maxDrawdownPct),
    buyingPower: bp,
    costsConfigured: settings.commissionPerContractPerSide !== null || settings.slippageTicksPerLeg !== null,
  };

  return {
    nowMs,
    settings,
    account,
    positions,
    workingOrders,
    orderMargins,
    contractCache: cache,
    realizedGross,
    fees,
    equityValid: allValid,
    equity,
    accountDto,
  };
}

export function describeRule(rule: ExitRule): string {
  switch (rule.type) {
    case 'eia_distillate_builds':
      return `Close both legs when EIA actuals confirm ${rule.weeks} consecutive weekly increases in U.S. distillate stocks.`;
    case 'stop_value':
      return `Stop: close when the strategy value reaches ${rule.level.toFixed(3)} $/bbl (adverse side).`;
    case 'target_value':
      return `Target: close when the strategy value reaches ${rule.level.toFixed(3)} $/bbl (favourable side).`;
    case 'max_loss_usd':
      return `Max loss: close when unrealized P/L ≤ −$${rule.amount.toLocaleString('en-US')}.`;
    case 'close_on_date':
      return `Time exit: close at the first valid mark after ${rule.date} ${rule.timeEt} ET.`;
  }
}

function describeRules(db: Db, p: PositionDto): { rule: ExitRule; text: string }[] {
  return p.exitRules.map((rule) => {
    let text = describeRule(rule);
    if (rule.type === 'eia_distillate_builds') {
      const streak = consecutiveBuilds(repo.listInventories(db, 12).map((i) => ({ ...i })), 'distillate');
      text += ` Current: ${streak.streak}/${rule.weeks}${streak.latestWeek ? ` through week ending ${streak.latestWeek}` : ' (no EIA actuals loaded)'}.`;
    }
    if ((rule.type === 'stop_value' || rule.type === 'target_value') && p.mark?.value !== null && p.mark?.value !== undefined) {
      text += ` Current ${p.mark.value.toFixed(3)}${p.mark.valid ? '' : ' (provisional)'}.`;
    }
    return { rule, text };
  });
}

export function currentTradeDate(nowMs: number): string | null {
  return sessionTradeDate(nowMs);
}
