// Desk chat: the four desk bots post short, templated messages in character on
// events (your results, theirs, streaks, league moves). At most once a day one
// of them issues a grudge challenge: beat their P&L on a named session for double XP.
// There's no free-text input; the only action is ACCEPT on a challenge.
import { seeded } from '../lib/format.js';
import { fmtMoney } from '../lib/book.js';
import { botById } from '../lib/rivals.js';
import { buildSession, botDecisions, simulate } from '../trade/engine.js';
import { bestAchievable } from './collection.js';

const MAX_MSGS = 60;
const k = (v) => fmtMoney(Math.round(v), { compact: true });

const LINES = {
  youWon: {
    mo: ['Rode {inst} for {pnl}? That’s a wave 🏄', 'Trend was your friend on {inst}. {pnl}.'],
    carla: ['{pnl} on {inst}. Enjoy it before it mean-reverts.', 'Nice {pnl}. I’d have faded it, for the record.'],
    quinn: ['{pnl} on {inst}. Sample size of one, but noted.', 'Logged: {pnl}. Your edge estimate went up 0.3%.'],
    dan: ['{pnl}?? SIZE UP NEXT TIME 🎰', '{pnl} on {inst}. Cute. Now do it with 5 lots.'],
  },
  youLost: {
    mo: ['Fought the trend on {inst}? Never fight the tape.', '{loss} on {inst}. The trend doesn’t care about your thesis.'],
    carla: ['{loss} down. Buy the dip in your confidence.', 'Everyone was on your side of {inst}. That’s the problem.'],
    quinn: ['{loss}. Expected value can be positive and still lose.', 'Variance: {loss}. Size accordingly.'],
    dan: ['lol {loss}. i lost more. probably.', '{loss}?? rookie numbers. I blew up twice before lunch 🎰'],
  },
  brag: {
    mo: ['Trend paid me {pnl} on {inst}. Easy.', '{pnl} on {inst}. Just surfed it 🏄'],
    carla: ['Faded the crowd on {inst}: {pnl}. They’re always late.', '{pnl} on {inst}. Contrarian season 🦊'],
    quinn: ['Model: {pnl} on {inst}. As forecast (60%).', '{pnl} on {inst}. Boring is profitable.'],
    dan: ['{pnl} ON {inst} LETS GOOO 🚀', 'MAX SIZE. {pnl}. WHO’S LAUGHING NOW 🎰'],
  },
  lament: {
    mo: ['{loss} on {inst}. Trend reversed on me. Happens.', 'Chopped up on {inst}: {loss}.'],
    carla: ['{loss}. Sometimes the crowd is right. Annoying.', 'Faded {inst} too early: {loss}.'],
    quinn: ['{loss} on {inst}. The 40% showed up.', 'Model miss on {inst}: {loss}. Retraining.'],
    dan: ['{loss} 💀 averaging down was a choice', 'down {loss} on {inst}. doubling tomorrow obviously'],
  },
  streak: {
    mo: ['{n} wins in a row. You’re in the flow 🏄'],
    carla: ['{n} straight? Careful. That’s when it turns.'],
    quinn: ['{n}-session win streak. Statistically unusual. Keep sizing sane.'],
    dan: ['{n} IN A ROW 🔥🔥🔥 go max size now'],
  },
  passedYou: {
    mo: ['Passed you in the league. Momentum 🏄'], carla: ['Overtook you in the league. Slow and contrary wins.'],
    quinn: ['Ahead of you in the league now. Projected to stay there.'], dan: ['PASSED YOU 🚀 see ya'],
  },
  youPassed: {
    mo: ['You passed me in the league. Respect, I’ll catch the next wave.'], carla: ['You passed me. Enjoy the top. It never lasts.'],
    quinn: ['You passed me. Updating priors.'], dan: ['ok you passed me. for now. 🎰'],
  },
  challenge: {
    mo: ['I made {target} on {inst} ({date}). Riding trends. Beat that ⚔️'],
    carla: ['{target} on {inst} ({date}), fading everyone. Your turn ⚔️'],
    quinn: ['My model made {target} on {inst} ({date}). Prove you’re better than a model ⚔️'],
    dan: ['{target} on {inst} ({date}) at MAX SIZE. Bet you can’t ⚔️'],
  },
  challengeWon: {
    mo: ['You beat my {inst} number. Fair. Double XP is yours.'], carla: ['Fine. You beat me on {inst}. Double XP.'],
    quinn: ['You beat the model on {inst}. Double XP awarded.'], dan: ['NOOO you beat me on {inst} 😤 double XP'],
  },
  challengeLost: {
    mo: ['Missed my {inst} number. Trend wins again.'], carla: ['Couldn’t beat me on {inst}. Told you.'],
    quinn: ['Below the model on {inst}. As expected.'], dan: ['HAHA couldn’t beat me on {inst} 🎰'],
  },
};

function fill(text, vars) {
  return text.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

function line(kind, bot, vars, salt) {
  const opts = LINES[kind][bot];
  return fill(opts[Math.floor(seeded(`${kind}|${bot}|${salt}`)() * opts.length)], vars);
}

export function post(p, bot, kind, text, extra = {}) {
  const chat = p.chat ?? { msgs: [], read: 0, nextId: 1 };
  const msg = { id: chat.nextId ?? 1, bot, kind, text, at: Date.now(), ...extra };
  return { ...p, chat: { ...chat, msgs: [...chat.msgs, msg].slice(-MAX_MSGS), nextId: msg.id + 1 } };
}

export const unread = (p) => (p.chat?.msgs ?? []).filter((m) => m.id > (p.chat.read ?? 0)).length;
export const markRead = (p) => ({ ...p, chat: { ...p.chat, read: p.chat.msgs.at(-1)?.id ?? 0 } });

const instOf = (s) => s.instrument;
const pick = (arr, salt) => arr[Math.floor(seeded(salt)() * arr.length)];
const DESK = ['mo', 'carla', 'quinn', 'dan'];

/** Bots react to a finished session (at most two messages, so it never floods). */
export function reactToSession(p, info, salt) {
  const s = info.session;
  const vars = { inst: instOf(s), pnl: k(info.pnl), loss: k(Math.abs(info.pnl)) };
  if (info.stats?.traded) {
    const bot = pick(DESK, `who|${salt}`);
    p = post(p, bot, 'react', line(info.pnl >= 0 ? 'youWon' : 'youLost', bot, vars, salt));
  }
  const sorted = [...info.bots].sort((a, b) => b.pnl - a.pnl);
  const top = sorted[0];
  const bottom = sorted[sorted.length - 1];
  if (top && Math.abs(top.pnl) > 5000 && seeded(`brag|${salt}`)() < 0.6) {
    p = post(p, top.id, 'brag', line('brag', top.id, { ...vars, pnl: k(top.pnl) }, salt));
  } else if (bottom && bottom.pnl < -20000) {
    p = post(p, bottom.id, 'lament', line('lament', bottom.id, { ...vars, loss: k(Math.abs(bottom.pnl)) }, salt));
  }
  return p;
}

export function reactToStreak(p, combo, salt) {
  if (![3, 5, 8].includes(combo)) return p;
  const bot = pick(DESK, `streak|${salt}`);
  return post(p, bot, 'streak', line('streak', bot, { n: combo }, salt));
}

/** League passes involving a desk bot get a reply from that bot. */
export function reactToLeague(p, events, salt) {
  for (const e of events) {
    const bot = DESK.find((id) => e.text.includes(botById[id].name));
    if (!bot) continue;
    p = post(p, bot, 'league', line(e.text.includes('just passed you') ? 'passedYou' : 'youPassed', bot, {}, salt));
  }
  return p;
}

/** At most one grudge challenge per day. */
export function maybeChallenge(p, date, cards, salt) {
  if (p.chat?.challengeDate === date) return p;
  const rand = seeded(`challenge|${date}|${salt}`);
  const bot = DESK[Math.floor(rand() * DESK.length)];
  const card = cards[Math.floor(rand() * cards.length)];
  const s = buildSession(card);
  const theirs = simulate(s, botDecisions(bot, s, `challenge|${date}`)).final;
  const target = Math.round(Math.max(theirs, bestAchievable(s) * 0.25) / 100) * 100;
  const vars = { target: k(target), inst: instOf(s), date: new Date(`${s.date}T12:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) };
  const challenge = { id: `${date}|${card.id}`, bot, sessionId: card.id, inst: instOf(s), target, date, status: 'open' };
  p = { ...p, chat: { ...p.chat, challengeDate: date, challenge } };
  return post(p, bot, 'challenge', line('challenge', bot, vars, salt), { challenge: challenge.id });
}

export function acceptChallenge(p) {
  const ch = p.chat?.challenge;
  if (!ch || ch.status !== 'open') return p;
  return { ...p, chat: { ...p.chat, challenge: { ...ch, status: 'accepted' } } };
}

/** Challenges expire at the end of their day. */
export function expireChallenge(p, date) {
  const ch = p.chat?.challenge;
  if (!ch || ch.date === date || !['open', 'accepted'].includes(ch.status)) return p;
  return { ...p, chat: { ...p.chat, challenge: { ...ch, status: 'expired' } } };
}

/** An accepted challenge resolves on that session: beat the target = double the session's XP. */
export function resolveChallenge(p, info, sessionXp, salt) {
  const ch = p.chat?.challenge;
  if (!ch || ch.status !== 'accepted' || ch.sessionId !== info.session.id) return { progress: p, events: [] };
  const won = info.pnl > ch.target;
  p = { ...p, xp: p.xp + (won ? sessionXp : 0), chat: { ...p.chat, challenge: { ...ch, status: won ? 'won' : 'lost' } } };
  p = post(p, ch.bot, 'challenge-result', line(won ? 'challengeWon' : 'challengeLost', ch.bot, { inst: ch.inst }, salt));
  const text = won
    ? `⚔️ Challenge won vs ${botById[ch.bot].name}: double XP (+${sessionXp})`
    : `⚔️ Challenge lost: ${botById[ch.bot].name} made ${k(ch.target)}`;
  return { progress: p, events: [{ type: 'challenge', text }] };
}
