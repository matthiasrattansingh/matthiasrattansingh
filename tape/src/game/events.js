// Event specials: on a real event day (EIA petroleum Wednesdays, EIA gas storage
// Thursdays, OPEC+ meeting dates from data/events.json) one special session
// unlocks for that day only. Missed ones show greyed in the Library. The calendar
// is passed in by game/calendar.js, so this module stays pure and testable in Node.
import { seeded } from '../lib/format.js';

const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The event on a date (OPEC+ wins over a weekly report), or null. */
export function eventOn(date, cal) {
  const opec = cal.opec?.dates?.includes(date);
  if (opec) return { id: 'opec', label: cal.opec.label, blurb: cal.opec.blurb, time: '', pool: cal.opec.pool };
  const weekday = ((fromIso(date).getDay() + 6) % 7) + 1; // 1 = Monday
  const ev = cal.recurring.find((r) => r.weekday === weekday);
  return ev ? { ...ev } : null;
}

/** Today's special (or null): which session, and whether you've played it. */
export function specialFor(progress, date, cards, cal) {
  const ev = eventOn(date, cal);
  if (!ev) return null;
  const pool = ev.pool.filter((id) => cards.some((c) => c.id === id));
  if (!pool.length) return null;
  const cardId = pool[Math.floor(seeded(`special|${date}`)() * pool.length)];
  const card = cards.find((c) => c.id === cardId);
  const title = card.type === 'spread' ? card.title : card.instrument;
  return { date, kind: ev.id, label: ev.label, blurb: ev.blurb, time: ev.time, cardId, title, played: Boolean(progress.specials?.[date]?.played) };
}

/** Every event day since you started (up to and including `today`), played or missed. */
export function specialsLog(progress, today, cards, cal) {
  const out = [];
  const start = fromIso(progress.createdAt ?? today);
  for (let d = start; iso(d) <= today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const sp = specialFor(progress, iso(d), cards, cal);
    if (!sp) continue;
    const rec = progress.specials?.[sp.date];
    if (rec?.played) out.push({ ...sp, played: true, pnl: rec.pnl });
    else if (sp.date < today) out.push({ ...sp, played: false });
  }
  return out.reverse();
}

export const SPECIAL_XP = 50;

/** Mark today's special as played. */
export function recordSpecial(p, sp, pnl) {
  return {
    progress: { ...p, xp: p.xp + SPECIAL_XP, specials: { ...p.specials, [sp.date]: { kind: sp.kind, cardId: sp.cardId, played: true, pnl: Math.round(pnl) } } },
    events: [{ type: 'special', text: `⭐ ${sp.label} done · +${SPECIAL_XP} XP` }],
  };
}
