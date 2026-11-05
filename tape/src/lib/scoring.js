// Pure scoring rules. No React, no storage: easy to test and tweak.

export const GAL_PER_BBL = 42;

/** Convert a price move to $/bbl so moves in different units compare. */
export function toPerBbl(move, unit) {
  if (unit === '$/gal') return move * GAL_PER_BBL;
  if (unit === '¢/gal') return (move / 100) * GAL_PER_BBL;
  return move; // $/bbl (and $/MMBtu is shown as-is)
}

/** UP / DOWN / FLAT given a start price, end price and a flat band in %. */
export function classifyMove(from, to, flatBandPct = 1.5) {
  const pct = from !== 0 ? ((to - from) / Math.abs(from)) * 100 : 0;
  if (Math.abs(pct) < flatBandPct) return { dir: 'FLAT', pct };
  return { dir: to > from ? 'UP' : 'DOWN', pct };
}

const CALL_TO_DIR = { LONG: 'UP', SHORT: 'DOWN', FLAT: 'FLAT' };

/**
 * CALL IT: right direction = points scaled by conviction (1-3) and move size.
 * Wrong = you lose, also scaled by conviction and size (that's trading).
 */
export function scoreCallIt(card, call, conviction) {
  const { decision, outcome, unit = '$/bbl', flatBandPct = 1.5 } = card;
  const move = outcome.price - decision.price;
  const moveBbl = toPerBbl(move, unit);
  const { dir, pct } = classifyMove(decision.price, outcome.price, flatBandPct);
  const correct = CALL_TO_DIR[call] === dir;
  const size = 1 + Math.min(Math.abs(moveBbl), 30) / 10; // 1.0x to 4.0x
  let points;
  if (correct) points = dir === 'FLAT' ? 15 * conviction : Math.round(10 * conviction * size);
  else points = -Math.round(5 * conviction * size);
  return { correct, points, move, moveBbl, pct, actual: dir };
}

/** SPREAD SNAP: WIDEN or NARROW, bonus for bigger moves. */
export function scoreSpread(card, call) {
  const from = card.spread.now;
  const to = card.outcome.spread;
  const change = to - from;
  const actual = Math.abs(to) > Math.abs(from) ? 'WIDEN' : 'NARROW';
  const correct = call === actual;
  const size = 1 + Math.min(Math.abs(toPerBbl(change, card.unit)), 20) / 10;
  const points = correct ? Math.round(15 * size) : -Math.round(5 * size);
  return { correct, points, change, actual };
}

/** CONCEPT BITE: one multiple choice. */
export function scoreConcept(card, choiceIndex) {
  const correct = choiceIndex === card.question.answer;
  return { correct, points: correct ? 10 : 0 };
}

/** XP is never negative: you always learn something by showing up. */
export function xpFor(points) {
  return Math.max(points, 0) + 2;
}
