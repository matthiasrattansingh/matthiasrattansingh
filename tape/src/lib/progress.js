// The progress model: XP, streak, accuracy by category, the miss queue, and
// the trading ledger (bankroll, win streak, desk standings, daily Open Bell).
// Every function here is pure: (progress, ...) -> new progress.
import { xpFor } from './scoring.js';
import { START_BANKROLL } from './book.js';
import { BOTS } from './rivals.js';

export const CATEGORIES = {
  crude: 'Crude direction',
  spreads: 'Spreads',
  products: 'Products',
  concepts: 'Concepts',
};

// Spaced repetition schedule in "cards answered" (not days): a miss comes back
// after 4 cards; each correct review pushes it further out; after the last
// step it graduates out of the queue.
export const REVIEW_STEPS = [4, 12, 30];

const botZeros = () => Object.fromEntries(BOTS.map((b) => [b.id, 0]));

export const SAVE_VERSION = 3;

export function emptyProgress() {
  return {
    version: SAVE_VERSION,
    xp: 0,
    answered: 0,
    bestSession: 0,
    streak: { count: 0, best: 0, last: null },
    stats: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, { right: 0, total: 0 }])),
    seen: {},
    misses: {},
    // trading ledger
    bankroll: START_BANKROLL,
    peak: START_BANKROLL,
    blowups: 0,
    combo: 0,
    bestCombo: 0,
    bigWin: 0,
    bots: Object.fromEntries(BOTS.map((b) => [b.id, START_BANKROLL])),
    day: { date: null, you: 0, bots: botZeros(), trades: 0, sessions: 0 },
    bell: {},
    // v2: gamification layer
    createdAt: localDay(),
    ride: { balance: 0, active: false, best: 0 },
    played: {}, // sessionId -> { plays, best, grade, curve, C }
    quests: { date: null, list: [] },
    questsDone: 0,
    league: null, // created on first load of the week
    leagueHistory: [],
    eval: null,
    evalHistory: [],
    funded: false,
    chat: { msgs: [], read: 0, challenge: null, challengeDate: null, nextId: 1 },
    specials: {}, // date -> { kind, cardId, played, pnl }
    // v3: physical desk (company book; never touches the personal $100k account)
    phys: emptyPhys(),
    playerName: '',
  };
}

/** Merge whatever was saved with the current shape so old saves keep working. */
export function hydrate(saved) {
  const base = emptyProgress();
  if (!saved || !(saved.version >= 1 && saved.version <= SAVE_VERSION)) return base;
  const v1 = saved.version === 1;
  return {
    ...base,
    ...saved,
    version: SAVE_VERSION,
    streak: { ...base.streak, ...saved.streak },
    stats: { ...base.stats, ...saved.stats },
    seen: saved.seen ?? {},
    misses: saved.misses ?? {},
    bots: { ...base.bots, ...saved.bots },
    day: { ...base.day, ...saved.day, bots: { ...base.day.bots, ...saved.day?.bots } },
    bell: saved.bell ?? {},
    ride: { ...base.ride, ...saved.ride },
    played: saved.played ?? {},
    quests: saved.quests ?? base.quests,
    chat: { ...base.chat, ...saved.chat },
    specials: saved.specials ?? {},
    phys: { ...emptyPhys(), ...saved.phys, memory: { ...emptyPhys().memory, ...saved.phys?.memory }, negotiation: { ...emptyPhys().negotiation, ...saved.phys?.negotiation } },
    playerName: saved.playerName ?? '',
    // v1 saves have no install date: count the migration day as the start.
    createdAt: v1 ? base.createdAt : saved.createdAt ?? base.createdAt,
    marginCall: false,
  };
}

export function emptyPhys() {
  return {
    pnl: 0, sessions: 0, cargoes: 0, tanks: 0, integrated: 0, xp: 0, best: 0,
    hedgeGrades: [], // 'S'..'D' per integrated session
    memory: { ports: {}, daysToSell: [], hedgeAtLoad: 0, hedgeChances: 0, demurrage: [] },
    relationships: {}, // agentId -> { deals_closed, rounds_stalled_on_them, walk_aways_after_3plus_rounds }
    negotiation: { edge: 0, pulled: 0, deals: 0 },
  };
}

/** Total XP (paper + physical), used by the league. */
export const totalXp = (p) => p.xp + (p.phys?.xp ?? 0);

export function localDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

/** Consecutive-days streak. Using the app on a new day extends or resets it. */
export function touchStreak(streak, today = localDay()) {
  if (streak.last === today) return streak;
  const gap = streak.last ? dayDiff(streak.last, today) : null;
  const count = gap === 1 ? streak.count + 1 : 1;
  return { count, best: Math.max(streak.best, count), last: today };
}

/** A streak shown on screen: 0 if you skipped yesterday and haven't played today. */
export function liveStreak(streak, today = localDay()) {
  if (!streak.last) return 0;
  return dayDiff(streak.last, today) <= 1 ? streak.count : 0;
}

/** Today's desk standings (resets at local midnight). */
export function todayDesk(day, date = localDay()) {
  return day.date === date ? day : { date, you: 0, bots: botZeros(), trades: 0, sessions: 0 };
}

function scheduleMiss(misses, id, correct, answered) {
  const cur = misses[id];
  const next = { ...misses };
  if (!correct) {
    next[id] = { due: answered + REVIEW_STEPS[0], step: 0, lapses: (cur?.lapses ?? 0) + 1 };
  } else if (cur) {
    const step = cur.step + 1;
    if (step >= REVIEW_STEPS.length) delete next[id];
    else next[id] = { ...cur, step, due: answered + REVIEW_STEPS[step] };
  }
  return next;
}

/** Apply a settled trade to the bankroll, desk standings and win streak. */
function applyTrade(p, trade, date) {
  let bankroll = p.bankroll;
  let ride = p.ride ?? { balance: 0, active: false, best: 0 };
  let blowups = p.blowups;
  let marginCall = false;
  if (trade.account !== 'eval') {
    // RIDE: a losing session while riding is paid from the ride first, then the ride is forfeited.
    if (trade.session && ride.active && trade.pnl < 0) {
      const fromRide = Math.min(ride.balance, -trade.pnl);
      bankroll += trade.pnl + fromRide;
      ride = { ...ride, balance: 0, active: false, lost: ride.balance };
    } else {
      bankroll += trade.pnl;
    }
    if (bankroll <= 0) {
      marginCall = true;
      blowups += 1;
      bankroll = START_BANKROLL;
      if (ride.active) ride = { ...ride, balance: 0, active: false, lost: ride.balance };
    }
  }
  const d = todayDesk(p.day, date);
  const bots = { ...p.bots };
  const dayBots = { ...d.bots };
  for (const b of trade.bots) {
    bots[b.id] = (bots[b.id] ?? START_BANKROLL) + b.pnl;
    if (bots[b.id] <= 0) bots[b.id] = START_BANKROLL; // bots get margin-called too
    dayBots[b.id] = (dayBots[b.id] ?? 0) + b.pnl;
  }
  const combo = trade.win ? p.combo + 1 : 0;
  return {
    ...p,
    bankroll,
    ride,
    peak: Math.max(p.peak, bankroll),
    blowups,
    marginCall,
    combo,
    bestCombo: Math.max(p.bestCombo, combo),
    bigWin: Math.max(p.bigWin, trade.pnl),
    bots,
    day: {
      date,
      you: d.you + (trade.account === 'eval' ? 0 : trade.pnl),
      bots: dayBots,
      trades: d.trades + 1,
      sessions: (d.sessions ?? 0) + (trade.session ? 1 : 0),
    },
  };
}

/** RIDE: move a winning session's profit from the account into the ride balance. */
export function startRide(p, amount) {
  if (!(amount > 0) || amount > p.bankroll) return p;
  const balance = (p.ride?.active ? p.ride.balance : 0) + amount;
  return { ...p, bankroll: p.bankroll - amount, ride: { balance, active: true, best: Math.max(p.ride?.best ?? 0, balance), lost: 0 } };
}

/** Cash the ride balance back into the account (ME tab). */
export function cashOutRide(p) {
  if (!p.ride?.active) return p;
  return { ...p, bankroll: p.bankroll + p.ride.balance, ride: { ...p.ride, balance: 0, active: false, lost: 0 } };
}

/**
 * Record one answered card.
 * result: { cardId, category, correct, points, trade? }
 */
export function recordResult(progress, result, date = localDay()) {
  const answered = progress.answered + 1;
  const cat = progress.stats[result.category] ?? { right: 0, total: 0 };
  const next = {
    ...progress,
    answered,
    xp: progress.xp + xpFor(result.points),
    streak: touchStreak(progress.streak, date),
    stats: {
      ...progress.stats,
      [result.category]: { right: cat.right + (result.correct ? 1 : 0), total: cat.total + 1 },
    },
    seen: { ...progress.seen, [result.cardId]: (progress.seen[result.cardId] ?? 0) + 1 },
    misses: scheduleMiss(progress.misses, result.cardId, result.correct, answered),
    marginCall: false,
  };
  return result.trade ? applyTrade(next, result.trade, date) : next;
}

/** Small XP for "learn one thing" cards with no right/wrong (e.g. TAPE CHECK). */
export function recordView(progress, cardId, xp = 3, date = localDay()) {
  if (progress.seenToday?.[cardId] === date) return progress;
  return {
    ...progress,
    xp: progress.xp + xp,
    streak: touchStreak(progress.streak, date),
    seen: { ...progress.seen, [cardId]: (progress.seen[cardId] ?? 0) + 1 },
    seenToday: { ...(progress.seenToday ?? {}), [cardId]: date },
  };
}

/** Save one Open Bell answer (the daily challenge) so it can't be replayed. */
export function recordBell(progress, date, key, saved) {
  const cur = progress.bell[date] ?? { saved: {} };
  return { ...progress, bell: { ...progress.bell, [date]: { ...cur, saved: { ...cur.saved, [key]: saved } } } };
}
