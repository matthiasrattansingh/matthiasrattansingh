// TWO-BOOK sessions: a paper session plus a physical exposure you can't close, only hedge.
// Pure functions. Physical side: LONG = you own barrels (gain when price rises),
// SHORT = you must buy them later (lose when price rises). Basis events move only the
// physical leg (your location vs the benchmark).
import { toPerBbl } from '../lib/scoring.js';
import { simulate, decisionPrice } from '../trade/engine.js';
import { seeded } from '../lib/format.js';

export const HEDGE_SIZES = [25, 50, 100, 250];
export const HEDGE_ADD = 25;
export const HEDGE_MAX_LOTS = 300;

const sign = (side) => (side === 'LONG' ? 1 : -1);

/** Physical P&L at a price and time t (in candles). */
export function physPnl(phys, s, price, t) {
  const flat = sign(phys.side) * toPerBbl(price - s.p0, s.unit) * phys.bbl;
  const basis = (phys.events ?? []).filter((e) => e.at <= t).reduce((a, e) => a + sign(phys.side) * e.usd * phys.bbl, 0);
  return flat + basis;
}

/** Physical P&L at each candle close (curve) and at the end. */
export function physCurve(phys, s) {
  return s.candles.map((c, i) => physPnl(phys, s, c.c, i + 1));
}

/** Signed paper exposure in bbl (+ long, - short; sell-vol counts as zero). */
export function paperBbl(pos) {
  if (!pos || pos.side === 'VOL') return 0;
  return (pos.side === 'LONG' ? 1 : -1) * pos.lots * 1000;
}

/** Hedge ratio: 1 = fully hedged, 0 = naked, negative = doubled the bet. */
export const hedgeRatio = (phys, pos) => (paperBbl(pos) ? -paperBbl(pos) / (sign(phys.side) * phys.bbl) : 0);

function maxDD(curve) {
  let peak = 0;
  let dd = 0;
  for (const v of [0, ...curve]) { peak = Math.max(peak, v); dd = Math.max(dd, peak - v); }
  return dd;
}

/**
 * HEDGE GRADE. S: combined drawdown small and a sensible hedge ratio · D: doubled the
 * bet (net negative ratio) or ran naked into a known event (a major news candle).
 */
export function hedgeGrade({ ratios, combined, naked, news = [] }) {
  const avg = ratios.reduce((a, r) => a + r, 0) / Math.max(1, ratios.length);
  const cDD = maxDD(combined);
  const nDD = Math.max(1, maxDD(naked));
  const rel = cDD / nDD;
  const nakedIntoEvent = news.some((n) => n.major && (ratios[n.at] ?? 0) < 0.2);
  let grade;
  if (avg < -0.1 || nakedIntoEvent) grade = 'D';
  else if (avg >= 0.6 && avg <= 1.2 && rel <= 0.35) grade = 'S';
  else if (avg >= 0.4 && avg <= 1.4 && rel <= 0.6) grade = 'A';
  else if (avg >= 0.25 && rel <= 0.85) grade = 'B';
  else grade = 'C';
  const why = grade === 'D'
    ? (avg < -0.1 ? 'Your futures added to the physical risk: you doubled the bet.' : 'You were naked when known news hit.')
    : grade === 'S' ? 'Hedged sensibly and kept the combined swings small.'
      : grade === 'A' ? 'Good hedge; a little more cover would have smoothed it.'
        : grade === 'B' ? 'Partly hedged; the physical book still drove your P&L.'
          : 'Barely hedged: the futures did little to protect the physical book.';
  return { grade, avg, combinedDD: cDD, nakedDD: nDD, rel, why };
}

/**
 * A bot's hedge decisions for a two-book session, from its agents.json rule.
 * Only reads prices up to each decision (no look-ahead).
 */
export function botHedgeDecisions(agent, phys, s, salt = '') {
  const rule = agent.physical?.hedge_ratio_at_load ?? { mode: 'fixed', ratio: 0 };
  const hedgeSide = phys.side === 'LONG' ? 'SHORT' : 'LONG';
  const lotsFor = (ratio) => Math.round((Math.abs(ratio) * phys.bbl) / 1000);
  const out = [];
  if (rule.mode === 'fixed') {
    const lots = lotsFor(rule.ratio);
    if (lots > 0) out[0] = { type: 'OPEN', side: hedgeSide, lots };
  } else if (rule.mode === 'random') {
    const r = rule.min + seeded(`${agent.id}|${s.id}|${salt}`)() * (rule.max - rule.min);
    const lots = lotsFor(r);
    if (lots > 0) out[0] = { type: 'OPEN', side: r >= 0 ? hedgeSide : phys.side, lots };
  } else if (rule.mode === 'after_adverse_move') {
    for (let i = 1; i < s.C; i++) {
      if (physPnl(phys, s, decisionPrice(s, i), i) < 0) { out[i] = { type: 'OPEN', side: hedgeSide, lots: lotsFor(rule.ratio) }; break; }
    }
  }
  return out;
}

/** Bots carry the same physical book; their strip number is physical + paper. */
export function botTwoBook(agent, phys, s, salt) {
  const sim = simulate({ ...s, maxLots: HEDGE_MAX_LOTS }, botHedgeDecisions(agent, phys, s, salt));
  const pc = physCurve(phys, s);
  return { curve: sim.curve.map((v, i) => v + pc[i]), final: sim.final + pc[pc.length - 1], paper: sim.final, phys: pc[pc.length - 1] };
}
