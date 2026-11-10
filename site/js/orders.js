// Pure order-fill rules. A working order is only ever tested against a bar that was
// revealed AFTER the order was placed.
import { roundTo } from './instruments.js';

/**
 * Market order fill: buys lift the ask, sells hit the bid, then `slip` against you.
 */
export function marketFillPrice(side, quote, slip, tick) {
  return side === 'BUY' ? roundTo(quote.ask + slip, tick) : roundTo(quote.bid - slip, tick);
}

/**
 * Test a working LMT or STP order against one newly revealed bar.
 * Returns the fill price, or null if the bar did not reach it.
 *
 * LMT: fills only when the bar TRADES THROUGH the limit (buy: low < limit,
 *      sell: high > limit). Touching the price is not enough (you would be at the
 *      back of the queue). Fill at the limit, or at the open if the bar gapped
 *      through it (price improvement). No slippage on limits.
 * STP: triggers when the bar reaches the stop (buy: high >= stop, sell: low <= stop).
 *      Fills at the stop, or the open if it gapped past, then `slip` against you.
 */
export function barFillPrice(order, bar, slip, tick) {
  const { side, type, price } = order;
  if (type === 'LMT') {
    if (side === 'BUY' && bar.l < price) return roundTo(Math.min(price, bar.o), tick);
    if (side === 'SELL' && bar.h > price) return roundTo(Math.max(price, bar.o), tick);
    return null;
  }
  if (type === 'STP') {
    if (side === 'BUY' && bar.h >= price) return roundTo(Math.max(price, bar.o) + slip, tick);
    if (side === 'SELL' && bar.l <= price) return roundTo(Math.min(price, bar.o) - slip, tick);
    return null;
  }
  return null;
}
