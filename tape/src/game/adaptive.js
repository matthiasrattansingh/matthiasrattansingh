// ADAPTIVE DESK: the bots learn your habits across sessions and the tape gets meaner when
// you're winning too easily. Pure functions over progress.adapt.
//
// Tracked per paper session:
//   faded      your first trade went against the move into it (you fade first moves)
//   oversize   you opened bigger than 2 lots right after a win
//   chased     you opened or added on a candle that carried a headline
//   trap       the session was a priced-in trap, and fell = you traded the obvious way and lost
// Win rate per scenario type (crude / products / spreads / physical) above HARD_WIN_RATE over
// at least HARD_MIN sessions serves the HARD version (see trade/execution.js hardenSession).
import { seeded } from '../lib/format.js';
import { toPerBbl } from '../lib/scoring.js';

export const HARD_WIN_RATE = 0.65;
export const HARD_MIN = 5;
export const HABIT_RATE = 0.5;
export const HABIT_MIN = 4;
const KEEP = 60;

export const emptyAdapt = () => ({ sessions: [], traps: { seen: 0, fell: 0 } });

export const typeOf = (card) => (card.mode === 'integrated' || ['cargo', 'tank', 'desk', 'idea'].includes(card.type) ? 'physical' : card.category);

/** Win rate on a scenario type, from the last 20 sessions of that type. */
export function winRate(p, type) {
  const xs = (p.adapt?.sessions ?? []).filter((x) => x.type === type).slice(-20);
  return { n: xs.length, rate: xs.length ? xs.filter((x) => x.win).length / xs.length : 0 };
}

export function isHard(p, type) {
  const w = winRate(p, type);
  return w.n >= HARD_MIN && w.rate > HARD_WIN_RATE;
}

/** What you did in a session, read from your decisions (no outcome knowledge needed). */
export function readSession(s, decisions, prevWin) {
  const firstIdx = decisions.findIndex((d) => d && d.type === 'OPEN');
  const first = firstIdx >= 0 ? decisions[firstIdx] : null;
  const closes = [...s.history, ...s.candles.map((c) => c.c)];
  const at = s.history.length - 1 + Math.max(0, firstIdx); // index of the price you decided on
  const into = closes[at] - closes[Math.max(0, at - 3)];
  const faded = Boolean(first && first.side !== 'VOL' && into !== 0 && (first.side === 'LONG') !== (into > 0));
  const oversize = Boolean(prevWin && first && first.lots > 2);
  const newsIdx = new Set(s.news.filter((n) => !n.fake).map((n) => n.at));
  const chased = decisions.some((d, i) => d && (d.type === 'OPEN' || d.type === 'ADD') && newsIdx.has(i));
  return { traded: Boolean(first), faded, oversize, chased, firstSide: first?.side ?? null };
}

/** Book a session into the profile. */
export function recordAdapt(p, { card, s, decisions, win, pnl }) {
  const a = p.adapt ?? emptyAdapt();
  const prevWin = a.sessions.at(-1)?.win ?? false;
  const r = readSession(s, decisions, prevWin);
  const trap = trapOf(s);
  const fell = Boolean(trap && r.traded && r.firstSide === trap.obvious && pnl < 0);
  const row = { type: typeOf(card), win, ...r, trap: Boolean(trap), fell, at: Date.now() };
  return {
    ...p,
    adapt: {
      sessions: [...a.sessions, row].slice(-KEEP),
      traps: trap ? { seen: a.traps.seen + 1, fell: a.traps.fell + (fell ? 1 : 0) } : a.traps,
    },
  };
}

const HABITS = {
  faded: { bot: 'carla', name: 'fading first moves', line: 'You fade every first move. I front-run your fade now. 🦊', exploit: (s, i, action, pos) => i === 0 || (!pos && action.type === 'OPEN') },
  oversize: { bot: 'quinn', name: 'oversizing after a win', line: 'Model flags you: size goes up after a win. I lean on your big orders.', exploit: (s, i, action) => action.type === 'OPEN' && action.lots > 2 },
  chased: { bot: 'mo', name: 'chasing headlines', line: 'You chase every headline. I get there first and sell it to you. 🏄', exploit: (s, i, action) => (action.type === 'OPEN' || action.type === 'ADD') && s.news.some((n) => n.at === i) },
};
export const HABIT_INFO = HABITS;

/** Your habits the desk has picked up: rate over your last 20 traded sessions. */
export function habits(p) {
  const xs = (p.adapt?.sessions ?? []).filter((x) => x.traded).slice(-20);
  if (xs.length < HABIT_MIN) return [];
  return Object.keys(HABITS)
    .map((k) => ({ key: k, rate: xs.filter((x) => x[k]).length / xs.length, n: xs.length, ...HABITS[k] }))
    .filter((h) => h.rate >= HABIT_RATE)
    .sort((a, b) => b.rate - a.rate);
}

/** Does this fill match a habit a bot is exploiting? Returns the bot id or null. */
export function frontRunner(hab, s, i, action, pos) {
  for (const h of hab) if (h.exploit(s, i, action, pos)) return h.bot;
  return null;
}

// ---------------------------------------------------------------- priced-in traps

/**
 * A priced-in trap, read from the real data:
 *   ran-before   the price already ran ≥3% into the open, and the session does not follow through
 *   headline     a major headline, and the two candles after it reverse the two before it
 * `obvious` is the side a headline-chaser would take; the trap is that it doesn't pay.
 */
export function trapOf(s) {
  const h = s.history;
  if (h.length >= 6) {
    const run = (s.p0 - h[h.length - 6]) / Math.abs(h[h.length - 6] || 1);
    const after = s.candles[s.C - 1].c - s.p0;
    const followed = Math.sign(after) === Math.sign(run) && Math.abs(toPerBbl(after, s.unit)) > (s.bandBbl || 0.3);
    if (Math.abs(run) >= 0.03 && !followed) {
      return { kind: 'ran-before', obvious: run > 0 ? 'LONG' : 'SHORT', text: `Priced-in trap: it had already run ${run > 0 ? '+' : '−'}${Math.abs(run * 100).toFixed(1)}% in the five days before the open. The move you saw was the move you missed.` };
    }
  }
  const major = s.news.find((n) => n.major && !n.fake && n.at >= 2 && n.at <= s.C - 2);
  if (major) {
    const k = major.at;
    const before = s.candles[k - 1].c - s.candles[k - 2].o;
    const afterK = s.candles[Math.min(s.C - 1, k + 1)].c - s.candles[k].o;
    if (before !== 0 && Math.sign(afterK) === -Math.sign(before)) {
      return { kind: 'headline', obvious: before > 0 ? 'LONG' : 'SHORT', text: `Priced-in trap: "${major.text}" looked tradeable, but the price had moved ahead of it and reversed after.` };
    }
  }
  return null;
}

export const trapRate = (p) => {
  const t = p.adapt?.traps ?? { seen: 0, fell: 0 };
  return { ...t, rate: t.seen ? t.fell / t.seen : 0 };
};

/**
 * Trap weighting for the next pick: the more you fall for traps, the more of them you get.
 * Returns the probability that the next session is drawn from the trap pool (0.15 → 0.5).
 */
export function trapWeight(p) {
  const t = trapRate(p);
  if (t.seen < 3) return 0.15;
  return Math.min(0.5, 0.15 + t.rate * 0.5);
}

/** Seeded choice: should this pick be a trap? */
export const pickTrap = (p, salt) => seeded(`trap|${salt}`)() < trapWeight(p);
