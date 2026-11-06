// TRADE engine: pure functions, no React. A session is a run of candles; you
// make one decision before the first candle and one after each candle.
// One lot = 1,000 bbl, so $1/bbl = $1,000 per lot (products: $/gal × 42).
import { toPerBbl } from '../lib/scoring.js';
import { seeded } from '../lib/format.js';

export const LOT_BBL = 1_000;
export const MAX_LOTS = 10;

/** Card (callit or spread) -> session the engine and chart can run. */
export function buildSession(card) {
  const s = card.session;
  const spread = card.type === 'spread';
  const history = spread ? card.spread.series : card.series;
  const p0 = history[history.length - 1];
  const unit = spread ? '$/bbl' : card.unit;
  const bandPct = card.flatBandPct ?? 1.5;
  return {
    id: card.id,
    card,
    spread,
    unit,
    instrument: spread ? card.title : card.instrument,
    date: spread ? card.spread.date : card.decision.date,
    open: s.open ?? card.headline,
    label: s.label,
    simulated: s.simulated,
    history,
    p0,
    candles: s.candles.map(([o, h, l, c, t]) => ({ o, h, l, c, t })),
    C: s.candles.length,
    news: s.news ?? [],
    bandBbl: spread ? 0 : toPerBbl((Math.abs(p0) * bandPct) / 100, unit),
    sides: spread ? { LONG: 'WIDEN', SHORT: 'NARROW' } : { LONG: 'LONG', SHORT: 'SHORT', VOL: 'SELL VOL' },
  };
}

/** Price at the moment decision i is made: before candle 0 it's the last close. */
export const decisionPrice = (s, i) => (i === 0 ? s.p0 : s.candles[i - 1].c);

/** Mark a position to market. t is time in candles (0..C), fractional mid-candle. */
export function pnlOf(pos, price, t, s) {
  if (!pos) return 0;
  const d = toPerBbl(price - pos.entry, s.unit);
  if (pos.side === 'LONG') return d * LOT_BBL * pos.lots;
  if (pos.side === 'SHORT') return -d * LOT_BBL * pos.lots;
  // SELL VOL: earn the band as time passes (theta), pay for any distance from entry.
  const span = s.C - pos.t0;
  const theta = span > 0 ? Math.min(1, Math.max(0, (t - pos.t0) / span)) : 1;
  return (s.bandBbl * theta - Math.abs(d)) * LOT_BBL * pos.lots;
}

export const emptyBook = () => ({ pos: null, realized: 0 });

/**
 * Apply one decision. action: { type: 'OPEN', side, lots } | { type: 'HOLD' |
 * 'ADD' | 'CUT' | 'CLOSE' | 'FLIP' }. Returns a new book.
 */
export function act(book, action, price, t, s) {
  const { pos } = book;
  switch (action.type) {
    case 'OPEN':
      if (pos) return book;
      return { ...book, pos: { side: action.side, lots: action.lots, entry: price, t0: t } };
    case 'ADD': {
      const cap = s.maxLots ?? MAX_LOTS;
      if (!pos || pos.lots >= cap) return book;
      const add = Math.min(s.addStep ?? 1, cap - pos.lots); // two-book hedgers add in blocks
      if (pos.side === 'VOL') {
        // Re-strike: bank what the vol position made so far, sell more at today's price.
        return { realized: book.realized + pnlOf(pos, price, t, s), pos: { side: 'VOL', lots: pos.lots + add, entry: price, t0: t } };
      }
      const lots = pos.lots + add;
      return { ...book, pos: { ...pos, lots, entry: (pos.entry * pos.lots + price) / lots } };
    }
    case 'CUT': {
      if (!pos) return book;
      const k = Math.floor(pos.lots / 2);
      if (k === 0) return act(book, { type: 'CLOSE' }, price, t, s);
      return { realized: book.realized + (pnlOf(pos, price, t, s) * k) / pos.lots, pos: { ...pos, lots: pos.lots - k } };
    }
    case 'CLOSE':
      if (!pos) return book;
      return { realized: book.realized + pnlOf(pos, price, t, s), pos: null };
    case 'FLIP': {
      if (!pos || pos.side === 'VOL') return book;
      const closed = act(book, { type: 'CLOSE' }, price, t, s);
      return act(closed, { type: 'OPEN', side: pos.side === 'LONG' ? 'SHORT' : 'LONG', lots: pos.lots }, price, t, s);
    }
    default:
      return book;
  }
}

export const equityOf = (book, price, t, s) => book.realized + pnlOf(book.pos, price, t, s);

/**
 * Run a whole session from a list of decisions (index i = decision before candle i).
 * Missing decisions are HOLD. Returns per-candle session P&L and what you held.
 */
export function simulate(s, decisions) {
  let book = emptyBook();
  const curve = [];
  const held = [];
  let prev = 0;
  const perCandle = [];
  for (let i = 0; i < s.C; i++) {
    book = act(book, decisions[i] ?? { type: 'HOLD' }, decisionPrice(s, i), i, s);
    held.push(book.pos ? book.pos.side : null);
    const eq = equityOf(book, s.candles[i].c, i + 1, s);
    perCandle.push(eq - prev);
    prev = eq;
    curve.push(eq);
  }
  return { curve, perCandle, held, final: curve[curve.length - 1] ?? 0 };
}

/** 🟩 position made money that candle · 🟥 lost · 🟦 stood aside. */
export function gradeGrid(sim) {
  return sim.held.map((side, i) => (!side ? '🟦' : sim.perCandle[i] > 0 ? '🟩' : '🟥')).join('');
}

/** Value of each non-HOLD decision: final P&L minus the P&L if it had been HOLD. */
export function decisionValues(s, decisions) {
  const base = simulate(s, decisions).final;
  return decisions.map((d, i) => {
    if (!d || d.type === 'HOLD') return null;
    const alt = [...decisions];
    alt[i] = { type: 'HOLD' };
    return { i, action: d, value: base - simulate(s, alt).final };
  }).filter(Boolean);
}

/** Buy-and-hold benchmarks with 2 lots. */
export function benchmarks(s) {
  const run = (side) => simulate(s, [{ type: 'OPEN', side, lots: 2 }]).final;
  return { long: run('LONG'), short: run('SHORT') };
}

// ---------- the desk: bots' decisions from their personalities ----------

function trend(xs, n) {
  const a = xs[Math.max(0, xs.length - 1 - n)];
  return xs[xs.length - 1] - a;
}

export function botDecisions(botId, s, salt = '') {
  const rand = seeded(`${botId}|${s.id}|${salt}`);
  const closes = (i) => [...s.history, ...s.candles.slice(0, i).map((c) => c.c)];
  const pre = trend(s.history, 5) >= 0 ? 'LONG' : 'SHORT';
  const opp = (x) => (x === 'LONG' ? 'SHORT' : 'LONG');
  const out = [];
  if (botId === 'mo' || botId === 'carla') {
    // Mo rides the last few bars; Carla fades them. Re-check every 3 candles.
    let side = botId === 'mo' ? pre : opp(pre);
    out[0] = { type: 'OPEN', side, lots: 2 };
    for (let i = 3; i < s.C; i += 3) {
      const t = trend(closes(i), 3) >= 0 ? 'LONG' : 'SHORT';
      const want = botId === 'mo' ? t : opp(t);
      if (want !== side) { out[i] = { type: 'FLIP' }; side = want; }
    }
  } else if (botId === 'quinn') {
    // A model that gets the session's direction right ~60% of the time, sized by confidence.
    const move = s.candles[s.C - 1].c - s.p0;
    const flatish = !s.spread && Math.abs(toPerBbl(move, s.unit)) < s.bandBbl;
    const best = flatish ? 'VOL' : move >= 0 ? 'LONG' : 'SHORT';
    const options = s.spread ? ['LONG', 'SHORT'] : ['LONG', 'SHORT', 'VOL'];
    const right = rand() < 0.6;
    const wrong = options.filter((o) => o !== best);
    const side = right ? best : wrong[Math.floor(rand() * wrong.length)];
    const r = rand();
    out[0] = { type: 'OPEN', side, lots: r < 0.4 ? 1 : r < 0.85 ? 2 : 5 };
  } else {
    // Dan: coin flip, max size, and adds after every losing candle. Never cuts.
    const side = rand() < 0.5 ? 'LONG' : 'SHORT';
    out[0] = { type: 'OPEN', side, lots: 5 };
    for (let i = 1; i < s.C; i++) {
      const c = s.candles[i - 1];
      const lost = side === 'LONG' ? c.c < c.o : c.c > c.o;
      if (lost) out[i] = { type: 'ADD' };
    }
  }
  return out;
}
