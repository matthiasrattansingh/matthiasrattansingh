// DESK scenario engine: a physical dislocation played as a short feed of cards (news, idea,
// scheduler decision, rival pitch). Pure functions over a plain state object.
import { seeded } from '../lib/format.js';
import { ideaPnl, settle } from './econ.js';

export const buildDesk = (card) => ({ ...card, D: card.days.length });

/** Rival bots read the series only through this view: no peeking past `day`. */
export function deskView(sc, day) {
  return {
    day,
    keys: Object.keys(sc.pitchable ?? {}),
    value(key, d = day) {
      if (d > day) throw new Error(`look-ahead: day ${d} > ${day}`);
      return sc.series[key].values[Math.max(0, d)];
    },
  };
}

const BOT_RULE = {
  quinn: 'Fades a dislocation once it turns; trades with it while it is still running. Tight size.',
  mo: "Chases yesterday's biggest move.",
  carla: "Fades yesterday's biggest move.",
  dan: 'Rides the biggest move since day 0, triple size, to the end of the scenario.',
};
export const PITCH_RULES = BOT_RULE;

/**
 * A rival's idea card on `day`, built by that bot's rule from data up to `day` only.
 * Returns a basis-style idea: buy or sell a series now, unwind at the horizon.
 */
export function botPitch(sc, botId, day) {
  const v = deskView(sc, day);
  const rows = v.keys.map((key) => {
    const p = sc.pitchable[key];
    const now = v.value(key);
    const move1 = day > 0 ? now - v.value(key, day - 1) : 0;
    const dev = now - v.value(key, 0);
    return { key, p, now, move1, dev, d1: move1 * p.qty, d0: dev * p.qty };
  });
  const by = (f) => [...rows].sort((a, b) => Math.abs(f(b)) - Math.abs(f(a)))[0];
  let pick;
  let dir; // +1 = buy the series now
  let size = 1;
  let horizon;
  if (botId === 'quinn') {
    pick = by((r) => r.d0);
    // Still running (yesterday moved the same way as the whole dislocation): go with it.
    // It turned (yesterday reversed): fade what's left of the dislocation.
    dir = Math.sign(pick.move1) === Math.sign(pick.dev) || pick.move1 === 0 ? Math.sign(pick.dev) || 1 : -Math.sign(pick.dev);
    horizon = 3;
  } else if (botId === 'mo') {
    pick = by((r) => r.d1); dir = Math.sign(pick.move1) || 1; horizon = 2;
  } else if (botId === 'carla') {
    pick = by((r) => r.d1); dir = -(Math.sign(pick.move1) || 1); horizon = 2;
  } else {
    pick = by((r) => r.d0); dir = Math.sign(pick.dev) || 1; size = 3; horizon = sc.D - 1 - day;
  }
  horizon = Math.max(1, Math.min(horizon, sc.D - 1 - day));
  const s = sc.series[pick.key];
  const verb = dir > 0 ? 'Buy' : 'Sell';
  const fmt = (x) => (Math.abs(x) >= 1000 ? `${x > 0 ? '+' : '−'}${Math.round(Math.abs(x) / 1000)}k` : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`);
  const why = {
    quinn: Math.sign(pick.move1) === Math.sign(pick.dev) ? `It's ${fmt(pick.dev)} since day one and still going. Riding it ${horizon}d.` : `It's ${fmt(pick.dev)} since day one and just turned. Fading it ${horizon}d.`,
    mo: `${fmt(pick.move1)} yesterday. Trend's your friend. ${horizon}d.`,
    carla: `${fmt(pick.move1)} yesterday? Overdone. Fading it ${horizon}d.`,
    dan: `${fmt(pick.dev)} and it's going further. Triple size, all the way. 🎰`,
  }[botId];
  const qty = pick.p.qty * size;
  return {
    type: 'basis', by: botId, title: `${verb} ${s.label}`, pitch: why, bbl: qty, unit: s.unit === '$/day' ? 'days' : undefined,
    horizon,
    legs: [
      { series: pick.key, side: dir > 0 ? 'buy' : 'sell', at: 'entry', label: `${verb} ${s.label}` },
      { series: pick.key, side: dir > 0 ? 'sell' : 'buy', at: 'exit', label: 'Unwind' },
    ],
    costs: [{ label: 'Execution', usd_bbl: pick.p.fee }],
    killers: [dir > 0 ? `${s.label} keeps falling` : `${s.label} keeps rising`, 'You are trading their conviction, not your own read'],
  };
}

/** The idea a card offers: authored ideas as written, pitches built by the bot's rule. */
export function ideaFor(sc, step) {
  if (step.kind === 'idea') return { ...step, by: null };
  if (step.kind === 'pitch') return botPitch(sc, step.by, step.day);
  return null;
}

export const actionable = (step) => step.kind === 'idea' || step.kind === 'pitch' || step.kind === 'decision';

export function newDeskState() {
  return { day: 0, positions: [], passed: [], decisions: {}, sched: [], pending: [], log: [], done: false };
}

/** Move the clock to `day`: scheduler consequences due by then land. */
export function advance(st, day) {
  if (day <= st.day) return st;
  const due = st.pending.filter((x) => x.day <= day);
  return {
    ...st, day,
    pending: st.pending.filter((x) => x.day > day),
    sched: [...st.sched, ...due],
    log: [...st.log, ...due.map((x) => ({ day: x.day, text: `${x.text}: ${x.usd >= 0 ? '+' : '−'}$${Math.abs(Math.round(x.usd)).toLocaleString()}`, type: 'sched' }))],
  };
}

/** RUN IT. A rival sometimes takes the other side (seeded); their P&L is the mirror of yours. */
export function run(sc, st, stepIdx, idea, roster = []) {
  const step = sc.steps[stepIdx];
  const rand = seeded(`cp|${sc.id}|${stepIdx}`);
  const others = roster.filter((a) => a.id !== idea.by);
  const cp = others.length && rand() < 0.4 ? others[Math.floor(rand() * others.length)].id : null;
  return {
    ...st,
    positions: [...st.positions, { stepIdx, idea, entry: step.day, counterparty: cp }],
    log: [...st.log, { day: step.day, text: `Ran: ${idea.title}${cp ? ` (other side: ${cp})` : ''}`, type: 'run' }],
  };
}

export function pass(sc, st, stepIdx, idea) {
  const step = sc.steps[stepIdx];
  return { ...st, passed: [...st.passed, { stepIdx, idea, entry: step.day }], log: [...st.log, { day: step.day, text: `Passed: ${idea.title}`, type: 'pass' }] };
}

/** A scheduler decision: the immediate cost books now, the consequence lands on its day. */
export function decide(st, stepIdx, decision, optIdx, now = st.day) {
  const o = decision.options[optIdx];
  const out = { ...st, decisions: { ...st.decisions, [stepIdx]: optIdx }, sched: [...st.sched], pending: [...st.pending], log: [...st.log] };
  if (o.now && o.now.usd) {
    out.sched.push({ day: now, usd: o.now.usd, text: o.now.text });
    out.log.push({ day: now, text: `${o.now.text}: ${o.now.usd >= 0 ? '+' : '−'}$${Math.abs(o.now.usd).toLocaleString()}`, type: 'sched' });
  }
  if (o.later) out.pending.push({ ...o.later, day: Math.max(now, o.later.day) });
  return out;
}

/** Live desk P&L on the current day: open ideas marked, decisions landed so far. */
export function deskMark(sc, st, t = st.day) {
  const ideas = st.positions.reduce((s, p) => s + ideaPnl(sc, p.idea, p.entry, t), 0);
  const sched = st.sched.reduce((s, x) => s + x.usd, 0);
  return { ideas, sched, total: ideas + sched };
}

/** Your desk book marked each day (ideas open by then + scheduler landed by then). */
export function deskCurve(sc, st) {
  return Array.from({ length: sc.D }, (_, d) => {
    const ideas = st.positions.filter((p) => p.entry <= d).reduce((s, p) => s + ideaPnl(sc, p.idea, p.entry, d), 0);
    const sched = st.sched.filter((x) => x.day <= d).reduce((s, x) => s + x.usd, 0);
    return ideas + sched;
  });
}

/**
 * Close the book: every idea settles at its horizon (or the last day), every pending
 * consequence lands. Returns the split, each call's outcome (judgment), and the rivals' books.
 */
export function finishDesk(sc, st, roster = []) {
  const last = sc.D - 1;
  const landed = advance({ ...st, day: Math.min(st.day, last - 1) }, last + 999);
  const outcomes = [
    ...st.positions.map((p) => ({ ...p, ran: true, pnl: settle(sc, p.idea, p.entry).pnl })),
    ...st.passed.map((p) => ({ ...p, ran: false, pnl: settle(sc, p.idea, p.entry).pnl })),
  ].sort((a, b) => a.stepIdx - b.stepIdx).map((o) => ({ ...o, right: o.ran ? o.pnl > 0 : o.pnl <= 0 }));
  const ideas = outcomes.filter((o) => o.ran).reduce((s, o) => s + o.pnl, 0);
  const sched = landed.sched.reduce((s, x) => s + x.usd, 0);
  // Best with hindsight: run every winner, pass every loser, take the better side of each decision.
  let bestSched = 0;
  sc.steps.forEach((step) => {
    if (step.kind !== 'decision') return;
    bestSched += Math.max(...step.options.map((o) => (o.now?.usd ?? 0) + (o.later?.usd ?? 0)));
  });
  const best = outcomes.reduce((s, o) => s + Math.max(0, o.pnl), 0) + bestSched;
  // Rivals: each runs its own pitches; the counterparty on your trades books the mirror.
  const bots = Object.fromEntries(roster.map((a) => [a.id, { pnl: 0, pitches: [] }]));
  sc.steps.forEach((step) => {
    if (step.kind !== 'pitch' || !bots[step.by]) return;
    const idea = botPitch(sc, step.by, step.day);
    const pnl = settle(sc, idea, step.day).pnl;
    bots[step.by].pnl += pnl;
    bots[step.by].pitches.push({ title: idea.title, pnl });
  });
  outcomes.filter((o) => o.ran && o.counterparty && bots[o.counterparty]).forEach((o) => { bots[o.counterparty].pnl -= o.pnl; });
  const calls = outcomes.length;
  return {
    pnl: ideas + sched, best, split: { ideas, sched }, outcomes, calls,
    right: outcomes.filter((o) => o.right).length, bots, log: landed.log,
  };
}
