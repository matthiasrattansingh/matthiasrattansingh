// The trading book: turns a call into play-money P&L.
// One lot = one futures contract = 1,000 bbl (ULSD/RBOB: 42,000 gal, also 1,000 bbl),
// so a $1/bbl move is $1,000 per lot, the same as the real contracts.
import { toPerBbl, classifyMove } from './scoring.js';
import { botCall, BOTS } from './rivals.js';

export const START_BANKROLL = 100_000;
export const BBL_PER_LOT = 1_000;
export const LOT_SIZES = [1, 2, 5];
export const CONCEPT_BONUS = 2_500;

/** Win streak -> payout multiplier on winning trades. */
export function comboMultiplier(combo) {
  if (combo >= 5) return 2;
  if (combo >= 3) return 1.5;
  if (combo >= 2) return 1.25;
  return 1;
}

/**
 * Raw P&L of a CALL IT trade. FLAT means selling volatility: you collect
 * the band if price stays inside it and pay the excess if it breaks out.
 */
export function pnlCallIt(card, call, lots) {
  const moveBbl = toPerBbl(card.outcome.price - card.decision.price, card.unit);
  if (call === 'LONG') return moveBbl * BBL_PER_LOT * lots;
  if (call === 'SHORT') return -moveBbl * BBL_PER_LOT * lots;
  const bandBbl = toPerBbl((Math.abs(card.decision.price) * (card.flatBandPct ?? 1.5)) / 100, card.unit);
  return (bandBbl - Math.abs(moveBbl)) * BBL_PER_LOT * lots;
}

/** SPREAD SNAP: WIDEN = long the spread, NARROW = short it. */
export function pnlSpread(card, call, lots) {
  const change = toPerBbl(card.outcome.spread - card.spread.now, card.unit);
  return (call === 'WIDEN' ? 1 : -1) * change * BBL_PER_LOT * lots;
}

function rawPnl(card, call, lots) {
  return card.type === 'spread' ? pnlSpread(card, call, lots) : pnlCallIt(card, call, lots);
}

/** What actually happened, for the bots' "perfect hindsight" picks. */
export function bestCall(card) {
  if (card.type === 'spread') return card.outcome.result;
  const { dir } = classifyMove(card.decision.price, card.outcome.price, card.flatBandPct ?? 1.5);
  return dir === 'UP' ? 'LONG' : dir === 'DOWN' ? 'SHORT' : 'FLAT';
}

/**
 * Settle one answered card. `answer` is what the card component reported
 * ({ call, lots } for trades, { correct } for concepts). `combo` is your
 * current win streak. Returns everything the reveal and the ledger need.
 */
export function settle(card, answer, combo, salt) {
  if (card.type === 'concept') {
    const mult = answer.correct ? comboMultiplier(combo) : 1;
    const pnl = answer.correct ? Math.round(CONCEPT_BONUS * mult) : 0;
    return { pnl, base: answer.correct ? CONCEPT_BONUS : 0, mult, win: answer.correct, bots: [] };
  }
  const base = Math.round(rawPnl(card, answer.call, answer.lots));
  const win = base > 0;
  const mult = win ? comboMultiplier(combo) : 1;
  const pnl = Math.round(base * mult);
  const bots = BOTS.map((b) => {
    const { call, lots } = botCall(b, card, bestCall(card), salt);
    return { id: b.id, call, lots, pnl: Math.round(rawPnl(card, call, lots)) };
  });
  return { pnl, base, mult, win, bots };
}

export function fmtMoney(v, { sign = true, compact = false } = {}) {
  const abs = Math.abs(v);
  const body = compact && abs >= 10_000
    ? `${(abs / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`
    : abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const s = v > 0 ? (sign ? '+' : '') : v < 0 ? '−' : '';
  return `${s}$${body}`;
}
