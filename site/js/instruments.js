// Instruments: an outright product, or a spread built from matched legs.
import { PRODUCTS, SPREADS, ACCOUNT } from './config.js';

export function roundTo(value, tick) {
  const decimals = Math.max(0, Math.round(-Math.log10(tick)) + 1);
  return Number((Math.round(value / tick) * tick).toFixed(decimals));
}

export function getInstrument(id, products = PRODUCTS, spreads = SPREADS) {
  if (products[id]) {
    const p = products[id];
    return {
      id, name: p.name, kind: 'outright',
      legs: [{ product: id, ratio: 1 }],
      tick: p.tick, decimals: p.decimals, multiplier: p.multiplier,
    };
  }
  const s = spreads[id];
  if (!s) throw new Error(`Unknown instrument ${id}`);
  const legSpecs = s.legs.map((l) => products[l.product]);
  const mult = legSpecs[0].multiplier;
  if (legSpecs.some((p) => p.multiplier !== mult)) throw new Error('spread legs must share a contract size');
  const tick = Math.min(...legSpecs.map((p) => p.tick));
  return {
    id, name: s.name, kind: 'spread', legs: s.legs, tick,
    decimals: Math.max(...legSpecs.map((p) => p.decimals)),
    multiplier: mult, spreadMarginFactor: s.spreadMarginFactor,
  };
}

/** Bid/ask for one product around its last trade. bid = last - floor(n/2) ticks, ask = bid + n ticks. */
export function productQuote(productId, last, products = PRODUCTS) {
  const p = products[productId];
  const bid = roundTo(last - Math.floor(p.spreadTicks / 2) * p.tick, p.tick);
  const ask = roundTo(bid + p.spreadTicks * p.tick, p.tick);
  return { last: roundTo(last, p.tick), bid, ask };
}

/** Instrument quote from leg last prices: buying a spread lifts the long legs' asks and hits the short legs' bids. */
export function instrumentQuote(inst, lastByProduct, products = PRODUCTS) {
  let bid = 0, ask = 0, last = 0;
  for (const leg of inst.legs) {
    const q = productQuote(leg.product, lastByProduct[leg.product], products);
    last += leg.ratio * q.last;
    if (leg.ratio > 0) { bid += leg.ratio * q.bid; ask += leg.ratio * q.ask; }
    else { bid += leg.ratio * q.ask; ask += leg.ratio * q.bid; }
  }
  return { last: roundTo(last, inst.tick), bid: roundTo(bid, inst.tick), ask: roundTo(ask, inst.tick) };
}

/** Slippage in instrument price units: slippageTicks on every leg. */
export function slippage(inst, products = PRODUCTS, ticks = ACCOUNT.slippageTicks) {
  return inst.legs.reduce((s, leg) => s + Math.abs(leg.ratio) * ticks * products[leg.product].tick, 0);
}

/** Fees for one side of `qty` instrument units (each leg is charged). */
export function feesFor(inst, qty, fee = ACCOUNT.feePerContractPerSide) {
  const legContracts = inst.legs.reduce((s, l) => s + Math.abs(l.ratio), 0);
  return Math.abs(qty) * legContracts * fee;
}

/** Dollar P&L of moving from entry to exit price on a signed quantity. */
export function pnlDollars(inst, signedQty, entry, exit) {
  return (exit - entry) * signedQty * inst.multiplier;
}

/** Margin estimate for |qty| units at current leg prices. */
export function marginFor(inst, qty, lastByProduct, products = PRODUCTS) {
  let m = 0;
  for (const leg of inst.legs) {
    const p = products[leg.product];
    m += Math.abs(leg.ratio) * Math.abs(qty) * lastByProduct[leg.product] * p.multiplier * p.marginPct;
  }
  if (inst.kind === 'spread') m *= inst.spreadMarginFactor;
  return m;
}
