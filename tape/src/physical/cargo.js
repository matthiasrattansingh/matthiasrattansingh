// CARGO engine: one physical cargo, day by day, from loading to sale. Pure functions.
// Delivered price at a port = benchmark flat price + that port's basis (+ event shifts).
// You pay charter every day the ship works for you, demurrage when it waits at a
// port beyond laytime, and port costs on arrival.
import { seeded } from '../lib/format.js';

/** Card + economics config -> cargo session. Basis paths are modeled (seeded, deterministic). */
export function buildCargo(card, econ, { seed = '' } = {}) {
  const e = econ.cargo;
  const D = card.days.length;
  const ports = card.ports.map((p) => {
    const rand = seeded(`${card.id}|${p.id}|${seed}`);
    const base = [];
    for (let d = 0; d < D; d++) {
      const f = D > 1 ? d / (D - 1) : 0;
      const noise = (rand() - 0.5) * 2 * (p.basis.noise ?? 0);
      base.push(Math.round((p.basis.start + (p.basis.end - p.basis.start) * f + noise) * 100) / 100);
    }
    return { ...p, base, laytime: p.laytime ?? e.laytime_days.value };
  });
  return {
    id: card.id,
    card,
    D,
    bbl: card.cargo?.bbl ?? e.default_bbl.value,
    dates: card.days.map((x) => x.date),
    flat: card.days.map((x) => x.flat),
    ports,
    load: card.load,
    decisions: card.decisions ?? [0],
    events: card.events ?? [],
    charter: card.charter_usd_day ?? e.charter_usd_day.value,
    demurrage: card.demurrage_usd_day ?? e.demurrage_usd_day.value,
    portCost: card.port_costs_usd ?? e.port_costs_usd.value,
    penalty: e.quality_penalty_usd_bbl.value,
  };
}

const portById = (c, id) => c.ports.find((p) => p.id === id);

/** Event-driven basis shift at a port on day d (events that have happened by then). */
export function shiftAt(c, portId, d) {
  let s = 0;
  for (const ev of c.events) {
    if (ev.day > d) continue;
    if (['pipeline_outage', 'refinery_outage', 'refinery_restart', 'demand_spike', 'demand_fade'].includes(ev.type)) {
      if (ev.port === portId) s += ev.usd ?? 0;
      else if (ev.widen && (!ev.widen_ports || ev.widen_ports.includes(portId))) s += ev.widen;
    }
    if (ev.type === 'basis_fade' && ev.port === portId) s += ev.usd;
  }
  return Math.round(s * 100) / 100;
}

export const basisAt = (c, portId, d) => portById(c, portId).base[d] + shiftAt(c, portId, d);
export const deliveredAt = (c, portId, d) => c.flat[d] + basisAt(c, portId, d);

/** Quality penalty applies to sales at a disputed port from the dispute day on. */
export function penaltyAt(c, portId, d) {
  return c.events.filter((ev) => ev.type === 'quality_dispute' && ev.port === portId && ev.day <= d)
    .reduce((s, ev) => s + Math.abs(ev.usd ?? c.penalty), 0);
}

export function newCargoState() {
  return { day: 0, dest: null, eta: null, at: null, queue: 0, waited: 0, sold: null,
    cost: { charter: 0, demurrage: 0, port: 0 }, log: [], delays: 0 };
}

const remaining = (c, st, portId) => (st.at === portId ? 0 : Math.max(1, portById(c, portId).voyage - st.day + st.delays));

/** What you'd get selling now at a port: delivered price minus the voyage still to pay (if afloat). */
export function netbackAt(c, st, portId, d = st.day) {
  const rem = st.at === portId ? 0 : st.dest === portId ? Math.max(0, st.eta - d) : remaining(c, st, portId);
  return deliveredAt(c, portId, d) - penaltyAt(c, portId, d) - (rem * c.charter) / c.bbl;
}

/** The best place to sell right now (berthed port if you're alongside, else best netback). */
export function bestSale(c, st) {
  if (st.at && st.queue === 0) return { port: st.at, price: netbackAt(c, st, st.at), afloat: false };
  let best = null;
  for (const p of c.ports) {
    if (st.at === p.id && st.queue > 0) continue;
    const price = netbackAt(c, st, p.id);
    if (!best || price > best.price) best = { port: p.id, price, afloat: st.at !== p.id };
  }
  return best;
}

export const canChoosePort = (c, st) => !st.sold && !st.at && (st.dest === null || c.decisions.includes(st.day));

function applyDayEvents(c, st) {
  const out = { ...st, log: [...st.log] };
  for (const ev of c.events.filter((x) => x.day === out.day)) {
    out.log.push({ day: out.day, text: ev.text, type: ev.type });
    if (ev.type === 'weather_delay' && !out.at && out.dest) { out.eta += ev.days ?? 1; out.delays += ev.days ?? 1; }
    if (ev.type === 'port_congestion' && out.at === ev.port) out.queue += ev.days ?? 2;
  }
  return out;
}

function arrive(c, st) {
  if (st.at || !st.dest || st.day < st.eta) return st;
  const out = { ...st, at: st.dest, cost: { ...st.cost, port: st.cost.port + c.portCost }, log: [...st.log, { day: st.day, text: `Arrived ${portById(c, st.dest).name}`, type: 'arrive' }] };
  // Congestion that's already in force at this port when you arrive.
  const cong = c.events.filter((ev) => ev.type === 'port_congestion' && ev.port === st.dest && ev.day <= st.day && ev.day + (ev.days ?? 2) + 3 >= st.day);
  return cong.length ? { ...out, queue: out.queue + (cong[0].days ?? 2) } : out;
}

/** Actions: { type: 'PORT', port } | { type: 'SAIL' } | { type: 'WAIT' } | { type: 'SELL' } */
export function step(c, st, action) {
  if (st.sold) return st;
  if (action.type === 'PORT') {
    if (!canChoosePort(c, st)) return st;
    const p = portById(c, action.port);
    const eta = st.day + Math.max(1, p.voyage - st.day) + st.delays;
    return arrive(c, { ...st, dest: p.id, eta, log: [...st.log, { day: st.day, text: `Course set for ${p.name} (ETA day ${eta})`, type: 'port' }] });
  }
  if (action.type === 'SELL') {
    const sale = bestSale(c, st);
    return finishSale(c, st, sale);
  }
  if (st.day >= c.D - 1) return finishSale(c, st, bestSale(c, st)); // last day: you must sell
  let out = { ...st, day: st.day + 1, cost: { ...st.cost } };
  if (!out.dest && !out.at) out = { ...out, dest: null };
  if (out.at) {
    // At port: the ship waits. Laytime is free, then demurrage. The congestion queue counts down.
    out.waited += 1;
    if (out.queue > 0) out.queue -= 1;
    if (out.waited > portById(c, out.at).laytime) out.cost.demurrage += c.demurrage;
  } else {
    out.cost.charter += c.charter;
    if (action.type === 'WAIT' || !out.dest) { if (out.eta !== null) out.eta += 1; } // drifting = floating storage
  }
  out = applyDayEvents(c, out);
  out = arrive(c, out);
  return out;
}

function finishSale(c, st, sale) {
  if (!sale) return st;
  const d = st.day;
  const port = portById(c, sale.port);
  const base = port.base[d];
  const shift = shiftAt(c, sale.port, d);
  const pen = penaltyAt(c, sale.port, d);
  const remDays = sale.afloat ? (st.dest === sale.port ? Math.max(0, st.eta - d) : remaining(c, st, sale.port)) : 0;
  const freightToBuyer = remDays * c.charter; // a buyer taking the cargo afloat deducts the rest of the voyage
  const bbl = c.bbl;
  const split = {
    flat: Math.round((c.flat[d] - c.flat[0]) * bbl),
    basis: Math.round((base - c.load.basis) * bbl),
    costs: -Math.round(st.cost.charter + st.cost.demurrage + st.cost.port + freightToBuyer),
    events: Math.round((shift - pen) * bbl),
  };
  const pnl = split.flat + split.basis + split.costs + split.events;
  return {
    ...st,
    sold: { day: d, port: sale.port, afloat: sale.afloat, price: c.flat[d] + base + shift - pen, split, pnl, freightToBuyer },
    log: [...st.log, { day: d, text: `Sold ${sale.afloat ? 'afloat to ' : 'at '}${port.name}`, type: 'sell' }],
  };
}

/** Live mark-to-market: best sale now minus costs so far (what SELL would book). */
export function markToMarket(c, st) {
  if (st.sold) return st.sold.pnl;
  const s = finishSale(c, st, bestSale(c, st));
  return s.sold ? s.sold.pnl : 0;
}

/** Run a list of actions from the start. */
export function runCargo(c, actions) {
  let st = newCargoState();
  for (const a of actions) st = step(c, st, a);
  while (!st.sold) st = step(c, st, { type: 'SAIL' });
  return st;
}

/**
 * Best achievable with hindsight: pick a port on day 0, optionally float w days at sea,
 * sail, then sell on any day after arrival (or afloat on any day before).
 */
export function bestCargo(c) {
  let best = null;
  for (const p of c.ports) {
    for (let w = 0; w < c.D; w++) {
      for (let s = 0; s < c.D; s++) {
        const acts = [{ type: 'PORT', port: p.id }];
        let st = step(c, newCargoState(), acts[0]);
        for (let i = 0; i < w && !st.sold && st.day < s; i++) { st = step(c, st, { type: 'WAIT' }); acts.push({ type: 'WAIT' }); }
        while (!st.sold && st.day < s) { st = step(c, st, { type: 'SAIL' }); acts.push({ type: 'SAIL' }); }
        if (!st.sold) { st = step(c, st, { type: 'SELL' }); acts.push({ type: 'SELL' }); }
        if (!best || st.sold.pnl > best.pnl) best = { pnl: st.sold.pnl, port: p.id, wait: w, sellDay: st.sold.day, actions: acts };
      }
    }
  }
  return best;
}
