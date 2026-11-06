// Weekly league: you + 29 bots in a 30-seat league. League XP = XP earned
// Monday 00:00 to Sunday 23:59 local. Top 10 promote, bottom 5 demote.
import { seeded } from '../lib/format.js';
import { BOTS } from '../lib/rivals.js';
import { totalXp } from '../lib/progress.js';

export const TIERS = ['Bronze', 'Silver', 'Gold', 'Diamond'];
export const TIER_ICON = { Bronze: '🥉', Silver: '🥈', Gold: '🥇', Diamond: '💎' };
export const SEATS = 30;
export const PROMOTE = 10;
export const DEMOTE = 5;

// 25 generated rivals are drawn from this roster each week (alongside the 4 desk bots).
const ROSTER = [
  ['Basis Betty', '🦉', '#f59e0b'], ['Crack Kim', '🐙', '#ef4444'], ['Contango Carl', '🐢', '#10b981'], ['Backwardation Bo', '🦅', '#3b82f6'],
  ['Cushing Cass', '🛢️', '#a855f7'], ['Brent Bianca', '🌊', '#06b6d4'], ['WTI Wes', '🤠', '#eab308'], ['Diesel Dee', '🚚', '#f97316'],
  ['RBOB Rafa', '⛽', '#84cc16'], ['Henry Hub Hal', '🔥', '#f43f5e'], ['Spread Sam', '🦀', '#14b8a6'], ['Vol Vera', '🌪️', '#8b5cf6'],
  ['Theta Theo', '⏳', '#64748b'], ['Freight Fia', '🚢', '#0ea5e9'], ['Barge Bart', '⚓', '#22c55e'], ['Refinery Rae', '🏭', '#d946ef'],
  ['OPEC Omar', '🐪', '#facc15'], ['Shale Shay', '🪨', '#a3a3a3'], ['Pipeline Pip', '🧪', '#2dd4bf'], ['Storage Stu', '📦', '#fb923c'],
  ['Hedge Hana', '🦔', '#4ade80'], ['Swing Sol', '🐒', '#fbbf24'], ['Tape Tara', '📼', '#60a5fa'], ['Scalp Scout', '🐝', '#fde047'],
  ['Arb Ari', '🦊', '#fb7185'], ['Netback Nia', '🧭', '#34d399'], ['Prompt Pia', '⚡', '#c084fc'], ['Sour Sid', '🍋', '#bef264'],
  ['Sweet Sue', '🍬', '#f9a8d4'], ['Roll Rex', '🦖', '#22d3ee'], ['Expiry Eli', '⏰', '#f472b6'], ['Floater Flo', '🛟', '#38bdf8'],
];
const DESK = BOTS.map((b) => ({ id: b.id, name: b.name, emoji: b.emoji, color: '#ffffff' }));

const DAY_MS = 86_400_000;
const TIER_MULT = { Bronze: 1, Silver: 1.35, Gold: 1.8, Diamond: 2.4 };

export function mondayOf(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Monday = 0
  x.setDate(x.getDate() - dow);
  return x;
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

/**
 * A fresh league for the week containing `now`. When you join mid-week (your first
 * league), bots only count XP from the moment you join, so nobody has a head start.
 */
export function newLeague(tier, now, xp, { midWeek = false } = {}) {
  const week = iso(mondayOf(now));
  const rand = seeded(`league|${week}|${tier}`);
  const pool = ROSTER.map((r, i) => ({ id: `lg${i}`, name: r[0], emoji: r[1], color: r[2] }));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const members = [...DESK, ...pool.slice(0, SEATS - 1 - DESK.length)].map((m) => {
    // Each bot's habits: a typical day (log-normal spread), weekday bias, and maybe a late-Sunday binge.
    const r = seeded(`${week}|${m.id}`);
    const mean = Math.round(25 * Math.exp(r() * 2.6) * TIER_MULT[tier]); // ~25..340 XP/day at Bronze
    return { ...m, mean, sunday: r() < 0.25, skip: r() * 0.25 };
  });
  return { week, tier, startXp: xp, members, ahead: null, since: midWeek ? now.getTime() : null };
}

/** A bot's XP for one day of the week (0 = Monday), deterministic. */
function dayTotal(m, week, day) {
  const r = seeded(`${week}|${m.id}|d${day}`);
  if (r() < m.skip) return 0; // some days they don't show up
  const weekday = day < 5 ? 1.15 : day === 5 ? 0.6 : 0.8;
  const noise = 0.45 + r() * 1.1;
  return Math.round(m.mean * weekday * noise);
}

/** A bot's league XP at time `now`: full past days plus a share of today. */
export function botXp(m, league, now) {
  const start = fromIso(league.week).getTime();
  let total = 0;
  for (let day = 0; day < 7; day++) {
    const dayStart = start + day * DAY_MS;
    if (now.getTime() < dayStart) break;
    const hours = Math.min(24, (now.getTime() - dayStart) / 3_600_000);
    const f = Math.min(1, Math.max(0, (hours - 7) / 16)); // active roughly 7am-11pm
    total += Math.round(dayTotal(m, league.week, day) * f);
    if (day === 6 && m.sunday && hours >= 18) {
      total += Math.round(m.mean * 2.5 * Math.min(1, (hours - 18) / 5)); // the late-Sunday binge
    }
  }
  return total;
}

export const myLeagueXp = (p) => Math.max(0, totalXp(p) - (p.league?.startXp ?? totalXp(p)));

export function standings(p, now = new Date()) {
  const league = p.league;
  const since = league.since ? new Date(league.since) : null;
  const rows = league.members.map((m) => ({ ...m, xp: botXp(m, league, now) - (since ? botXp(m, league, since) : 0), me: false }));
  rows.push({ id: 'me', name: 'You', emoji: '🫵', color: '#ffb000', xp: myLeagueXp(p), me: true });
  rows.sort((a, b) => b.xp - a.xp || (a.me ? -1 : b.me ? 1 : 0));
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}

/** Create the league if missing; close out finished weeks (promote / demote) and start new ones. */
export function ensureLeague(p, now = new Date()) {
  const events = [];
  if (!p.league) return { progress: { ...p, league: newLeague('Bronze', now, totalXp(p), { midWeek: true }) }, events };
  let league = p.league;
  const history = [...(p.leagueHistory ?? [])];
  while (now.getTime() >= fromIso(league.week).getTime() + 7 * DAY_MS) {
    const end = new Date(fromIso(league.week).getTime() + 7 * DAY_MS - 1);
    const table = standings({ ...p, league }, end);
    const me = table.find((r) => r.me);
    const t = TIERS.indexOf(league.tier);
    const result = me.rank <= PROMOTE && t < TIERS.length - 1 ? 'promoted' : me.rank > SEATS - DEMOTE && t > 0 ? 'demoted' : 'stayed';
    const tier = TIERS[t + (result === 'promoted' ? 1 : result === 'demoted' ? -1 : 0)];
    history.unshift({ week: league.week, tier: league.tier, rank: me.rank, xp: me.xp, result, next: tier });
    events.push({ type: 'league', text: `${TIER_ICON[tier]} League week over: #${me.rank} in ${league.tier}, ${result === 'stayed' ? `staying in ${tier}` : `${result} to ${tier}`}` });
    const nextMonday = new Date(fromIso(league.week).getTime() + 7 * DAY_MS + 3_600_000);
    league = newLeague(tier, nextMonday, totalXp(p));
  }
  return { progress: { ...p, league, leagueHistory: history.slice(0, 26) }, events };
}

/** Who passed whom since the last check: "Dan just passed you". */
export function passCheck(p, now = new Date()) {
  const table = standings(p, now);
  const meRow = table.find((r) => r.me);
  const ahead = table.filter((r) => !r.me && r.rank < meRow.rank).map((r) => r.id);
  const prev = p.league.ahead;
  const events = [];
  if (prev) {
    const passedMe = table.filter((r) => ahead.includes(r.id) && !prev.includes(r.id));
    const iPassed = table.filter((r) => !r.me && prev.includes(r.id) && !ahead.includes(r.id));
    if (passedMe.length) {
      const b = passedMe[passedMe.length - 1];
      events.push({ type: 'league', text: `${b.emoji} ${b.name} just passed you — they're ${b.xp - meRow.xp} XP ahead` });
    } else if (iPassed.length) {
      const b = iPassed[0];
      events.push({ type: 'league', text: `⬆️ You passed ${b.emoji} ${b.name} — you're #${meRow.rank} by ${meRow.xp - b.xp} XP` });
    }
  }
  return { progress: { ...p, league: { ...p.league, ahead } }, events };
}
