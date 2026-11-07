// EXECUTION: what it costs to actually get filled. Pure and seeded, so a challenge link
// replays the identical tape: the same live ticks, spreads and fill ratios for everyone.
//
//  - slippage on every fill (you always pay the half-spread)
//  - the spread widens on candles that carry news
//  - orders above PARTIAL_ABOVE lots get partial fills
//  - the price keeps ticking while you decide: you fill at the live tick when you tap
//  - a desk bot that has read your habit front-runs it: extra slippage on that fill
import { seeded } from '../lib/format.js';
import { decisionPrice } from './engine.js';

export const EXEC = {
  halfSpreadBbl: 0.02, // $/bbl you pay on every fill (products: per bbl, converted to $/gal)
  newsSpreadMult: 3, // spread on a news candle
  frontRunBbl: 0.03, // extra when a bot front-runs your habit
  partialAbove: 2, // lots above this may only part-fill
  partialMin: 0.5, // fill ratio of the excess, seeded 0.5..0.9
  partialMax: 0.9,
  tickMs: 250, // live price ticks every 250 ms while you decide
  tickFrac: 0.06, // each tick moves up to 6% of the average candle range
};

const perBblToUnit = (v, unit) => (unit === '$/gal' ? v / 42 : v);

export function avgRange(s) {
  const r = s.candles.reduce((a, c) => a + (c.h - c.l), 0) / Math.max(1, s.C);
  return r || Math.abs(s.p0) * 0.002 || 0.01;
}

/**
 * The live price `ms` into the decision window before candle i: a seeded random walk from the
 * last close, one step per tick, pulled back toward the close so it stays a wiggle.
 */
export function livePrice(s, i, ms, seed) {
  const base = decisionPrice(s, i);
  const n = Math.max(0, Math.floor(ms / EXEC.tickMs));
  if (!n) return base;
  const rand = seeded(`tick|${seed}|${s.id}|${i}`);
  const step = avgRange(s) * EXEC.tickFrac;
  let off = 0;
  for (let k = 0; k < n; k++) off = off * 0.85 + (rand() - 0.5) * 2 * step;
  return base + off;
}

/** Is there a news card on the candle you're trading into? */
export const newsAt = (s, i) => s.news.some((x) => x.at === i);

/** Direction of a fill: buys pay up, sells get hit. */
function fillSide(action, pos) {
  if (action.type === 'OPEN') return action.side === 'LONG' ? 1 : -1; // VOL sells the band: treat as a sell
  if (!pos) return 0;
  const long = pos.side === 'LONG' ? 1 : -1;
  if (action.type === 'ADD') return long;
  if (action.type === 'CUT' || action.type === 'CLOSE') return -long;
  if (action.type === 'FLIP') return -long;
  return 0;
}

/**
 * Turn an intended action into an executed one: fill price (live tick ± half-spread, wider on
 * news, worse again if front-run) and filled lots (partial above the threshold).
 * ctx: { ms (time into the decision window), seed, pos (current position), frontRun (bool) }.
 * Returns { action, cost } where action carries `fill` and possibly fewer `lots`.
 */
export function execute(s, i, action, { ms = 0, seed = '', pos = null, frontRun = false } = {}) {
  if (!action || action.type === 'HOLD') return { action: action ?? { type: 'HOLD' }, cost: null };
  const side = fillSide(action, pos);
  if (!side) return { action, cost: null };
  const mid = livePrice(s, i, ms, seed);
  const spread = EXEC.halfSpreadBbl * (newsAt(s, i) ? EXEC.newsSpreadMult : 1) + (frontRun ? EXEC.frontRunBbl : 0);
  const slip = perBblToUnit(spread, s.unit);
  const fill = mid + side * slip;
  const out = { ...action, fill };
  let partial = null;
  if (action.type === 'OPEN' && action.lots > EXEC.partialAbove) {
    const r = seeded(`fill|${seed}|${s.id}|${i}`)();
    const ratio = EXEC.partialMin + r * (EXEC.partialMax - EXEC.partialMin);
    const lots = EXEC.partialAbove + Math.floor((action.lots - EXEC.partialAbove) * ratio);
    if (lots < action.lots) { out.lots = lots; partial = { asked: action.lots, filled: lots }; }
  }
  return { action: out, cost: { mid, fill, slip, news: newsAt(s, i), frontRun, partial } };
}

/** Run a whole decision list through execution at a fixed tap time (bots, benchmarks). */
export function executeAll(s, decisions, { seed = '', ms = 0 } = {}) {
  // Positions are needed to know the fill side; replay them with the engine's act.
  return decisions.map((d, i) => (d ? execute(s, i, d, { ms, seed, pos: positionBefore(s, decisions, i) }).action : d));
}

function positionBefore(s, decisions, i) {
  let pos = null;
  for (let k = 0; k < i; k++) {
    const d = decisions[k];
    if (!d || d.type === 'HOLD') continue;
    if (d.type === 'OPEN' && !pos) pos = { side: d.side, lots: d.lots };
    else if (d.type === 'CLOSE') pos = null;
    else if (d.type === 'FLIP' && pos && pos.side !== 'VOL') pos = { ...pos, side: pos.side === 'LONG' ? 'SHORT' : 'LONG' };
  }
  return pos;
}

/**
 * HARD MODE: the same real session, a meaner tape. A seeded transform that keeps the final
 * close: choppier candles, a fakeout against the eventual move in the first candles, and a
 * news card that reverses. Labeled on screen so nobody mistakes it for the real path.
 */
export function hardenSession(s, seed) {
  const C = s.C;
  if (C < 4) return s;
  const rand = seeded(`hard|${seed}|${s.id}`);
  const r = avgRange(s);
  const dir = Math.sign(s.candles[C - 1].c - s.p0) || 1;
  const off = s.candles.map((_, k) => {
    if (k === C - 1) return 0; // the real final close stays
    const chop = (rand() - 0.5) * 2 * r * 0.9;
    const fake = k < 2 ? -dir * r * (k === 0 ? 1.4 : 0.9) : 0; // first move goes the wrong way
    return chop + fake;
  });
  let prev = s.p0;
  const candles = s.candles.map((c, k) => {
    const close = c.c + off[k];
    const o = prev;
    const h = Math.max(o, close, c.h + off[k]);
    const l = Math.min(o, close, c.l + off[k]);
    prev = close;
    return { ...c, o, h, l, c: close };
  });
  const at = Math.max(1, Math.floor(C / 3));
  const news = [...s.news, { at, text: dir > 0 ? 'Desk: "this rally is done" — reverses' : 'Desk: "the selloff is over" — reverses', major: true, fake: true }];
  return { ...s, candles, news, hard: true, label: `${s.label ?? ''} · HARD: path perturbed, final close real`.replace(/^ · /, '') };
}
