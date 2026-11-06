// Booking for physical sessions. Physical P&L goes to the PHYSICAL desk book (company
// money, millions per cargo), never to the personal $100k play account.
import { recordPlay } from '../game/collection.js';
import { localDay, todayDesk, touchStreak } from '../lib/progress.js';

export const PHYS_LEVELS = [
  { name: 'Scheduler', minXp: 0, blurb: 'You book the ships and chase the paperwork.' },
  { name: 'Senior Scheduler', minXp: 400, blurb: 'You run the voyage: ports, laytime, demurrage.' },
  { name: 'Cargo Trader', minXp: 1200, blurb: 'You buy and sell the barrels and own the basis.' },
  { name: 'Integrated Book', minXp: 3000, blurb: 'Physical and paper in one book. You hedge what you own.' },
];

export function physLevel(xp) {
  let i = 0;
  PHYS_LEVELS.forEach((l, k) => { if (xp >= l.minXp) i = k; });
  const cur = PHYS_LEVELS[i];
  const next = PHYS_LEVELS[i + 1] ?? null;
  return { ...cur, index: i, next, pct: next ? (xp - cur.minXp) / (next.minXp - cur.minXp) : 1 };
}

/** Physical XP: scaled for million-dollar cargo P&L; never negative. */
export const physXpFor = (pnl) => Math.max(0, Math.min(60, Math.round(pnl / 50_000))) + 5;

export const INTEGRATED_UNLOCK_CARGOES = 5;
export const integratedUnlocked = (p) => (p.phys?.cargoes ?? 0) >= INTEGRATED_UNLOCK_CARGOES;

/**
 * Book a finished physical session.
 * r: { card, kind: 'cargo'|'tank'|'integrated', pnl, best, curve, C, memory? }
 */
export function bookPhysical(p, r, now = new Date()) {
  const date = localDay(now);
  const phys = { ...p.phys, memory: { ...p.phys.memory } };
  const xp = physXpFor(r.pnl);
  phys.pnl += Math.round(r.pnl);
  phys.sessions += 1;
  phys.xp += xp;
  phys.best = Math.max(phys.best, Math.round(r.pnl));
  if (r.kind === 'cargo') phys.cargoes += 1;
  if (r.kind === 'tank') phys.tanks += 1;
  if (r.kind === 'integrated') phys.integrated += 1;
  if (r.hedgeGrade) phys.hedgeGrades = [...phys.hedgeGrades, r.hedgeGrade].slice(-200);
  let next = { ...p, phys, streak: touchStreak(p.streak, date) };
  const d = todayDesk(p.day, date);
  next.day = { ...d, date, sessions: (d.sessions ?? 0) + 1 };
  next = recordPlay(next, { id: r.card.id, C: r.C ?? 0 }, r.pnl, r.curve ?? [], Math.max(1, r.best));
  const events = [{ type: 'phys', text: `🛢️ Physical book ${r.pnl >= 0 ? '+' : '−'}$${Math.abs(Math.round(r.pnl)).toLocaleString()} · +${xp} physical XP` }];
  if (r.kind === 'cargo' && phys.cargoes === INTEGRATED_UNLOCK_CARGOES) {
    events.push({ type: 'unlock', text: '🔓 5 cargoes done: two-book INTEGRATED sessions unlocked' });
  }
  return { progress: next, events };
}

const GRADE_POINTS = { S: 4, A: 3, B: 2, C: 1, D: 0 };
export function hedgeAverage(p) {
  const g = p.phys?.hedgeGrades ?? [];
  if (!g.length) return null;
  const avg = g.reduce((s, x) => s + GRADE_POINTS[x], 0) / g.length;
  return { avg, letter: ['D', 'C', 'B', 'A', 'S'][Math.round(avg)], n: g.length };
}
