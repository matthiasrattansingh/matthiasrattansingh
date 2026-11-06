// OPEN BELL: the daily challenge. Everyone gets the same 5 cards on the same
// date (picked from a date seed), one attempt, and a shareable result, so you
// can compete with friends by texting your score.
import { seeded } from './format.js';
import { fmtMoney } from './book.js';

const SHAPE = ['callit', 'concept', 'callit', 'spread', 'callit'];

export function bellCards(cards, date) {
  const rand = seeded(`bell|${date}`);
  const used = new Set();
  return SHAPE.map((type) => {
    const pool = cards.filter((c) => c.type === type && !used.has(c.id)).sort((a, b) => a.id.localeCompare(b.id));
    const card = pool[Math.floor(rand() * pool.length)];
    used.add(card.id);
    return card;
  });
}

export const bellKey = (date, i) => `bell-${date}-${i}`;

/** Totals for a finished (or partly finished) bell. */
export function bellSummary(cards, date, saved = {}) {
  const rows = cards.map((card, i) => ({ card, a: saved[bellKey(date, i)] }));
  const done = rows.every((r) => r.a?.trade);
  const you = rows.reduce((s, r) => s + (r.a?.trade?.pnl ?? 0), 0);
  const bots = {};
  for (const r of rows) for (const b of r.a?.trade?.bots ?? []) bots[b.id] = (bots[b.id] ?? 0) + b.pnl;
  const beat = Object.values(bots).filter((v) => you > v).length;
  const grid = rows.map((r) => (!r.a?.trade ? '⬜' : r.card.type === 'concept' ? (r.a.trade.win ? '🟦' : '⬛') : r.a.trade.win ? '🟩' : '🟥')).join('');
  return { rows, done, you, bots, beat, grid };
}

export function shareText(date, s) {
  const [y, m, d] = date.split('-');
  const pretty = new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const crown = s.beat === 4 ? ' 👑' : '';
  return `TAPE Open Bell · ${pretty}\n${s.grid}  ${fmtMoney(s.you)}\nBeat ${s.beat}/4 of the desk${crown}\nCan you beat me? ${location.origin}${location.pathname}`;
}
