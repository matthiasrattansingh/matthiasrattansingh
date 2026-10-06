// The paper-trading engine: marks positions, enforces the drawdown limit, evaluates exit rules,
// fills pending exits and working orders, and records a mark snapshot. Everything runs inside a
// single SQLite transaction so a crash never leaves a half-applied fill.
//
// Simulated only. Nothing in this module (or anywhere in the app) sends an order to a broker
// or an exchange.
import type { AppSettings, ContractMarkDto, LegFillDto, OrderDto, PositionDto } from '../shared/types.ts';
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import { loadSettings } from './settings.ts';
import { valuate, markContract, orderLegsAndContracts, type Valuation } from './valuation.ts';
import { commissionForSide, fillLegs, grossPnl, type Direction } from '../domain/pnl.ts';
import { checkOrderMargin, computeBuyingPower, fmtUsd, isDrawdownBreached } from '../domain/risk.ts';
import { etWallClockToUtc, isMarketOpen } from '../domain/calendar.ts';
import { lastTradingDay } from '../domain/contracts.ts';
import { evaluateDistillateExit } from '../domain/inventory.ts';

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface EvaluateResult {
  valuation: Valuation;
  actions: { type: string; summary: string }[];
}

interface MarkSet {
  prices: Record<string, number>;
  detail: { contract: string; price: number; exchangeTs: string; observedAt: string; source: string; status: string }[];
  valid: boolean;
  earliestExchangeTs: string | null;
}

function markSet(legs: { contract: string }[], cache: Map<string, ContractMarkDto>, db: Db, nowMs: number, settings: AppSettings): MarkSet {
  const prices: Record<string, number> = {};
  const detail: MarkSet['detail'] = [];
  let valid = true;
  let earliest: string | null = null;
  for (const l of legs) {
    let m = cache.get(l.contract);
    if (!m) {
      m = markContract(db, l.contract, nowMs, settings);
      cache.set(l.contract, m);
    }
    if (!m.quote || !m.freshness.valid) {
      valid = false;
      continue;
    }
    prices[l.contract] = m.quote.price;
    detail.push({
      contract: l.contract,
      price: m.quote.price,
      exchangeTs: m.quote.exchangeTs,
      observedAt: m.quote.observedAt,
      source: m.quote.source,
      status: m.freshness.status,
    });
    if (!earliest || m.quote.exchangeTs < earliest) earliest = m.quote.exchangeTs;
  }
  return { prices, detail, valid, earliestExchangeTs: earliest };
}

/** Close a position at the given marks. Returns null if it was already closed (idempotent). */
export function closeAtMarks(
  db: Db,
  p: PositionDto,
  marks: MarkSet,
  kind: string,
  reason: string,
  nowIso: string,
  settings: AppSettings,
  accountId: number,
): { realizedGross: number; exitValue: number; fills: LegFillDto[]; commission: number | null } | null {
  const { fills, value } = fillLegs(p.legs, p.direction, marks.prices, 'close', settings.slippageTicksPerLeg);
  const gross = grossPnl(p.direction, p.entryValue, value, p.barrels);
  const commission = commissionForSide(p.legs.length, p.contractsPerLeg, settings.commissionPerContractPerSide);
  const r = db.run(
    `UPDATE positions SET status = 'closed', closed_at = ?, exit_value = ?, exit_fills_json = ?, exit_reason = ?, exit_kind = ?,
       exit_commission = ?, realized_gross = ?, exit_pending_json = NULL
     WHERE id = ? AND status IN ('open','exit_pending')`,
    nowIso,
    value,
    JSON.stringify(fills),
    reason,
    kind,
    commission,
    gross,
    p.id,
  );
  if (r.changes !== 1) return null;
  const slip = settings.slippageTicksPerLeg ? `${settings.slippageTicksPerLeg} tick(s)/leg slippage applied` : 'no slippage configured';
  repo.addEvent(db, {
    accountId,
    ts: nowIso,
    type: kind === 'drawdown' ? 'risk.liquidation_fill' : 'position.closed',
    summary: `${kind === 'drawdown' ? 'SIMULATED LIQUIDATION' : 'Simulated close'} #${p.id} ${p.label} at ${value.toFixed(3)} $/bbl (entry ${p.entryValue.toFixed(3)}): realized ${fmtUsd(gross)} gross${commission !== null ? `, exit commission ${fmtUsd(commission)}` : ' before costs'}. Reason: ${reason}`,
    detail: { positionId: p.id, kind, reason, exitValue: value, entryValue: p.entryValue, realizedGross: gross, commission, fills, marks: marks.detail, slippage: slip, simulated: true },
    dedupeKey: `close:${p.id}`,
  });
  return { realizedGross: gross, exitValue: value, fills, commission };
}

function setExitPending(db: Db, p: PositionDto, kind: string, reason: string, notBefore: string, nowIso: string, accountId: number): boolean {
  const pending = { kind, reason, requestedAt: nowIso, notBefore };
  const r = db.run("UPDATE positions SET status = 'exit_pending', exit_pending_json = ? WHERE id = ? AND status = 'open'", JSON.stringify(pending), p.id);
  if (r.changes !== 1) return false;
  p.status = 'exit_pending';
  p.exitPending = pending;
  repo.addEvent(db, {
    accountId,
    ts: nowIso,
    type: 'position.exit_triggered',
    summary: `Exit triggered for #${p.id} ${p.label}: ${reason} Will fill at the first valid mark with exchange time ≥ ${notBefore}.`,
    detail: pending,
    dedupeKey: `exit-trigger:${p.id}`,
  });
  return true;
}

function haltAccount(db: Db, accountId: number, reason: string, nowIso: string): void {
  db.run("UPDATE accounts SET status = 'halted', halted_at = ?, halted_reason = ? WHERE id = ? AND status = 'active'", nowIso, reason, accountId);
  for (const o of repo.workingOrders(db, accountId)) {
    db.run("UPDATE orders SET status = 'cancelled', reasons_json = ?, updated_at = ? WHERE id = ? AND status = 'working'", JSON.stringify([`Cancelled: ${reason}`]), nowIso, o.id);
    repo.addEvent(db, { accountId, ts: nowIso, type: 'order.cancelled', summary: `Working order #${o.id} cancelled: account halted.`, dedupeKey: `order-cancel:${o.id}` });
  }
}

/** Does the pending exit's mark satisfy notBefore (exchange time of every leg at/after it)? */
function marksAfter(marks: MarkSet, notBefore: string | null): boolean {
  if (!notBefore) return true;
  return marks.detail.every((d) => Date.parse(d.exchangeTs) >= Date.parse(notBefore));
}

export interface EvaluateOptions {
  recordMark?: boolean;
}

export function evaluate(db: Db, nowMs: number, trigger: string, opts: EvaluateOptions = {}): EvaluateResult {
  return db.tx(() => {
    const settings = loadSettings(db);
    const nowIso = iso(nowMs);
    const actions: EvaluateResult['actions'] = [];
    const marketOpen = isMarketOpen(nowMs);
    let v = valuate(db, nowMs, settings);
    const accountId = v.account.id;
    let changed = false;

    // 1. High-water mark — only from fully valid marks.
    if (v.equityValid && v.equity > v.account.peak_equity + 1e-9) {
      db.run('UPDATE accounts SET peak_equity = ?, peak_at = ? WHERE id = ?', v.equity, nowIso, accountId);
      v.account.peak_equity = v.equity;
      v.account.peak_at = nowIso;
    }

    // 2. Drawdown limit.
    const peak = v.account.peak_equity;
    const pct = settings.maxDrawdownPct;
    if (v.positions.length && v.equityValid && isDrawdownBreached(peak, v.equity, pct)) {
      const reason = `Max drawdown reached: marked equity ${fmtUsd(v.equity)} ≤ ${fmtUsd(peak * (1 - pct / 100))} (${pct}% below peak ${fmtUsd(peak)}).`;
      repo.addEvent(db, {
        accountId,
        ts: nowIso,
        type: 'risk.drawdown_breach',
        summary: `${reason} All simulated positions are being liquidated; trading halted. No real orders are sent.`,
        detail: { equity: v.equity, peak, maxDrawdownPct: pct, positions: v.positions.map((p) => ({ id: p.id, value: p.mark?.value, unrealized: p.mark?.unrealized })) },
        dedupeKey: `dd-breach:${accountId}`,
      });
      haltAccount(db, accountId, reason, nowIso);
      for (const p of v.positions) {
        const marks = markSet(p.legs, v.contractCache, db, nowMs, settings);
        if (marketOpen && marks.valid) {
          const res = closeAtMarks(db, p, marks, 'drawdown', reason, nowIso, settings, accountId);
          if (res) actions.push({ type: 'liquidation', summary: `#${p.id} liquidated at ${res.exitValue.toFixed(3)} (${fmtUsd(res.realizedGross)})` });
        } else {
          db.run("UPDATE positions SET status = 'open' WHERE id = ? AND status = 'exit_pending'", p.id);
          p.status = 'open';
          setExitPending(db, p, 'drawdown', `${reason} Market closed — liquidation deferred to the first valid mark of the next session.`, nowIso, nowIso, accountId);
          actions.push({ type: 'liquidation-pending', summary: `#${p.id} liquidation pending (market closed)` });
        }
      }
      changed = true;
    } else {
      if (v.accountDto.provisionalBreach) {
        repo.addEvent(db, {
          accountId,
          ts: nowIso,
          type: 'risk.provisional_breach',
          summary: `Provisional equity ${fmtUsd(v.equity)} is at/below the drawdown floor, but at least one mark is stale or missing. Liquidation waits for valid marks.`,
          detail: { reasons: v.accountDto.equityReasons },
          dedupeKey: `prov-breach:${accountId}:${nowIso.slice(0, 13)}`,
        });
      }

      // 3. Exit rules and pending exits.
      const inventories = repo.listInventories(db, 12);
      for (const p of v.positions) {
        const marks = markSet(p.legs, v.contractCache, db, nowMs, settings);
        if (p.status === 'exit_pending' && p.exitPending) {
          if (marketOpen && marks.valid && marksAfter(marks, p.exitPending.notBefore)) {
            const res = closeAtMarks(db, p, marks, p.exitPending.kind, p.exitPending.reason, nowIso, settings, accountId);
            if (res) {
              actions.push({ type: 'exit-fill', summary: `#${p.id} closed at ${res.exitValue.toFixed(3)}` });
              changed = true;
            }
          }
          continue;
        }
        // Expiry guard: never carry a paper position into expiry/delivery.
        if (settings.expiryGuardEnabled) {
          const ltd = p.legs.map((l) => lastTradingDay(l.contract)).sort()[0];
          const guardAt = etWallClockToUtc(ltd, settings.expiryGuardTimeEt);
          if (nowMs >= Date.parse(guardAt)) {
            if (setExitPending(db, p, 'expiry', `Expiry guard: earliest leg's computed last trading day is ${ltd}; positions are not carried into expiry.`, guardAt, nowIso, accountId)) {
              actions.push({ type: 'exit-trigger', summary: `#${p.id} expiry guard` });
              changed = true;
            }
            continue;
          }
        }
        let triggered: { kind: string; reason: string; notBefore: string | null } | null = null;
        for (const rule of p.exitRules) {
          if (triggered) break;
          if (rule.type === 'eia_distillate_builds') {
            const ev = evaluateDistillateExit(
              inventories.map((i) => ({ ...i })),
              rule.weeks,
              p.openedAt,
            );
            if (ev.met) {
              const confirming = inventories.find((i) => i.series === 'distillate' && i.kind === 'actual' && i.weekEnding === ev.streak.latestWeek);
              const learnedAt = confirming ? [confirming.enteredAt, confirming.releasedAt ?? confirming.enteredAt].sort().reverse()[0] : nowIso;
              triggered = { kind: 'eia', reason: ev.reason, notBefore: learnedAt };
            }
            continue;
          }
          if (rule.type === 'close_on_date') {
            const at = etWallClockToUtc(rule.date, rule.timeEt);
            if (nowMs >= Date.parse(at)) triggered = { kind: 'time', reason: `Time exit reached (${rule.date} ${rule.timeEt} ET).`, notBefore: at };
            continue;
          }
          if (!p.mark?.valid || p.mark.value === null || p.mark.unrealized === null) continue;
          const val = p.mark.value;
          if (rule.type === 'stop_value' && (p.direction === 1 ? val <= rule.level : val >= rule.level)) {
            triggered = { kind: 'stop', reason: `Stop level ${rule.level.toFixed(3)} reached (mark ${val.toFixed(3)}).`, notBefore: null };
          } else if (rule.type === 'target_value' && (p.direction === 1 ? val >= rule.level : val <= rule.level)) {
            triggered = { kind: 'target', reason: `Target level ${rule.level.toFixed(3)} reached (mark ${val.toFixed(3)}).`, notBefore: null };
          } else if (rule.type === 'max_loss_usd' && p.mark.unrealized <= -rule.amount) {
            triggered = { kind: 'max-loss', reason: `Max loss ${fmtUsd(rule.amount)} reached (unrealized ${fmtUsd(p.mark.unrealized)}).`, notBefore: null };
          }
        }
        if (!triggered) continue;
        if (triggered.notBefore === null && marketOpen && marks.valid) {
          // Price-based rule triggered on a valid mark during the session: fill at this mark.
          const res = closeAtMarks(db, p, marks, triggered.kind, triggered.reason, nowIso, settings, accountId);
          if (res) {
            actions.push({ type: 'exit-fill', summary: `#${p.id} ${triggered.kind} at ${res.exitValue.toFixed(3)}` });
            changed = true;
          }
        } else {
          const notBefore = triggered.notBefore ?? nowIso;
          if (setExitPending(db, p, triggered.kind, triggered.reason, notBefore, nowIso, accountId)) {
            changed = true;
            actions.push({ type: 'exit-trigger', summary: `#${p.id} ${triggered.kind} pending` });
            if (marketOpen && marks.valid && marksAfter(marks, notBefore)) {
              const res = closeAtMarks(db, p, marks, triggered.kind, triggered.reason, nowIso, settings, accountId);
              if (res) actions.push({ type: 'exit-fill', summary: `#${p.id} closed at ${res.exitValue.toFixed(3)}` });
            }
          }
        }
      }

      // 4. Working orders.
      if (changed) v = valuate(db, nowMs, settings);
      for (const o of v.workingOrders) {
        const res = processWorkingOrder(db, o, v, nowMs, settings);
        if (res) {
          actions.push(res);
          changed = true;
          v = valuate(db, nowMs, settings);
        }
      }
    }

    if (changed) v = valuate(db, nowMs, settings);

    if (opts.recordMark !== false) {
      db.run(
        `INSERT INTO marks (account_id, ts, trigger, valid, equity, unrealized, realized, fees, peak_equity, drawdown_pct, reserved_margin, buying_power, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        accountId,
        nowIso,
        trigger,
        v.equityValid ? 1 : 0,
        v.equity,
        v.accountDto.unrealized ?? v.accountDto.unrealizedProvisional,
        v.realizedGross,
        v.fees,
        v.accountDto.peakEquity,
        v.accountDto.drawdownPct,
        v.accountDto.buyingPower.reservedMargin,
        v.accountDto.buyingPower.buyingPower,
        JSON.stringify({
          positions: v.positions.map((p) => ({ id: p.id, value: p.mark?.value ?? null, unrealized: p.mark?.unrealized ?? null, valid: p.mark?.valid ?? false })),
          legs: [...v.contractCache.values()].map((m) => ({
            contract: m.contract,
            price: m.quote?.price ?? null,
            exchangeTs: m.quote?.exchangeTs ?? null,
            source: m.quote?.source ?? null,
            status: m.freshness.status,
          })),
        }),
      );
    }
    return { valuation: v, actions };
  });
}

function processWorkingOrder(db: Db, o: OrderDto, v: Valuation, nowMs: number, settings: AppSettings): { type: string; summary: string } | null {
  const nowIso = iso(nowMs);
  const accountId = v.account.id;
  const orow = db.get<{ expires_at: string | null }>('SELECT expires_at FROM orders WHERE id = ?', o.id);
  if (orow?.expires_at && nowMs >= Date.parse(orow.expires_at)) {
    const r = db.run("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'working'", nowIso, o.id);
    if (r.changes) {
      repo.addEvent(db, { accountId, ts: nowIso, type: 'order.expired', summary: `Day order #${o.id} expired unfilled at session end.`, dedupeKey: `order-expired:${o.id}` });
      return { type: 'order-expired', summary: `#${o.id} expired` };
    }
    return null;
  }
  if (!isMarketOpen(nowMs)) return null;
  const { legs, contracts } = orderLegsAndContracts(o);
  const marks = markSet(legs, v.contractCache, db, nowMs, settings);
  if (!marks.valid) return null;
  if (settings.fillPolicy === 'next_mark_after_submit' && !marksAfter(marks, o.submittedAt)) return null;
  const direction: Direction = o.request.direction === 'long' ? 1 : -1;
  const { fills, value } = fillLegs(legs, direction, marks.prices, 'open', settings.slippageTicksPerLeg);
  if (o.request.entryMethod === 'limit') {
    const lim = Number(o.request.limitValue);
    if (direction === 1 ? value > lim + 1e-9 : value < lim - 1e-9) return null;
  }
  // Margin re-check at fill, excluding this order's own reservation.
  const reservations = [...v.positions.map((p) => p.margin!), ...[...v.orderMargins.entries()].filter(([id]) => id !== o.id).map(([, m]) => m)];
  const bp = computeBuyingPower(v.equity, v.equityValid, reservations, v.accountDto.equityReasons);
  const required = v.orderMargins.get(o.id)!;
  const check = checkOrderMargin(bp, required);
  if (!check.ok) {
    db.run(
      "UPDATE orders SET status = 'rejected', reasons_json = ?, margin_json = ?, updated_at = ? WHERE id = ? AND status = 'working'",
      JSON.stringify(check.reasons.map((r) => `Margin re-check at fill failed: ${r}`)),
      JSON.stringify(check),
      nowIso,
      o.id,
    );
    repo.addEvent(db, {
      accountId,
      ts: nowIso,
      type: 'order.rejected',
      summary: `Order #${o.id} rejected at fill: ${check.reasons.join(' ')}`,
      detail: check,
      dedupeKey: `order-reject-fill:${o.id}`,
    });
    return { type: 'order-rejected', summary: `#${o.id} rejected at fill` };
  }
  const commission = commissionForSide(legs.length, contracts, settings.commissionPerContractPerSide);
  const label = orderLabel(o);
  const upd = db.run("UPDATE orders SET status = 'filled', updated_at = ?, fill_json = ? WHERE id = ? AND status = 'working'", nowIso, JSON.stringify({ value, fills, marks: marks.detail, commission }), o.id);
  if (upd.changes !== 1) return null;
  const positionId = repo.insertPosition(db, {
    accountId,
    strategy: o.request.strategy,
    label,
    direction,
    legs,
    contractsPerLeg: contracts,
    barrels: contracts * 1000,
    entryValue: value,
    entryFills: fills,
    entryKind: 'order',
    entryNote: `Simulated paper fill from order #${o.id} at ${settings.slippageTicksPerLeg ? `marks + ${settings.slippageTicksPerLeg} tick(s)/leg slippage` : 'marks (no slippage configured)'}; leg exchange times ${marks.detail.map((d) => `${d.contract} ${d.exchangeTs}`).join(', ')}. Not an exchange execution.`,
    openedAt: nowIso,
    orderId: o.id,
    rationale: o.request.rationale,
    exitRuleText: o.request.exitRuleText,
    exitRules: o.request.exitRules,
    entryCommission: commission,
  });
  db.run('UPDATE orders SET position_id = ? WHERE id = ?', positionId, o.id);
  repo.addEvent(db, {
    accountId,
    ts: nowIso,
    type: 'order.filled',
    summary: `Order #${o.id} filled (simulated): ${label} at ${value.toFixed(3)} $/bbl → position #${positionId}.${commission !== null ? ` Entry commission ${fmtUsd(commission)}.` : ''}`,
    detail: { orderId: o.id, positionId, value, fills, marks: marks.detail, commission, simulated: true },
    dedupeKey: `order-fill:${o.id}`,
  });
  return { type: 'order-filled', summary: `#${o.id} filled → #${positionId}` };
}

export function orderLabel(o: { request: OrderDto['request'] }): string {
  const r = o.request;
  const dir = r.direction === 'long' ? 'Long' : 'Short';
  const n = r.quantity.contracts ?? Math.round((r.quantity.barrels ?? 0) / 1000);
  if (r.strategy === 'outright') return `${dir} ${n} ${r.legs[0].contract}`;
  if (r.strategy === 'crack') return `${dir} ${r.legs[0].contract}–${r.legs[1].contract} crack ×${n}`;
  return `${dir} ${r.legs[0].contract}/${r.legs[1].contract} calendar ×${n}`;
}

/** User-requested close. Fill policy decides whether it fills now or at the next mark. */
export function requestClose(db: Db, positionId: number, nowMs: number, note: string): EvaluateResult {
  return db.tx(() => {
    const settings = loadSettings(db);
    const p = repo.positionById(db, positionId);
    if (!p || p.status === 'closed') throw new HttpError(404, 'Position not found or already closed.');
    if (p.status === 'exit_pending') throw new HttpError(409, 'An exit is already pending for this position.');
    const account = repo.currentAccount(db);
    const nowIso = iso(nowMs);
    repo.addEvent(db, {
      accountId: account.id,
      ts: nowIso,
      type: 'decision.close',
      summary: `User requested to close #${p.id} ${p.label}.${note ? ` Note: ${note}` : ''}`,
      detail: { positionId, note },
    });
    const notBefore = settings.fillPolicy === 'next_mark_after_submit' ? nowIso : '1970-01-01T00:00:00.000Z';
    setExitPending(db, p, 'user', `User close request.${note ? ` ${note}` : ''}`, notBefore, nowIso, account.id);
    return evaluate(db, nowMs, 'user-close');
  });
}

export function cancelOrder(db: Db, orderId: number, nowMs: number): OrderDto {
  return db.tx(() => {
    const o = repo.orderById(db, orderId);
    if (!o) throw new HttpError(404, 'Order not found.');
    if (o.status !== 'working') throw new HttpError(409, `Order is ${o.status}; only working orders can be cancelled.`);
    const nowIso = iso(nowMs);
    db.run("UPDATE orders SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'working'", nowIso, orderId);
    repo.addEvent(db, { accountId: repo.currentAccount(db).id, ts: nowIso, type: 'order.cancelled', summary: `User cancelled working order #${orderId}.`, dedupeKey: `order-cancel:${orderId}` });
    return repo.orderById(db, orderId)!;
  });
}

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
