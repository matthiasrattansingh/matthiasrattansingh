// TANK engine: barrels in a tank at Cushing, weekly steps. Pure functions.
// Cash-and-carry = buy spot (contract 1) + sell a later month; the spread is locked,
// rent and financing accrue every week, and at expiry the barrels are delivered
// into the short futures (spot and futures converge), so you realize the locked spread.
import { landSched, schedState, schedUsd } from './scheduler.js';

const WEEK_DAYS = 7;
const MONTH_DAYS = 30.4;

export function buildTank(card, econ) {
  const t = econ.tank;
  return {
    id: card.id,
    card,
    W: card.weekly.length,
    weeks: card.weekly,
    capacity: card.capacity_bbl ?? t.capacity_bbl.value,
    rent: card.rent_usd_bbl_month ?? t.rent_cushing_usd_bbl_month.value,
    finance: card.financing_pct_year ?? t.financing_pct_year.value,
    safety: t.margin_of_safety_usd_bbl_month.value,
  };
}

/** Price of a delivery month in week w (null if it's not on the 4-month curve). */
export function priceOf(t, w, month) {
  const i = t.weeks[w].months.indexOf(month);
  return i >= 0 ? t.weeks[w].curve[i] : null;
}

export const spot = (t, w) => t.weeks[w].curve[0];

/** Months between two delivery months ("2020-06" - "2020-05" = 1). */
export function monthsBetween(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

/** What one month of carry costs per bbl: rent + financing on the spot price. */
export const carryCost = (t, w) => t.rent + (spot(t, w) * t.finance) / 12;

/** The carry on offer this week for selling month index k (1..3) against spot. */
export function carryOffer(t, w, k) {
  const wk = t.weeks[w];
  const spread = wk.curve[k] - wk.curve[0];
  const months = Math.max(1, monthsBetween(wk.months[0], wk.months[k]));
  return { k, month: wk.months[k], price: wk.curve[k], spread, perMonth: spread / months, months, cost: carryCost(t, w) * months };
}

/**
 * The spot market for barrels to put in the tank this week, from the real EIA Cushing level:
 * the fuller Cushing is vs working capacity, the more desperate sellers are (barrels landing
 * with no home), the lower the fair differential (modeled), and past the configured ratio
 * a seller's "their clock" shows.
 */
export function spotMarket(t, w, econ) {
  const level = t.weeks[w].eia?.cushing_level_mmbbl;
  const cap = t.card.cushing_working_capacity_mmbbl ?? econ.tank.cushing_working_capacity_mmbbl.value;
  if (level == null) return { fair: 0, desperation: 0.3, theirClock: null, ratio: null };
  const ratio = level / cap;
  const desperation = Math.max(0, Math.min(1, (ratio - 0.5) * 2.2));
  const fair = Math.round(-(desperation - 0.3) * 0.6 * 100) / 100;
  const clock = ratio >= econ.negotiation.seller_clock_ratio.value
    ? { days: 3 + (w % 3), text: `Cushing ${Math.round(ratio * 100)}% full; their barrels land with no tank` }
    : null;
  return { fair, desperation, theirClock: clock, ratio, level };
}

export function newTankState() {
  return { week: 0, inv: 0, buy: 0, hedge: null, realized: 0, rent: 0, financing: 0, locked: 0, enteredWeek: null,
    log: [], rows: [], done: false, rolls: 0, ...schedState() };
}

function close(t, st, w, why) {
  if (!st.inv) return st;
  const s = spot(t, w);
  const hp = st.hedge ? (priceOf(t, w, st.hedge.month) ?? s) : null;
  const spotGain = (s - st.buy) * st.inv;
  const hedgeGain = st.hedge ? (st.hedge.entry - hp) * st.hedge.bbl : 0;
  return {
    ...st,
    realized: st.realized + spotGain + hedgeGain,
    inv: 0, buy: 0, hedge: null,
    log: [...st.log, { week: w, text: `${why}: ${(st.inv / 1000).toFixed(0)}k bbl at $${s.toFixed(2)}${st.hedge ? `, hedge closed at $${hp.toFixed(2)}` : ''}`, type: 'close' }],
  };
}

/** Actions: { type: 'CARRY', k, bbl } | { type: 'ROLL' } | { type: 'SELL' } | { type: 'WAIT' } */
export function stepTank(t, st, a) {
  if (st.done) return st;
  const w = st.week;
  if (a.type === 'CARRY') {
    if (st.inv > 0 || a.k < 1 || a.k > 3) return st;
    const bbl = Math.min(a.bbl ?? t.capacity, t.capacity);
    const o = carryOffer(t, w, a.k);
    // A negotiated spot purchase pays the index plus an agreed differential (a.diff).
    const diff = a.diff ?? 0;
    const buy = spot(t, w) + diff;
    const vs = diff ? ` (${diff > 0 ? '+' : ''}${diff.toFixed(2)} vs index)` : '';
    return {
      ...st, inv: bbl, buy, hedge: { month: o.month, entry: o.price, bbl },
      locked: st.locked + (o.spread - diff) * bbl, enteredWeek: w, buyDiff: diff, buyNego: a.nego ?? null,
      log: [...st.log, { week: w, text: `Bought ${(bbl / 1000).toFixed(0)}k bbl at $${buy.toFixed(2)}${vs}, sold ${o.month} at $${o.price.toFixed(2)} (+$${(o.spread - diff).toFixed(2)})`, type: 'carry' }],
    };
  }
  if (a.type === 'ROLL') {
    if (!st.hedge) return st;
    const wk = t.weeks[w];
    const i = wk.months.indexOf(st.hedge.month);
    if (i < 0 || i >= 3) return st;
    const exit = wk.curve[i];
    const nextMonth = wk.months[i + 1];
    const gain = (st.hedge.entry - exit) * st.hedge.bbl;
    return {
      ...st, realized: st.realized + gain, rolls: st.rolls + 1,
      locked: st.locked + (wk.curve[i + 1] - exit) * st.hedge.bbl,
      hedge: { month: nextMonth, entry: wk.curve[i + 1], bbl: st.hedge.bbl },
      log: [...st.log, { week: w, text: `Rolled hedge ${st.hedge.month} → ${nextMonth} (+$${(wk.curve[i + 1] - exit).toFixed(2)})`, type: 'roll' }],
    };
  }
  if (a.type === 'SELL') {
    const out = close(t, st, w, 'Sold inventory');
    return w >= t.W - 1 ? { ...out, done: true } : out;
  }
  // WAIT: a week passes. Rent and financing accrue on what's in the tank.
  const rentWk = st.inv * t.rent * (WEEK_DAYS / MONTH_DAYS);
  const finWk = st.inv * spot(t, w) * t.finance * (WEEK_DAYS / 365);
  const s2 = { ...st, rent: st.rent + rentWk, financing: st.financing + finWk };
  s2.rows = [...st.rows, { week: w, date: t.weeks[w].date, inv: st.inv, rent: rentWk, financing: finWk,
    frontSpread: t.weeks[w].curve[1] - t.weeks[w].curve[0], costPerMonth: carryCost(t, w) }];
  // Expiry: if the hedge is the front month and it rolls off before next week, deliver into it.
  let out = s2;
  if (out.hedge && w + 1 < t.W && t.weeks[w].months[0] === out.hedge.month && t.weeks[w + 1].months[0] !== out.hedge.month) {
    out = close(t, out, w, 'Delivered into futures at expiry');
  }
  if (w + 1 >= t.W) return landSched({ ...close(t, out, w, 'Session end: sold'), done: true }, Infinity);
  return landSched({ ...out, week: w + 1, log: [...out.log] }, w + 1); // consequences due this week land
}

/** Running P&L: realized + open legs - rent - financing. */
export function tankPnl(t, st) {
  const w = Math.min(st.week, t.W - 1);
  let open = 0;
  if (st.inv) {
    open += (spot(t, w) - st.buy) * st.inv;
    if (st.hedge) open += (st.hedge.entry - (priceOf(t, w, st.hedge.month) ?? spot(t, w))) * st.hedge.bbl;
  }
  return st.realized + open - st.rent - st.financing + schedUsd(st, st.done);
}

/** The debrief lines: carry locked vs rent and financing paid, plus whatever the unwind added. */
export function tankSplit(t, st) {
  const total = tankPnl(t, st);
  const sched = schedUsd(st, st.done);
  const unwind = total + st.rent + st.financing - st.locked - sched;
  return { locked: st.locked, unwind, rent: -st.rent, financing: -st.financing, sched, total };
}

export function runTank(t, actions) {
  let st = newTankState();
  for (const a of actions) st = stepTank(t, st, a);
  let guard = 0;
  while (!st.done && guard++ < 100) st = stepTank(t, st, { type: 'WAIT' });
  return st;
}

/** Best with hindsight: carry from week w selling month k, exit by selling on week e (or deliver/end). */
export function bestTank(t) {
  let best = { pnl: 0, plan: 'stay empty (no carry paid)', actions: [] };
  for (let w = 0; w < t.W - 1; w++) {
    for (let k = 1; k <= 3; k++) {
      for (let e = w + 1; e <= t.W; e++) {
        const acts = [...Array(w).fill({ type: 'WAIT' }), { type: 'CARRY', k, bbl: t.capacity }, ...Array(e - w).fill({ type: 'WAIT' })];
        if (e < t.W) acts.push({ type: 'SELL' });
        const st = runTank(t, acts);
        const pnl = tankPnl(t, st);
        if (pnl > best.pnl) best = { pnl, plan: `carry from week ${w + 1} selling ${t.weeks[w].months[k]}${e < t.W ? `, sell week ${e + 1}` : ', hold to delivery'}`, actions: acts };
      }
    }
  }
  return best;
}
