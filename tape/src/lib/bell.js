// OPEN BELL: the daily challenge. Everyone gets the same session on the same
// date (picked from a date seed), squeezed into 5 candles = 5 trades, one shot,
// with a warm-up concept question and a shareable result.
import { seeded } from './format.js';
import { fmtMoney } from './book.js';

export const BELL_CANDLES = 5;

/** Today's session card: deterministic for the date, same for everyone. */
export function bellSession(sessions, date) {
  const pool = sessions.filter((c) => c.type === 'callit').sort((a, b) => a.id.localeCompare(b.id));
  const rand = seeded(`bell|${date}`);
  return pool[Math.floor(rand() * pool.length)];
}

/** What's saved for a date: { warmup?, started?, result? }. */
export const bellState = (progress, date) => progress.bell[date]?.saved ?? {};
export const bellDone = (progress, date) => {
  const b = bellState(progress, date);
  return Boolean(b.result || b.started);
};

export function shareText(date, r) {
  const [y, m, d] = date.split('-');
  const pretty = new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const crown = r.beat === 4 ? ' 👑' : '';
  return `TAPE Open Bell · ${pretty}\n${r.grid}  ${fmtMoney(r.pnl)}\nBeat ${r.beat}/4 of the desk${crown}\nCan you beat me? ${location.origin}${location.pathname}`;
}
