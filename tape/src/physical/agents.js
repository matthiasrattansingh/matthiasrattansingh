// Autonomous desk agents in physical sessions. Each runs its own cargo / tank through
// the same steps and events as you, deciding from its agents.json rules and the PUBLIC
// state only: every price lookup goes through a view that refuses future days.
import { buildCargo, deliveredAt, netbackAt, newCargoState, step } from './cargo.js';
import { carryCost, carryOffer, newTankState, stepTank, tankPnl, tankSplit } from './tank.js';
import { seeded } from '../lib/format.js';

/** Public view of a cargo up to `day`. Asking about a later day throws: no peeking. */
export function cargoView(c, day) {
  const guard = (d) => {
    if (d > day) throw new Error(`look-ahead: asked for day ${d} on day ${day}`);
    return d;
  };
  return {
    day,
    ports: c.ports.map((p) => p.id),
    flat: (d) => c.flat[guard(d)],
    delivered: (port, d = day) => deliveredAt(c, port, guard(d)),
    netback: (st, port) => netbackAt(c, st, port, guard(st.day)),
    events: c.events.filter((e) => e.day <= day),
    charter: c.charter,
    bbl: c.bbl,
    voyage: (port) => c.ports.find((p) => p.id === port).voyage,
  };
}

const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Port choice by method, from public state only. */
export function choosePort(method, v, st) {
  const score = {
    // Mo chases the port whose delivered price rose most over the last 3 days.
    max_recent_price_gain: (p) => v.delivered(p) - v.delivered(p, Math.max(0, v.day - 3)) + v.delivered(p) * 1e-6,
    // Carla goes where the price is most below its recent average, net of the wait (voyage) cost.
    max_discount_adjusted_for_wait: (p) => {
      const hist = [];
      for (let d = Math.max(0, v.day - 4); d <= v.day; d++) hist.push(v.delivered(p, d));
      return (avg(hist) - v.delivered(p)) - (Math.max(1, v.voyage(p) - v.day) * v.charter) / v.bbl + v.delivered(p) * 1e-3;
    },
    // Quinn: best netback (delivered minus the voyage still to pay).
    max_netback: (p) => v.netback({ ...st, dest: null }, p),
    // Dan: whichever port's price just made the headline (biggest jump today), nearest on a tie.
    max_headline_price: (p) => (v.delivered(p) - v.delivered(p, Math.max(0, v.day - 1))) - v.voyage(p) * 1e-4,
  }[method];
  return [...v.ports].sort((a, b) => score(b) - score(a))[0];
}

/** Sell or hold at port, by timing rule, from public state only. */
function wantsToSell(rule, tolerance, v, st, port) {
  const today = v.delivered(port);
  const yday = v.delivered(port, Math.max(0, v.day - 1));
  if (st.waited >= tolerance) return true; // out of demurrage patience
  switch (rule) {
    case 'price_trend_follow': return today < yday; // ride it until it turns
    case 'sell_early_into_strength': return today >= yday; // first sign of strength
    case 'netback_threshold': {
      const hist = [];
      for (let d = Math.max(0, v.day - 4); d <= v.day; d++) hist.push(v.delivered(port, d));
      return today >= avg(hist) - 0.1; // fair or better vs the 5-day average
    }
    case 'yolo_hold': return false; // holds until patience or the session runs out
    default: return true;
  }
}

/**
 * Run one agent through a cargo. Returns final state plus per-day P&L history
 * (for the live strip) and a one-line summary of what it did.
 */
export function runAgentCargo(agent, card, econ, { seed = '', adjust = null } = {}) {
  let c = buildCargo(card, econ, { seed });
  if (adjust) c = adjust(c);
  const rule = agent.physical;
  let st = newCargoState();
  const history = [];
  const reads = { maxDay: 0 };
  for (let guard = 0; guard < 60 && !st.sold; guard++) {
    const v = cargoView(c, st.day);
    reads.maxDay = Math.max(reads.maxDay, st.day);
    if (!st.at && (st.dest === null || c.decisions.includes(st.day))) {
      const port = choosePort(rule.port_choice_method, v, st);
      if (port !== st.dest) { st = step(c, st, { type: 'PORT', port }); continue; }
    }
    if (st.at) {
      const canBerth = st.queue === 0;
      st = canBerth && wantsToSell(rule.sell_timing, rule.demurrage_tolerance_days, v, st, st.at)
        ? step(c, st, { type: 'SELL' })
        : step(c, st, { type: 'WAIT' });
    } else {
      st = step(c, st, { type: 'SAIL' });
    }
    if (!st.sold) history[st.day] = mark(c, st);
  }
  const portName = (id) => c.ports.find((p) => p.id === id)?.name ?? id;
  const s = st.sold;
  const summary = `${agent.name.split(' ')[1]}: ${s.afloat ? `sold afloat toward ${portName(s.port)}` : `discharged ${portName(s.port)}`} day ${s.day + 1}, ${st.cost.demurrage ? `$${Math.round(st.cost.demurrage / 1000)}k demurrage` : '$0 demurrage'}`;
  return { agent, c, st, pnl: s.pnl, split: s.split, history, summary, demurrage: st.cost.demurrage };
}

/** What the agent would book if it sold right now (its live P&L for the strip). */
function mark(c, st) {
  const s2 = step(c, st, { type: 'SELL', port: st.at ?? st.dest ?? undefined });
  return s2.sold ? s2.sold.pnl : 0;
}

// ---------------- tank ----------------

/** Run one agent's carry rule through a tank session. */
export function runAgentTank(agent, t, { seed = '' } = {}) {
  const rule = agent.physical.storage_behavior;
  const rand = seeded(`${agent.id}|${t.id}|${seed}`);
  let st = newTankState();
  const history = [];
  let did = 'never stored';
  for (let guard = 0; guard < 40 && !st.done; guard++) {
    const w = st.week;
    const weeksLeft = t.W - w;
    // Quinn and Carla only carry when there's at least a month left to deliver; Dan doesn't care.
    if (!st.inv && rule.mode !== 'never' && (weeksLeft >= 4 || rule.mode === 'coin_flip_max')) {
      const offers = [1, 2, 3].map((k) => carryOffer(t, w, k));
      const cost = carryCost(t, w);
      // Sell the next deliverable month, so the carry completes by delivery inside the session.
      const best = offers[0];
      const prev = w >= 3 ? t.weeks[w - 3].curve[1] - t.weeks[w - 3].curve[0] : null;
      const front = t.weeks[w].curve[1] - t.weeks[w].curve[0];
      let go = false;
      let k = best.k;
      if (rule.mode === 'carry_when_math_clears') go = best.perMonth > cost + (rule.margin_of_safety_usd_bbl_month ?? 0.1);
      if (rule.mode === 'counter_cyclical') go = prev !== null && front < prev && best.perMonth > cost + (rule.margin_of_safety_usd_bbl_month ?? 0);
      if (rule.mode === 'coin_flip_max') { go = rand() < 0.5; k = 3; }
      if (go) {
        st = stepTank(t, st, { type: 'CARRY', k, bbl: t.capacity });
        did = `filled ${(t.capacity / 1000).toFixed(0)}k bbl week ${w + 1}, sold ${t.weeks[w].months[k]}`;
        continue;
      }
    }
    st = stepTank(t, st, { type: 'WAIT' });
    history[st.week] = tankPnl(t, st);
  }
  const sp = tankSplit(t, st);
  return { agent, st, pnl: sp.total, split: sp, history, summary: `${agent.name.split(' ')[1]}: ${did}${st.rent ? `, rent $${Math.round(st.rent / 1000)}k` : ''}`, rent: st.rent };
}
