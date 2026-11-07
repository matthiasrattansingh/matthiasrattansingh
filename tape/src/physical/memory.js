// Agent memory of YOUR physical habits: port choices, days to sell, hedge-at-load
// frequency, demurrage paid. After 5 cargoes the desk reacts: rivals pre-position at
// your favorite port (fading your arrival premium a little) and Quinn's chat scouts you.
import { post } from '../game/chat.js';

export const MEMORY_KICKS_IN = 5;
export const FADE_USD_BBL = 0.08; // rivals' pre-positioning shaves your favorite port's premium

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function favoritePort(mem) {
  const entries = Object.entries(mem?.ports ?? {});
  if (!entries.length) return null;
  const [name, n] = entries.sort((a, b) => b[1] - a[1])[0];
  return { name, n, total: entries.reduce((a, [, v]) => a + v, 0) };
}

export function habits(p) {
  const m = p.phys.memory;
  const fav = favoritePort(m);
  return {
    fav,
    daysToSell: avg(m.daysToSell),
    hedgeAtLoad: m.hedgeChances ? m.hedgeAtLoad / m.hedgeChances : null,
    demurrage: avg(m.demurrage),
    cargoes: m.daysToSell.length,
  };
}

/** After a cargo: remember where you sold, how long it took, the demurrage you paid. */
export function rememberCargo(p, { portName, days, demurrage }) {
  const m = p.phys.memory;
  const memory = {
    ...m,
    ports: { ...m.ports, [portName]: (m.ports[portName] ?? 0) + 1 },
    daysToSell: [...m.daysToSell, days].slice(-50),
    demurrage: [...m.demurrage, Math.round(demurrage)].slice(-50),
  };
  let next = { ...p, phys: { ...p.phys, memory } };
  const n = memory.daysToSell.length;
  if (n >= MEMORY_KICKS_IN && n % MEMORY_KICKS_IN === 0) {
    const h = habits(next);
    const hedge = h.hedgeAtLoad === null ? 'and you have never had to hedge a load' : `and you hedge ${Math.round(h.hedgeAtLoad * 100)}% of your loads`;
    next = post(next, 'quinn', 'scout',
      `Scouting report: you discharge at ${h.fav.name} ${h.fav.n} of ${h.fav.total} times, sell in ${h.daysToSell.toFixed(1)} days on average, ${hedge}. We'll be waiting at ${h.fav.name}.`);
  }
  return next;
}

/** After a two-book session: did you hedge at load (decision 0 hedge ratio ≥ 50%)? */
export function rememberHedge(p, ratioAtLoad) {
  const m = p.phys.memory;
  return { ...p, phys: { ...p.phys, memory: { ...m, hedgeChances: m.hedgeChances + 1, hedgeAtLoad: m.hedgeAtLoad + (ratioAtLoad >= 0.5 ? 1 : 0) } } };
}

/**
 * Buyer and rival behaviour after enough cargoes: your favorite port's premium is faded
 * by rivals who got there first (a basis_fade event from day 0). Returns a cargo transformer.
 */
export function rivalAdjust(p) {
  const m = p.phys.memory;
  if ((m.daysToSell?.length ?? 0) < MEMORY_KICKS_IN) return null;
  const fav = favoritePort(m);
  if (!fav) return null;
  return fadeAdjust(fav.name);
}

/** The rivals' pre-positioning at a named port (also rebuilt from a challenge link). */
export function fadeAdjust(portName) {
  return (c) => {
    const port = c.ports.find((x) => x.name === portName);
    if (!port) return c;
    return { ...c, faded: port.id, fadedName: port.name, events: [...c.events, { day: 0, type: 'basis_fade', port: port.id, usd: -FADE_USD_BBL, text: `Rivals pre-positioned at ${port.name}` }] };
  };
}
