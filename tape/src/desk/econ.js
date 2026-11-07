// DESK economics: the math behind every physical idea card. Pure functions only.
//
// One generic model covers all five idea types. An idea is a set of legs on scenario series
// (prices or differentials, $/bbl; freight in $/day; gas in $/MMBtu), each fixed at ENTRY or
// marked at EXIT, plus costs (fixed, per barrel, per day, freight, financing):
//
//   P&L(t) = Σ legs  sign(leg) × price(series, entry or t) × qty  −  costs(t − entry)
//   sign: SELL +1 (cash in), BUY −1 (cash out)
//
//   location arb   BUY origin @entry, SELL destination @exit, pay freight + fees
//   storage        SELL the carry (fwd − spot) @entry, BUY it back @exit, pay rent + financing daily
//   basis          BUY (or SELL) a differential @entry, unwind @exit (futures hedge implied)
//   quality        BUY light-sweet vs heavy-sour spread @entry, unwind @exit
//   freight        BUY charter days @entry rate, SELL (relet) @exit rate
//
// Every number on an idea card comes from here, so the card and the P&L can never disagree.

export const TYPES = {
  location_arb: 'Location arb',
  storage: 'Storage / carry',
  basis: 'Basis trade',
  quality: 'Quality spread',
  freight: 'Freight play',
};

/** Series value on day d (clamped to the series). */
export function valueAt(sc, key, d) {
  const s = sc.series[key];
  if (!s) throw new Error(`unknown series ${key}`);
  const v = s.values;
  return v[Math.max(0, Math.min(v.length - 1, d))];
}

/** Freight in $/bbl: a day rate for the voyage days, spread over the cargo. */
export const freightPerBbl = (dayRate, days, bbl) => (dayRate * days) / bbl;

/**
 * Location arb on paper: buy at origin, sell at destination, pay to move it.
 * Returns the spread, the all-in cost per barrel, the margin and the break-even spread.
 */
export function arbBreakeven({ buy, sell, transport, fees = 0, lossPct = 0 }) {
  const spread = sell - buy;
  const loss = buy * lossPct; // in-transit loss / evaporation priced at the purchase
  const cost = transport + fees + loss;
  return { spread, cost, margin: spread - cost, breakeven: cost, open: spread > cost };
}

/**
 * Cash-and-carry: buy spot, store it, sell the forward. Covered only if the carry pays rent,
 * financing on the barrels and the in/out fees.
 */
export function carryCoverage({ spot, forward, months, rent, financePct, inout = 0 }) {
  const carry = forward - spot;
  const rentCost = rent * months;
  const financing = (spot * financePct * months) / 12;
  const cost = rentCost + financing + inout;
  return { carry, rent: rentCost, financing, inout, cost, net: carry - cost, covers: carry > cost, breakeven: cost };
}

/** Differential P&L: long the diff gains when it rises; short gains when it falls. */
export function diffPnl({ side, entry, exit, bbl, costs = 0 }) {
  const dir = side === 'long' ? 1 : -1;
  return dir * (exit - entry) * bbl - costs;
}

const sign = (leg) => (leg.side === 'sell' ? 1 : -1);
const qtyOf = (idea, leg) => leg.qty ?? idea.bbl;

/**
 * Resolve an idea's costs to dollars for a holding period of `days`.
 * Cost kinds: { usd } fixed · { usd_bbl } per barrel · { per_day } $/day ·
 * { freight: { rate (series key or number), days } } · { financing: { pct, on (series key) } }.
 */
export function costLines(sc, idea, entry, days) {
  return idea.costs.map((c) => {
    let usd = 0;
    let calc = '';
    if (c.usd != null) { usd = c.usd; calc = `$${Math.round(c.usd).toLocaleString()}`; }
    if (c.usd_bbl != null) { usd = c.usd_bbl * idea.bbl; calc = `$${c.usd_bbl.toFixed(2)}/bbl × ${(idea.bbl / 1000).toFixed(0)}k`; }
    if (c.per_day != null) { usd = c.per_day * days; calc = `$${Math.round(c.per_day).toLocaleString()}/day × ${days}d`; }
    if (c.freight) {
      const rate = typeof c.freight.rate === 'string' ? valueAt(sc, c.freight.rate, entry) : c.freight.rate;
      usd = rate * c.freight.days;
      calc = `$${Math.round(rate).toLocaleString()}/day × ${c.freight.days}d = $${freightPerBbl(rate, c.freight.days, idea.bbl).toFixed(2)}/bbl`;
    }
    if (c.financing) {
      const px = valueAt(sc, c.financing.on, entry);
      usd = (px * idea.bbl * c.financing.pct * days) / 365;
      calc = `${(c.financing.pct * 100).toFixed(1)}%/yr on $${px.toFixed(2)} × ${days}d`;
    }
    return { label: c.label, usd, calc };
  });
}

export const totalCosts = (sc, idea, entry, days) => costLines(sc, idea, entry, days).reduce((s, c) => s + c.usd, 0);

/** Days the idea is held when marked on day t (never past its horizon). */
export const heldDays = (idea, entry, t) => Math.max(0, Math.min(t, entry + idea.horizon) - entry);

/** Leg cash flows, with exit legs marked on day t. */
export function legValues(sc, idea, entry, t) {
  const exitDay = Math.min(t, entry + idea.horizon);
  return idea.legs.map((leg) => {
    const day = leg.at === 'entry' ? entry : exitDay;
    const price = valueAt(sc, leg.series, day);
    return { ...leg, day, price, qty: qtyOf(idea, leg), cash: sign(leg) * price * qtyOf(idea, leg) };
  });
}

/** Mark-to-market P&L of an idea opened on `entry`, marked on day t. */
export function ideaPnl(sc, idea, entry, t) {
  const legs = legValues(sc, idea, entry, t);
  const days = heldDays(idea, entry, t);
  return legs.reduce((s, l) => s + l.cash, 0) - totalCosts(sc, idea, entry, days);
}

/**
 * The card's headline economics, from data up to the entry day only:
 *  - edge: P&L at the horizon if every exit leg stays at today's price
 *  - breakeven: the exit-leg price that makes the horizon P&L zero (for a single exit leg)
 */
export function ideaEconomics(sc, idea, entry) {
  const H = idea.horizon;
  const costs = costLines(sc, idea, entry, H);
  const cost = costs.reduce((s, c) => s + c.usd, 0);
  const legs = idea.legs.map((leg) => ({ ...leg, price: valueAt(sc, leg.series, entry), qty: qtyOf(idea, leg) }));
  const flatCash = legs.reduce((s, l) => s + sign(l) * l.price * l.qty, 0);
  const edge = flatCash - cost;
  const exitLegs = legs.filter((l) => l.at === 'exit');
  let breakeven = null;
  if (exitLegs.length === 1) {
    const x = exitLegs[0];
    const fixed = legs.filter((l) => l !== x).reduce((s, l) => s + sign(l) * l.price * l.qty, 0);
    // sign(x)·p·qty + fixed − cost = 0  →  p = (cost − fixed) / (sign·qty)
    breakeven = { series: x.series, label: x.label, value: (cost - fixed) / (sign(x) * x.qty), side: x.side };
  }
  return { legs, costs, cost, costPerBbl: cost / idea.bbl, edge, edgePerBbl: edge / idea.bbl, breakeven };
}

/** Settle an idea: P&L at its horizon (or an earlier close day). */
export function settle(sc, idea, entry, close = entry + idea.horizon) {
  const t = Math.min(close, entry + idea.horizon, sc.D - 1);
  return { day: t, pnl: ideaPnl(sc, idea, entry, t) };
}
