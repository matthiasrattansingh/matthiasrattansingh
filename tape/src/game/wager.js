// WAGERS: stake XP against one named bot before a session. Pure functions.
// Placing the wager escrows your stake (XP leaves your balance at once, so you can't spend
// it twice). The bot matches it, so the pot is 2 × stake:
//   you beat the bot's P&L   → you take the pot   (net +stake)
//   the bot beats you        → the bot keeps it    (net −stake)
//   exact tie                → stakes returned     (net 0)
import { post } from './chat.js';

export const STAKES = [10, 25, 50, 100];

export function canWager(p, stake) {
  return stake > 0 && p.xp >= stake && !p.wager;
}

export function placeWager(p, bot, stake, now = Date.now()) {
  if (!canWager(p, stake)) return p;
  return { ...p, xp: p.xp - stake, wager: { bot, stake, at: now } };
}

/** Cancel before the session starts: your stake comes back. */
export function cancelWager(p) {
  if (!p.wager) return p;
  return { ...p, xp: p.xp + p.wager.stake, wager: null };
}

const LINES = {
  win: {
    mo: (s) => `Took ${s} XP off me. Wave was yours. 🏄`, carla: (s) => `Fine. ${s} XP. Don't get used to it.`,
    quinn: (s) => `Paid ${s} XP. Updating the model on you.`, dan: (s) => `NOOO ${s} XP 😤 double or nothing`,
  },
  lose: {
    mo: (s) => `${s} XP to me. Should've ridden it 🏄`, carla: (s) => `${s} XP. Thanks for the donation.`,
    quinn: (s) => `${s} XP collected. Expected value was on my side.`, dan: (s) => `EZ ${s} XP 🎰🎰`,
  },
};

/**
 * Settle against the bot's P&L in the same session. Returns { progress, result } where
 * result = { bot, stake, outcome: 'win'|'lose'|'push', net }.
 */
export function settleWager(p, { pnl, bots }) {
  const w = p.wager;
  if (!w) return { progress: p, result: null };
  const botPnl = bots.find((b) => b.id === w.bot)?.pnl;
  if (botPnl == null) return { progress: cancelWager(p), result: { ...w, outcome: 'push', net: 0 } };
  const outcome = pnl > botPnl ? 'win' : pnl < botPnl ? 'lose' : 'push';
  const back = outcome === 'win' ? 2 * w.stake : outcome === 'push' ? w.stake : 0;
  let next = { ...p, xp: p.xp + back, wager: null };
  if (outcome !== 'push') next = post(next, w.bot, 'wager', LINES[outcome][w.bot]?.(w.stake) ?? `${w.stake} XP wager settled.`);
  return { progress: next, result: { ...w, outcome, net: back - w.stake, botPnl } };
}
