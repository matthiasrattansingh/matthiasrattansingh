// Everything that happens after a TRADE session is booked, as one pure step:
// collection + ghost, daily quests, league standings (more layers hook in here).
// Returns { progress, events } where events are things the UI may announce.
import { recordPlay } from './collection.js';
import { checkQuests, ensureQuests } from './quests.js';
import { ensureLeague, passCheck } from './league.js';
import { localDay } from '../lib/progress.js';
import { bookEval, refreshEval } from './evalAccount.js';

const chain = (state, step) => {
  const out = step(state.progress);
  return { progress: out.progress, events: [...state.events, ...(out.events ?? [])] };
};

/** Day/week rollovers: run on app open and before anything that reads them. */
export function refresh(progress, now = new Date()) {
  let st = { progress: ensureQuests(progress, localDay(now)), events: [] };
  st = chain(st, (p) => ensureLeague(p, now));
  st = chain(st, (p) => refreshEval(p, now.getTime()));
  return st;
}

/**
 * info: { session, pnl (raw session P&L), curve, full (false for OPEN BELL's 5-candle cut),
 *         stats: { maxDD, warned, traded, guardPeak }, bots: [{id,pnl}], marginCall, guardHit, trade, now }
 */
export function afterSession(progress, info) {
  const now = new Date(info.now ?? Date.now());
  const date = localDay(now);
  let st = refresh(progress, now);
  if (info.full) st = chain(st, (p) => ({ progress: recordPlay(p, info.session, info.pnl, info.curve) }));
  if (info.trade?.account === 'eval') {
    st = chain(st, (p) => bookEval(p, { pnl: info.trade.pnl, intraPeak: info.stats?.guardPeak, guardHit: info.guardHit }, now.getTime()));
  }
  st = chain(st, (p) => checkQuests(p, info, date));
  st = chain(st, (p) => passCheck(p, now));
  return st;
}
