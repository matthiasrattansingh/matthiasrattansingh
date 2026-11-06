// Everything that happens after a TRADE session is booked, as one pure step:
// collection + ghost, eval account, daily quests, league standings, desk chat,
// grudge challenges and event specials.
// Returns { progress, events } where events are things the UI may announce.
import { recordPlay } from './collection.js';
import { checkQuests, ensureQuests } from './quests.js';
import { ensureLeague, passCheck } from './league.js';
import { localDay } from '../lib/progress.js';
import { xpFor } from '../lib/scoring.js';
import { bookEval, refreshEval } from './evalAccount.js';
import { expireChallenge, maybeChallenge, reactToLeague, reactToSession, reactToStreak, resolveChallenge } from './chat.js';
import { recordSpecial } from './events.js';

const chain = (state, step) => {
  const out = step(state.progress);
  return { progress: out.progress, events: [...state.events, ...(out.events ?? [])] };
};

/** Day/week rollovers: run on app open and before anything that reads them. */
export function refresh(progress, now = new Date()) {
  const date = localDay(now);
  let st = { progress: ensureQuests(progress, date), events: [] };
  st = chain(st, (p) => ensureLeague(p, now));
  st = chain(st, (p) => refreshEval(p, now.getTime()));
  st = chain(st, (p) => ({ progress: expireChallenge(p, date) }));
  return st;
}

/**
 * info: { session, pnl (raw session P&L), curve, full (false for OPEN BELL's 5-candle cut),
 *         stats: { maxDD, warned, traded, guardPeak }, bots: [{id,pnl}], marginCall, guardHit,
 *         trade, now, tag: { special } | null, cards (session cards, for challenges) }
 */
export function afterSession(progress, info) {
  const now = new Date(info.now ?? Date.now());
  const date = localDay(now);
  const salt = `${info.session.id}|${now.getTime()}`;
  let st = refresh(progress, now);
  if (info.full) st = chain(st, (p) => ({ progress: recordPlay(p, info.session, info.pnl, info.curve) }));
  if (info.trade?.account === 'eval') {
    st = chain(st, (p) => bookEval(p, { pnl: info.trade.pnl, intraPeak: info.stats?.guardPeak, guardHit: info.guardHit }, now.getTime()));
  }
  if (info.tag?.special) st = chain(st, (p) => recordSpecial(p, info.tag.special, info.pnl));
  st = chain(st, (p) => checkQuests(p, info, date));
  // Grudge challenge: the session's XP again if you beat the bot's number.
  const points = Math.max(-20, Math.min(60, Math.round((info.trade?.pnl ?? info.pnl) / 2000)));
  st = chain(st, (p) => resolveChallenge(p, info, xpFor(points), salt));
  const before = st.events.length;
  st = chain(st, (p) => passCheck(p, now));
  const leagueEvents = st.events.slice(before);
  // Desk chat.
  st = chain(st, (p) => {
    let q = reactToSession(p, info, salt);
    q = reactToStreak(q, q.combo, salt);
    q = reactToLeague(q, leagueEvents, salt);
    // Max one grudge challenge a day, from the second session on.
    if (info.cards?.length && (q.day?.sessions ?? 0) >= 2) q = maybeChallenge(q, date, info.cards, salt);
    return { progress: q };
  });
  return st;
}
