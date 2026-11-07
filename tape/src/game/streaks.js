// STREAKS AND DECAY: the OPEN BELL daily streak, and XP that decays when you skip days.
import { localDay } from '../lib/progress.js';

const day = (iso) => new Date(`${iso}T12:00:00`);
const gap = (a, b) => Math.round((day(b) - day(a)) / 86400000);
const shift = (iso, n) => { const d = day(iso); d.setDate(d.getDate() + n); return localDay(d); };

/** Consecutive days with OPEN BELL played, ending today (or yesterday, if today's is still open). */
export function bellStreak(p, today = localDay()) {
  const played = (d) => Boolean(p.bell?.[d]?.saved?.result || p.bell?.[d]?.saved?.started);
  let start = played(today) ? today : shift(today, -1);
  let n = 0;
  while (played(start)) { n += 1; start = shift(start, -1); }
  return n;
}

export const DECAY_PER_DAY = 0.02;
export const DECAY_CAP = 0.2;

/**
 * XP decay for skipped days: 2% of XP per missed day (capped at 20%), applied once, the first
 * time the app opens after the gap. Returns { progress, events }.
 */
export function applyDecay(p, today = localDay()) {
  const last = p.streak?.last;
  if (!last || p.decay?.checked === today) return { progress: p, events: [] };
  // Only days not already charged: from the later of your last active day and the last day decayed.
  const from = p.decay?.through && p.decay.through > last ? p.decay.through : last;
  const missed = Math.max(0, gap(from, today) - 1);
  const through = missed ? shift(today, -1) : p.decay?.through ?? null;
  const marked = { ...p, decay: { ...(p.decay ?? {}), checked: today, through } };
  if (!missed || p.xp <= 0) return { progress: marked, events: [] };
  const lost = Math.round(p.xp * Math.min(DECAY_CAP, DECAY_PER_DAY * missed));
  if (!lost) return { progress: marked, events: [] };
  return {
    progress: { ...marked, xp: p.xp - lost, decay: { checked: today, through, last: { date: today, missed, lost } } },
    events: [{ type: 'decay', text: `⏳ ${missed} day${missed > 1 ? 's' : ''} away: −${lost} XP decayed` }],
  };
}
