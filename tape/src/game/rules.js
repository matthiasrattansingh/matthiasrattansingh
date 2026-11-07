// SCORING RULES: prop-firm loss limits and what counts as a WIN. Pure functions.
//
// Limits scale with the equity you start the session with (100k → $3k / $4k / $2.5k):
//   daily loss limit   session P&L may not fall below −3% of starting equity
//   trailing drawdown  session P&L may not fall 4% below its own high-water mark
//   risk budget        a WIN needs max drawdown ≤ 2.5% (tighter than the trailing cap,
//                      so one lucky max-size bet that survived a deep hole is not a win)
// Hit either limit and the session ends on the spot; the score is locked as-is.

export const RULES = { dailyLossPct: 0.03, trailingPct: 0.04, riskBudgetPct: 0.025 };

export function limitsFor(startEquity, rules = RULES) {
  const e = Math.max(1, startEquity);
  return { daily: e * rules.dailyLossPct, trailing: e * rules.trailingPct, budget: e * rules.riskBudgetPct };
}

/**
 * Where you stand against both limits. pnl = session P&L now, peak = highest session P&L so far
 * (the high-water mark starts at 0). Returns fills 0..1 for the two meters and which limit hit.
 */
export function limitState({ pnl, peak }, limits) {
  const hwm = Math.max(0, peak, pnl);
  const daily = Math.max(0, -pnl) / limits.daily;
  const trailing = Math.max(0, hwm - pnl) / limits.trailing;
  const hit = daily >= 1 ? 'daily' : trailing >= 1 ? 'trailing' : null;
  return { daily: Math.min(1, daily), trailing: Math.min(1, trailing), hit, hwm };
}

/**
 * Apply the same limits to any P&L path (bots, the passive benchmark): the run stops at the
 * first point a limit hits and its score is locked there, exactly like yours.
 */
export function lockedPnl(curve, limits) {
  let peak = 0;
  for (let k = 0; k < curve.length; k++) {
    peak = Math.max(peak, curve[k]);
    const hit = limitState({ pnl: curve[k], peak }, limits).hit;
    if (hit) return { pnl: curve[k], hit, at: k };
  }
  return { pnl: curve.at(-1) ?? 0, hit: null, at: null };
}

/** A bot's simulated session under the limits: once one hits, its P&L is frozen there. */
export function lockSim(sim, limits) {
  const lock = lockedPnl(sim.curve, limits);
  if (lock.at === null) return sim;
  const curve = sim.curve.map((v, k) => (k < lock.at ? v : lock.pnl));
  return { ...sim, curve, final: lock.pnl, limitHit: lock.hit };
}

/** Max drawdown of a P&L path from its running high-water mark (which starts at 0). */
export function maxDrawdown(curve) {
  let hwm = 0;
  let dd = 0;
  for (const v of curve) {
    hwm = Math.max(hwm, v);
    dd = Math.max(dd, hwm - v);
  }
  return dd;
}

/**
 * A session WIN needs all three:
 *   (a) P&L beats the best bot   (b) P&L beats the passive benchmark   (c) max drawdown ≤ risk budget
 * bots: [{ id, pnl }]; passive: { pnl, label }; limitHit: 'daily' | 'trailing' | null.
 */
export function verdict({ pnl, bots, passive, maxDD, budget, limitHit = null }) {
  const best = bots.length ? bots.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : { id: null, pnl: -Infinity };
  const checks = [
    { key: 'bots', label: 'Beat the best bot', pass: pnl > best.pnl, you: pnl, need: best.pnl, who: best.id },
    { key: 'passive', label: `Beat the passive benchmark (${passive.label})`, pass: pnl > passive.pnl, you: pnl, need: passive.pnl },
    { key: 'risk', label: 'Max drawdown inside the risk budget', pass: maxDD <= budget, you: maxDD, need: budget },
  ];
  return { win: checks.every((c) => c.pass), checks, limitHit };
}
