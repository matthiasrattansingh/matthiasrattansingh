// Daily quests: 3 per local calendar day from fixed templates, seeded by the date.
// Each pays XP and a $1,000 account bonus.
import { seeded } from '../lib/format.js';
import { fmtMoney } from '../lib/book.js';
import { BOTS, botById } from '../lib/rivals.js';

export const QUEST_XP = 40;
export const QUEST_CASH = 1_000;
export const EARN_TARGETS = [10_000, 20_000, 30_000];

export const TEMPLATES = {
  spreadWin: {
    text: () => 'Win a spread session',
    check: (q, i) => i.session.spread && i.pnl > 0,
  },
  lowDD: {
    text: () => 'Finish a session with max drawdown under $5,000',
    check: (q, i) => i.stats?.traded && i.stats.maxDD < 5000 && !i.marginCall,
  },
  beatBot: {
    text: (q) => `Beat ${botById[q.bot].name} head-to-head in a session`,
    check: (q, i) => i.stats?.traded && i.pnl > (i.bots.find((b) => b.id === q.bot)?.pnl ?? Infinity),
  },
  earnX: {
    text: (q) => `Earn ${fmtMoney(q.x, { sign: false })} in one session`,
    check: (q, i) => i.pnl >= q.x,
  },
  noWarning: {
    text: () => 'Complete a session without a margin warning',
    check: (q, i) => i.stats?.traded && !i.stats.warned && !i.marginCall,
  },
};

export function makeQuests(date) {
  const rand = seeded(`quests|${date}`);
  const ids = Object.keys(TEMPLATES);
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  return ids.slice(0, 3).map((t) => {
    const q = { t, done: false };
    if (t === 'beatBot') q.bot = BOTS[Math.floor(rand() * BOTS.length)].id;
    if (t === 'earnX') q.x = EARN_TARGETS[Math.floor(rand() * EARN_TARGETS.length)];
    return q;
  });
}

export const questText = (q) => TEMPLATES[q.t].text(q);

/** Today's quests, generated on first look at a new day. */
export function ensureQuests(p, date) {
  if (p.quests?.date === date) return p;
  return { ...p, quests: { date, list: makeQuests(date) } };
}

/** Check a finished session against today's quests; pay any that completed. */
export function checkQuests(p, info, date) {
  p = ensureQuests(p, date);
  const events = [];
  let { bankroll, xp, questsDone = 0 } = p;
  const list = p.quests.list.map((q) => {
    if (q.done || !TEMPLATES[q.t].check(q, info)) return q;
    bankroll += QUEST_CASH;
    xp += QUEST_XP;
    questsDone += 1;
    events.push({ type: 'quest', text: `✅ Quest done: ${questText(q)} · +$1,000 +${QUEST_XP} XP` });
    return { ...q, done: true };
  });
  return { progress: { ...p, bankroll, xp, questsDone, quests: { ...p.quests, list } }, events };
}
