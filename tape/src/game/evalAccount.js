// Prop-firm evaluation: a $100k sim sub-account, 30 calendar days to make +$20k,
// and a trailing max drawdown of 8% from peak equity that ends it instantly.
// Passing = FUNDED: 10- and 25-lot sizes unlock in normal play for good.
export const EVAL_START = 100_000;
export const EVAL_TARGET = 20_000;
export const EVAL_DD = 0.08;
export const EVAL_DAYS = 30;
const DAY_MS = 86_400_000;

export const evalActive = (p) => p.eval?.status === 'active';

export function startEval(p, now = Date.now()) {
  if (evalActive(p)) return p;
  return {
    ...p,
    eval: { status: 'active', start: now, end: now + EVAL_DAYS * DAY_MS, equity: EVAL_START, peak: EVAL_START, sessions: 0, best: EVAL_START },
  };
}

const dayOf = (e, now) => Math.min(EVAL_DAYS, Math.floor((now - e.start) / DAY_MS) + 1);
export const evalFloor = (e) => Math.round(e.peak * (1 - EVAL_DD));

function close(p, e, status, reason, now) {
  const done = { ...e, status, reason, endedAt: now, dayReached: dayOf(e, now) };
  const history = [{ status, reason, peak: e.peak, equity: e.equity, dayReached: done.dayReached, at: now }, ...(p.evalHistory ?? [])].slice(0, 20);
  return { ...p, eval: done, evalHistory: history, funded: p.funded || status === 'passed' };
}

/**
 * Book an eval session. pnl = session P&L; intraPeak = the highest equity reached
 * during the session (the trailing drawdown counts from intraday peaks); guardHit =
 * the session was stopped by the drawdown rule.
 */
export function bookEval(p, { pnl, intraPeak, guardHit }, now = Date.now()) {
  if (!evalActive(p)) return { progress: p, events: [] };
  const e0 = p.eval;
  const equity = Math.round(e0.equity + pnl);
  const peak = Math.max(e0.peak, Math.round(intraPeak ?? 0), equity);
  const e = { ...e0, equity, peak, best: Math.max(e0.best, peak), sessions: e0.sessions + 1 };
  if (guardHit || equity < peak * (1 - EVAL_DD)) {
    return { progress: close(p, e, 'failed', 'drawdown', now), events: [{ type: 'eval', text: `❌ EVAL over: trailing drawdown hit. Peak equity $${e.peak.toLocaleString()}.` }] };
  }
  if (equity - EVAL_START >= EVAL_TARGET) {
    return { progress: close(p, e, 'passed', 'target', now), events: [{ type: 'eval', text: '🏆 EVAL PASSED: you are FUNDED. 10 and 25 lots unlocked.' }] };
  }
  const toGo = EVAL_START + EVAL_TARGET - equity;
  return { progress: { ...p, eval: e }, events: [{ type: 'eval', text: `EVAL $${equity.toLocaleString()} · $${toGo.toLocaleString()} to go · floor $${evalFloor(e).toLocaleString()}` }] };
}

/** Time runs out even if you don't trade. */
export function refreshEval(p, now = Date.now()) {
  if (!evalActive(p) || now < p.eval.end) return { progress: p, events: [] };
  return { progress: close(p, p.eval, 'failed', 'time', now), events: [{ type: 'eval', text: '⌛ EVAL over: 30 days are up.' }] };
}

export function evalSummary(e, now = Date.now()) {
  return {
    day: dayOf(e, e.endedAt ?? now),
    daysLeft: Math.max(0, Math.ceil((e.end - now) / DAY_MS)),
    progress: Math.max(0, Math.min(1, (e.equity - EVAL_START) / EVAL_TARGET)),
    floor: evalFloor(e),
    room: e.equity - evalFloor(e),
  };
}
