// Collection: per-session best P&L, grade and best equity curve (the ghost).
import { simulate } from '../trade/engine.js';

export const GRADES = ['D', 'C', 'B', 'A', 'S'];
export const GRADE_RANK = Object.fromEntries(GRADES.map((g, i) => [g, i]));

/**
 * The yardstick for grades: the best of holding LONG, SHORT or SELL VOL at
 * 5 lots for the whole session. Active trading can beat it.
 */
export function bestAchievable(s) {
  const sides = s.spread ? ['LONG', 'SHORT'] : ['LONG', 'SHORT', 'VOL'];
  return Math.max(...sides.map((side) => simulate(s, [{ type: 'OPEN', side, lots: 5 }]).final), 1);
}

/** S ≥ 90% of best achievable · A ≥ 70% · B ≥ 45% · C > 0 · D lost money. */
export function gradeFor(pnl, best) {
  if (pnl <= 0) return 'D';
  const r = pnl / best;
  return r >= 0.9 ? 'S' : r >= 0.7 ? 'A' : r >= 0.45 ? 'B' : 'C';
}

/** Record a finished session (full-length runs only; OPEN BELL's 5-candle version isn't graded). */
export function recordPlay(progress, s, pnl, curve) {
  const prev = progress.played[s.id];
  const best = bestAchievable(s);
  const isBest = !prev || pnl > prev.best;
  const entry = {
    plays: (prev?.plays ?? 0) + 1,
    best: isBest ? Math.round(pnl) : prev.best,
    grade: gradeFor(isBest ? pnl : prev.best, best),
    curve: isBest ? curve.map((v) => Math.round(v)) : prev.curve,
    C: s.C,
    at: Date.now(),
  };
  return { ...progress, played: { ...progress.played, [s.id]: entry } };
}

export function collectionStats(progress, total) {
  const rows = Object.values(progress.played);
  return {
    collected: rows.length,
    total,
    s: rows.filter((r) => r.grade === 'S').length,
  };
}
