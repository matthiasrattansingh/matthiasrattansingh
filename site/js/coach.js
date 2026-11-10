// COACH layer: pure logic (no DOM). Ticket rules, coach cards, process score, grades,
// signal stats, journal, briefing and debrief text.
import { COACH, ACCOUNT } from './config.js';
import { esc, PASS_REASONS } from './tape.js';
export { PASS_REASONS };

export const SIGNALS = ['Range break', 'Failed extreme', 'VWAP flip', 'Scheduled print reaction', 'Headline reaction', 'None, discretionary'];
export const NO_SIGNAL = 'None, discretionary';
export const PRINT_SIGNAL = 'Scheduled print reaction';
export const SIZES = ['Normal', 'Reduced', 'Too big'];

export const CARD_TEXT = {
  firstHeadline: 'New information, or already in the price? What would the other side of this trade say?',
  print: 'Surprise or in line? First move: is it holding or fading after 3 bars?',
  printFollow: 'Three bars on. Did the first move hold or fade?',
  oneR: 'Thesis check: what has changed since entry, the story or only the price?',
  stopOut: 'Stopped out. Same idea again needs a NEW signal, not the same hope.',
  reunderwrite: 'Re-underwrite: if you were flat right now, would you put this position on at this price? If not, why are you holding it?',
  lastHour: 'Last hour. What is this position still for: the original thesis, or hope?',
};
export const CARD_ANSWERS = { print: ['Surprise', 'In line'], printFollow: ['Held', 'Faded'] };
export const NO_SIGNAL_WARNING = 'No signal. This is the trade type that has cost you the most.';

export const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/**
 * Validate the 4-field entry ticket. `ref` is the entry reference price (limit/stop price, or last
 * for a market order). Returns { ok, errors, ticket } with the ticket normalised.
 */
export function validateTicket(t, { side, ref, tick }) {
  const errors = [];
  if (!t || typeof t !== 'object') return { ok: false, errors: ['fill in the trade ticket'], ticket: null };
  const pricing = String(t.pricing ?? '').trim();
  if (!pricing) errors.push('say what the market is pricing right now');
  if (!SIGNALS.includes(t.signal)) errors.push('pick your signal');
  const wrong = t.wrong === '' || t.wrong == null ? NaN : Number(t.wrong);
  if (!Number.isFinite(wrong)) errors.push('give the price that proves you wrong');
  else if (side === 'BUY' ? wrong >= ref : wrong <= ref) errors.push(`the price that proves you wrong must be ${side === 'BUY' ? 'below' : 'above'} your entry`);
  if (!SIZES.includes(t.size)) errors.push('rate your size vs plan');
  if (errors.length) return { ok: false, errors, ticket: null };
  const dec = Math.max(0, Math.round(-Math.log10(tick)) + 1);
  return { ok: true, errors, ticket: { pricing, signal: t.signal, wrong: Number((Math.round(wrong / tick) * tick).toFixed(dec)), size: t.size,
    attachStop: t.attachStop !== false, headlinePause: Boolean(t.headlinePause) } };
}

// ---------------------------------------------------------------- process score
export function gradeOf(score) { return score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F'; }

export function pnlGrade(net, start = ACCOUNT.startingCash, g = COACH.pnlGrade) {
  const pct = (net / start) * 100;
  return pct >= g.a ? 'A' : pct >= g.b ? 'B' : pct >= g.c ? 'C' : pct >= g.d ? 'D' : 'F';
}

const eps = 1e-9;
export function tradeFacts(trade, slip = 0) {
  const e = trade.meta?.entry, t = trade.meta?.ticket;
  if (!e || !t) return { loserAtStop: false, winner2R: false };
  const long = trade.side === 'LONG';
  const loserAtStop = trade.gross < 0 && (long ? trade.exit >= t.wrong - slip - eps : trade.exit <= t.wrong + slip + eps);
  const mfe = long ? e.best - e.price : e.price - e.best;
  return { loserAtStop, winner2R: trade.gross > 0 && e.R > 0 && mfe >= 2 * e.R - eps };
}

/**
 * Process score. Start at 100. Deductions apply per occurrence; each addition counts once per
 * session. The result is clamped to 0..100.
 */
export function processScore(session) {
  const px = (p) => session.fmtPx(p);
  const items = [];
  const add = (code, points, label, detail) => items.push({ code, points, label, detail });
  for (const e of session.entries) {
    const what = `${e.fillClock} ${e.side} ${e.qty} @ ${px(e.price)}`;
    if (e.flags.noSignal) add('noSignal', -10, 'Entry with no signal', what);
    if (e.flags.noStop) add('noStop', -10, 'Entry with no stop order', what);
    if (e.flags.revenge) add('revenge', -15, 'Revenge: re-entry within 30 minutes of a stop-out', what);
    if (e.flags.impulse) add('impulse', -5, 'Impulse: entered on the bar a headline printed, without the pause', what);
  }
  for (const h of session.printsHeld) add('heldPrint', -5, 'Held through a scheduled print it was not planned for', `${h.type} ${h.time} CT, ${h.position}`);
  if (session.passes.length >= 3) add('passes', 5, 'Passed on 3 or more headlines', `${session.passes.length} passes`);
  const facts = session.account.trades.map((t) => ({ t, ...tradeFacts(t, session.slip) }));
  const loser = facts.find((f) => f.loserAtStop);
  if (loser) add('loserAtStop', 5, 'Exited a loser at or before the planned stop', `${loser.t.entryTime}→${loser.t.exitTime} out @ ${px(loser.t.exit)}, stop ${px(loser.t.meta.ticket.wrong)}`);
  const winner = facts.find((f) => f.winner2R);
  if (winner) add('winner2R', 5, 'Let a winner reach 2R', `${winner.t.entryTime}→${winner.t.exitTime} from ${px(winner.t.entry)}`);
  const raw = 100 + items.reduce((s, i) => s + i.points, 0);
  const score = Math.max(0, Math.min(100, raw));
  return { score, grade: gradeOf(score), items };
}

/** Closed-trade totals split by ticket signal. */
export function signalStats(trades) {
  const out = {};
  for (const t of trades) {
    const k = t.meta?.ticket?.signal ?? 'No ticket (free play)';
    const r = (out[k] ||= { trades: 0, wins: 0, net: 0 });
    r.trades += 1; r.net += t.net; if (t.net > 0) r.wins += 1;
  }
  return out;
}

export function mergeSignalStats(list) {
  const out = {};
  for (const s of list) for (const [k, v] of Object.entries(s || {})) {
    const r = (out[k] ||= { trades: 0, wins: 0, net: 0 });
    r.trades += v.trades; r.wins += v.wins; r.net += v.net;
  }
  return out;
}

/** One line from the desk mentor. Asks about process before it says anything about P&L. Max 40 words. */
export function coachVerdict(session, card, proc) {
  const worst = [...proc.items].filter((i) => i.points < 0).sort((a, b) => a.points - b.points)[0];
  const money = `${card.totalNet < 0 ? '-' : '+'}$${Math.abs(Math.round(card.totalNet)).toLocaleString('en-US')}`;
  if (!session.entries.length) {
    return session.passes.length ? `No trades, ${session.passes.length} passes. Which pass was a decision, and which was just not looking?` : 'No trades and no passes logged. What were you waiting for, and did it ever show up?';
  }
  if (worst) return `${worst.detail}: ${worst.label.toLowerCase()}. The day made ${money}. Would that entry survive twenty repeats?`;
  return `Process ${proc.score}, day ${money}. Every entry had a signal and a stop. Which one would you size up next time, and why?`;
}

export function isTrained(session, debriefDone) {
  return Boolean(session.coach && session.briefingViewed && (session.entries.length + session.ticketsLogged + session.passes.length) > 0 && debriefDone);
}

// ---------------------------------------------------------------- journal (localStorage)
const JKEY = 'replaydesk.journal.v1';
export function loadJournal(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(JKEY) || '[]'); } catch { return []; }
}
export function saveJournal(entry, storage = globalThis.localStorage) {
  const list = loadJournal(storage);
  list.push(entry);
  try { storage.setItem(JKEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  return list;
}
/** The rule carried from the most recent debriefed session, or null. */
export function carriedRule(storage = globalThis.localStorage) {
  const list = loadJournal(storage).filter((e) => e.rule && e.rule.trim());
  const last = list.at(-1);
  return last ? { rule: last.rule.trim(), day: last.day, product: last.product } : null;
}
export function namedDriver(answer, keywords = []) {
  const a = String(answer).toLowerCase();
  return keywords.some((k) => a.includes(String(k).toLowerCase()));
}

export const DEBRIEF_QUESTIONS = [
  "What was today's driver?",
  'When did the tape first tell you?',
  'Your first trade: signal or impulse?',
  'Where did the day turn, and were you positioned for it or against it?',
  'One rule you carry into the next session:',
];

function positionAt(session, clock) {
  let p = 0;
  for (const f of session.account.fills) if (f.time <= clock) p += f.side === 'BUY' ? f.qty : -f.qty;
  return p === 0 ? 'flat' : `${p > 0 ? 'long' : 'short'} ${Math.abs(p)}`;
}

/** Session facts shown in brackets beside each debrief question. */
export function debriefPrefill(session, proc) {
  const bars = session.revealedBars();
  const px = (p) => session.fmtPx(p);
  let hi = bars[0], lo = bars[0], move = null;
  bars.forEach((b, i) => {
    if (b.h > hi.h) hi = b;
    if (b.l < lo.l) lo = b;
    if (i >= 3) { const d = b.c - bars[i - 3].c; if (!move || Math.abs(d) > Math.abs(move.d)) move = { d, time: b.time }; }
  });
  const e = session.entries[0];
  const heads = session.tape.filter((t) => t.kind === 'headline').length;
  const worst = [...proc.items].filter((i) => i.points < 0).sort((a, b) => a.points - b.points)[0];
  return [
    `[${heads} headlines printed; you entered ${session.entries.length} time${session.entries.length === 1 ? '' : 's'} and passed ${session.passes.length}]`,
    `[open ${px(bars[0].o)}; high ${px(hi.h)} in the ${hi.time} bar; low ${px(lo.l)} in the ${lo.time} bar${move ? `; largest 15-minute move ${move.d > 0 ? '+' : ''}${px(move.d)} ending ${move.time}` : ''}]`,
    e ? `[first entry: ${e.fillClock} ${e.side} ${e.qty} @ ${px(e.price)}, signal "${e.ticket.signal}"${e.flags.impulse ? ', on the bar a headline printed' : ''}]` : '[no entries taken]',
    `[at the ${hi.time} high you were ${positionAt(session, hi.time)}; at the ${lo.time} low you were ${positionAt(session, lo.time)}]`,
    `[process ${proc.score} (${proc.grade})${worst ? `; biggest deduction: ${worst.label.toLowerCase()}, ${worst.detail}` : '; no deductions'}]`,
  ];
}

// ---------------------------------------------------------------- morning briefing
/**
 * Briefing HTML. Built ONLY from pre-session fields: briefing, events, scenarios, lesson.
 * driver_summary and driver_keywords are never read here.
 */
export function briefingHtml({ day, product, coachDay, carried, priorClose, overnight = [] }) {
  const c = coachDay || {};
  const li = (a) => a.map((x) => `<li>${x}</li>`).join('');
  const rule = carried ? `<div class="carried"><strong>Your rule from ${esc(carried.day)}:</strong> ${esc(carried.rule)}</div>` : '';
  const prior = priorClose ? `<p class="mono small">${esc(product)} last traded ${esc(priorClose.value)} at the ${esc(priorClose.day)} pit close.</p>` : '';
  return `${rule}
<h3>Where we are, and what is priced in</h3>${prior}<p>${esc(c.briefing || 'No briefing written for this day. Add one in data/coach.json.')}</p>
<h3>Overnight headlines</h3><ul>${li(overnight.map((h) => `<span class="mono muted">${esc(h.when)}</span> ${esc(h.text)}`)) || '<li class="muted">None on the tape.</li>'}</ul>
<h3>Scheduled today (CT)</h3><ul>${li((c.events || []).map((e) => `<span class="mono">${esc(e.time)}</span> ${esc(e.label)}${e.consensus ? ` <span class="muted">(consensus: ${esc(e.consensus)})</span>` : ''}`)) || '<li class="muted">Nothing scheduled.</li>'}</ul>
<h3>Scenarios, and what each looks like on the tape</h3><ol>${li((c.scenarios || []).map((s) => `<strong>${esc(s.name)}</strong> (if ${esc(s.if)}). ${esc(s.tape)}`))}</ol>
<h3>Lesson of the day</h3><p class="lesson"><strong>${esc(c.lesson || '')}</strong> ${esc(c.lesson_text || '')}</p>
<p class="muted small">Before your first order: which scenario are you trading, and what on the tape tells you it is the wrong one?</p>`;
}
