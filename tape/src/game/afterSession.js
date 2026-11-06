// Everything that happens after a TRADE session is booked, as one pure step:
// collection + ghost (and, as the layers land: quests, eval, league, chat, specials).
// Returns { progress, events } where events are things the UI may announce.
import { recordPlay } from './collection.js';

/**
 * info: { session, pnl (raw session P&L), curve, full (false for OPEN BELL's 5-candle cut),
 *         maxDD, warned (margin bar went amber), traded, bots: [{id,pnl}], marginCall, now }
 */
export function afterSession(progress, info) {
  let p = progress;
  const events = [];
  if (info.full) p = recordPlay(p, info.session, info.pnl, info.curve);
  return { progress: p, events };
}
