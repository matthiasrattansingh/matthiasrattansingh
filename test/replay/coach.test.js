import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../../site/js/session.js';
import { COACH } from '../../site/js/config.js';
import { SIGNALS, NO_SIGNAL, CARD_TEXT, NO_SIGNAL_WARNING, validateTicket, processScore, gradeOf, pnlGrade, signalStats, mergeSignalStats,
  coachVerdict, wordCount, briefingHtml, saveJournal, loadJournal, carriedRule, namedDriver, debriefPrefill, isTrained, DEBRIEF_QUESTIONS } from '../../site/js/coach.js';
import { reportCard, tradesToCsv, saveScore, updateScore, loadScores } from '../../site/js/report.js';
import { runCoach } from '../../site/js/coachbot.js';

const COACH_FILE = JSON.parse(readFileSync(new URL('../../data/coach.json', import.meta.url), 'utf8'));
const DAYS = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
const load = (sym) => JSON.parse(readFileSync(new URL(`../../data/${sym}.json`, import.meta.url)));

// ---- fixtures (synthetic bars for unit tests only) ----
function dayBars(overrides = {}, px = 80) {
  const out = [];
  let h = 7, m = 0;
  for (let i = 0; i < 90; i++) {
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 5; if (m >= 60) { h += 1; m = 0; }
    out.push({ t: i, time, o: px, h: px + 0.05, l: px - 0.05, c: px, v: 100, ...(typeof overrides === 'function' ? overrides(time) : overrides[time]) });
  }
  return out;
}
const head = (time, extra = {}) => ({ date: '2026-01-05', time, type: 'OTHER', time_precision: 'approx', pause: false, products: ['CL'], headline: `Headline at ${time}`, class: 'real', ...extra });
function fakeClock() { const c = { t: 1_000_000, now: () => c.t, advance: (ms) => { c.t += ms; } }; return c; }
function coachSession({ bars = dayBars(), headlines = [], clock = fakeClock(), viewed = true } = {}) {
  const s = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: bars }, headlines, prevDay: '2026-01-02', coach: true, now: clock.now });
  s.briefingViewed = viewed;
  return s;
}
const stepTo = (s, clock) => { const cards = []; while (s.clock() < clock) cards.push(...(s.step().cards || [])); assert.equal(s.clock(), clock); return cards; };
const ticket = (o = {}) => ({ pricing: 'Diplomacy premium coming out', signal: 'Range break', wrong: 79.5, size: 'Normal', ...o });
function memStorage() { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; }

// ------------------------------------------------------------------ (1) ticket gate
test('TICKET: entries are blocked without a complete ticket and allowed with one', () => {
  const s = coachSession({ viewed: false });
  assert.match(s.submit({ side: 'BUY', qty: 1, ticket: ticket() }).error, /briefing/i, 'briefing gates trading');
  s.briefingViewed = true;

  const none = s.submit({ side: 'BUY', qty: 1 });
  assert.equal(none.ok, false); assert.equal(none.needsTicket, true);
  const incomplete = [
    [{ pricing: '   ' }, /pricing/], [{ signal: '' }, /signal/], [{ signal: 'Gut feel' }, /signal/],
    [{ wrong: '' }, /proves you wrong/], [{ wrong: 80.5 }, /must be below/], [{ size: '' }, /size/],
  ];
  for (const [patch, re] of incomplete) {
    const r = s.submit({ side: 'BUY', qty: 1, ticket: ticket(patch) });
    assert.equal(r.ok, false, JSON.stringify(patch)); assert.match(r.error, re);
  }
  assert.equal(s.account.position, 0); assert.equal(s.entries.length, 0);
  assert.match(s.submit({ side: 'SELL', qty: 1, ticket: ticket({ wrong: 79.5 }) }).error, /must be above/, 'short needs a price above');

  const ok = s.submit({ side: 'BUY', qty: 1, ticket: ticket() });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(s.account.position, 1);
  assert.equal(s.entries.length, 1);
  assert.equal(s.entries[0].ticket.signal, 'Range break');
  // "what proves me wrong" pre-fills the bracket stop
  const stop = s.workingOrders().find((o) => o.type === 'STP');
  assert.equal(stop.price, 79.5); assert.equal(stop.side, 'SELL');
  // the ticket is stored with the trade
  assert.equal(s.submit({ side: 'SELL', qty: 1 }).ok, true, 'an exit needs no ticket');
  assert.equal(s.account.trades[0].meta.ticket.pricing, 'Diplomacy premium coming out');
  // adding and flipping are entries; limit entries need a ticket too
  assert.equal(s.submit({ side: 'BUY', type: 'LMT', price: 79.9, qty: 1 }).needsTicket, true);
  assert.equal(s.submit({ side: 'BUY', type: 'LMT', price: 79.9, qty: 1, ticket: ticket({ wrong: 79.7 }) }).ok, true);

  // free play: no gates
  const free = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: dayBars() } });
  assert.equal(free.submit({ side: 'BUY', qty: 1 }).ok, true);
  assert.deepEqual(validateTicket(null, { side: 'BUY', ref: 80, tick: 0.01 }).ok, false);
  assert.equal(SIGNALS.length, 6);
});

// ------------------------------------------------------------------ (2) stop-out lockout
test('LOCKOUT: a stop-out blocks same-signal re-entry for 3 real minutes; a different signal overrides', () => {
  const clock = fakeClock();
  const s = coachSession({ clock, bars: dayBars({ '08:05': { l: 79.4 } }) });
  stepTo(s, '08:00');
  assert.equal(s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8 }) }).ok, true);
  const cards = stepTo(s, '08:10');
  assert.equal(s.account.position, 0, 'stopped out');
  assert.equal(s.stopOuts.length, 1);
  const card = cards.find((c) => c.key === 'stopOut');
  assert.ok(card.text.includes(CARD_TEXT.stopOut) && card.text.includes('79.79'), card.text);

  const again = s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8 }) });
  assert.equal(again.ok, false); assert.equal(again.locked, true);
  assert.match(again.error, /Locked out 3:00/);
  assert.equal(s.submit({ side: 'SELL', qty: 1, ticket: ticket({ wrong: 80.4 }) }).locked, true, 'either direction, same product');
  clock.advance(COACH.lockoutMs - 1000);
  assert.match(s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8 }) }).error, /Locked out 0:01/);
  assert.equal(s.submit({ side: 'BUY', qty: 1 }).needsTicket, true, 'no ticket is still no order');

  // a completed NEW ticket with a DIFFERENT signal overrides
  const override = s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8, signal: 'VWAP flip' }) });
  assert.equal(override.ok, true, override.error);
  assert.equal(s.entries.at(-1).flags.lockOverride, true);
  assert.equal(s.entries.at(-1).flags.revenge, true, 'and it is scored as revenge');
  s.flatten();

  // after 3 minutes the same signal is allowed again
  clock.advance(1001);
  assert.equal(s.lockout(), null);
  assert.equal(s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8 }) }).ok, true);
});

// ------------------------------------------------------------------ (3) process score
function scriptedSession() {
  const bars = dayBars((time) => (time === '09:35' ? { l: 79.6 } : time >= '10:10' ? { o: 80.6, h: 80.65, l: 80.55, c: 80.6 } : {}));
  const headlines = [head('08:00'), head('09:00', { type: 'MACRO', time_precision: 'exact', pause: true }), head('10:00'), head('11:00'), head('12:00')];
  const s = coachSession({ bars, headlines });
  const cards = [];
  cards.push(...stepTo(s, '07:30'));
  s.submit({ side: 'BUY', qty: 1, ticket: ticket({ signal: NO_SIGNAL, attachStop: false }) });            // A: no signal, no stop
  cards.push(...stepTo(s, '09:10'));                                                                      // carried through the 09:00 print
  s.flatten();                                                                                            // loser, out above the 79.50 stop
  cards.push(...stepTo(s, '09:30'));
  s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8 }) });                                      // B: clean entry, stopped at 09:40
  cards.push(...stepTo(s, '09:50'));
  s.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.8, signal: 'VWAP flip' }) });                 // C: revenge (10 min after stop)
  cards.push(...stepTo(s, '10:30'));
  s.flatten();                                                                                            // winner, reached 2R
  cards.push(...stepTo(s, '11:00'));
  s.submit({ side: 'SELL', qty: 1, ticket: ticket({ wrong: 81, signal: 'Headline reaction' }) });          // D: impulse on the headline bar
  cards.push(...stepTo(s, '11:10'));
  s.flatten();
  for (const i of [0, 1, 2]) s.pass(s.tape.indexOf(s.tape.filter((t) => t.kind === 'headline')[i]), i === 0 ? 'Unconfirmed' : '');
  cards.push(...stepTo(s, '14:30'));
  s.finish();
  return { s, cards };
}

test('PROCESS SCORE: scripted session scores 70 (C) with every deduction and addition itemised', () => {
  const { s } = scriptedSession();
  assert.equal(s.entries.length, 4);
  assert.equal(s.stopOuts.length, 1);
  const p = processScore(s);
  const by = (code) => p.items.filter((i) => i.code === code).reduce((t, i) => t + i.points, 0);
  assert.deepEqual({ noSignal: by('noSignal'), noStop: by('noStop'), heldPrint: by('heldPrint'), revenge: by('revenge'), impulse: by('impulse'),
    passes: by('passes'), loserAtStop: by('loserAtStop'), winner2R: by('winner2R') },
  { noSignal: -10, noStop: -10, heldPrint: -5, revenge: -15, impulse: -5, passes: 5, loserAtStop: 5, winner2R: 5 });
  assert.equal(p.score, 70);
  assert.equal(p.grade, 'C');
  // every item cites the actual trade: time, side, price
  assert.match(p.items.find((i) => i.code === 'noSignal').detail, /^07:30 BUY 1 @ 80\.02$/);
  assert.match(p.items.find((i) => i.code === 'revenge').detail, /^09:50 BUY 1 @ 80\.02$/);
  assert.match(p.items.find((i) => i.code === 'impulse').detail, /^11:00 SELL 1 @ 80\.58$/);

  assert.deepEqual([95, 90, 89, 80, 70, 60, 59, 0].map(gradeOf), ['A', 'A', 'B', 'B', 'C', 'D', 'F', 'F']);
  assert.deepEqual([1500, 300, 0, -300, -1500].map((n) => pnlGrade(n, 100000)), ['A', 'B', 'C', 'D', 'F']);
  // clamps: additions never push past 100
  const clean = coachSession({ headlines: [head('08:00'), head('09:00'), head('10:00')] });
  stepTo(clean, '10:05');
  for (const t of clean.tape.filter((x) => x.kind === 'headline')) clean.pass(clean.tape.indexOf(t));
  clean.finish();
  assert.equal(processScore(clean).score, 100);

  // the pause removes the impulse deduction; a planned print trade is not "held through"
  const calm = coachSession({ headlines: [head('08:00'), head('09:00', { type: 'EIA', time_precision: 'exact', pause: true })] });
  stepTo(calm, '08:00');
  calm.submit({ side: 'BUY', qty: 1, ticket: ticket({ signal: 'Scheduled print reaction', headlinePause: true }) });
  stepTo(calm, '09:10'); calm.finish();
  assert.deepEqual(processScore(calm).items.filter((i) => i.points < 0), []);
});

test('report card, scoreboard and CSV carry process grade, P&L grade and totals by signal', () => {
  const { s } = scriptedSession();
  const c = reportCard(s);
  assert.equal(c.process.score, 70); assert.equal(c.mode, 'train'); assert.equal(c.passes, 3);
  assert.ok(['A', 'B', 'C', 'D', 'F'].includes(c.pnlGrade));
  const sig = signalStats(s.account.trades);
  assert.deepEqual(Object.keys(sig).sort(), ['Headline reaction', 'None, discretionary', 'Range break', 'VWAP flip']);
  assert.ok(sig['VWAP flip'].net > 0 && sig['Range break'].net < 0 && sig['VWAP flip'].wins === 1);
  const total = Object.values(sig).reduce((t, v) => t + v.net, 0);
  assert.ok(Math.abs(total - c.totalNet) < 1e-6, 'signal split adds up to the day');
  assert.equal(mergeSignalStats([sig, sig, undefined])['VWAP flip'].trades, 2);

  const st = memStorage();
  const id = saveScore(c, st).at(-1).playedAt;
  let row = loadScores(st)[0];
  assert.deepEqual([row.process, row.processGrade, row.mode, row.trained, row.passes], [70, 'C', 'train', false, 3]);
  assert.equal(updateScore(id, { trained: true }, st), true);
  assert.equal(loadScores(st)[0].trained, true);

  const csv = tradesToCsv(s.account.trades, s.day, 2, { finished: true, herringsSeen: 0, timesBaited: 0, product: 'CL', mode: 'train', trained: true,
    passes: 3, processScore: 70, processGrade: 'C', pnlGrade: c.pnlGrade, debrief: { answers: ['Diplomacy', '08:05', 'Impulse', 'At 10:10, against', 'No ticket, no trade'], named: true } });
  const [h, r1] = csv.trim().split('\n');
  assert.match(h, /,signal,pricedIn,provesMeWrong,sizeVsPlan,sessionMode,sessionTrained,sessionPasses,sessionProcessScore,sessionProcessGrade,sessionPnlGrade,debrief1Driver,debriefNamedDriver,debrief2TapeToldYou,debrief3FirstTrade,debrief4Turn,debrief5Rule$/);
  assert.match(r1, /,"None, discretionary",Diplomacy premium coming out,79\.50,Normal,train,TRAINED,3,70,C,[A-F],Diplomacy,YES,08:05,Impulse,"At 10:10, against","No ticket, no trade"$/);
});

// ------------------------------------------------------------------ coach cards
test('COACH CARDS: fire at the right moments, cite the trade, stay under 40 words, and log answers', () => {
  const { s, cards } = scriptedSession();
  const keys = cards.map((c) => `${c.clock} ${c.key}`);
  assert.ok(keys.includes('08:00 firstHeadline'));
  assert.ok(keys.includes('09:00 print'));
  assert.ok(keys.includes('09:15 printFollow'), '3 bars after the print');
  assert.ok(keys.includes('09:40 stopOut'));
  assert.equal(keys.filter((k) => k.endsWith('firstHeadline')).length, 1, 'only the first headline');
  const print = cards.find((c) => c.key === 'print');
  assert.deepEqual(print.answers, ['Surprise', 'In line']);
  assert.deepEqual(cards.find((c) => c.key === 'printFollow').answers, ['Held', 'Faded']);
  assert.equal(s.answerCard(print.id, 'Surprise'), true);
  assert.equal(s.coachLog.find((c) => c.id === print.id).answer, 'Surprise');
  assert.equal(s.coachLog.length, cards.length, 'every card is logged');

  // 1R against, 11:30 and 13:30 only when a position is on
  const held = coachSession({ bars: dayBars((t) => (t >= '08:00' ? { o: 79.6, h: 79.65, l: 79.55, c: 79.6 } : {})) });
  stepTo(held, '07:30');
  held.submit({ side: 'BUY', qty: 1, ticket: ticket({ wrong: 79.7, attachStop: false }) });
  const hc = stepTo(held, '13:30');
  const oneR = hc.filter((c) => c.key === 'oneR');
  assert.equal(oneR.length, 1);
  assert.match(oneR[0].text, /^Long 1 from 80\.02 at 07:30, now 79\.60: 1R against\. What has changed since entry: the story, or only the price\?$/);
  assert.match(hc.find((c) => c.key === 'reunderwrite').text, /^11:30\. Long 1 from 80\.02, now 79\.60\. If you were flat now, would you put this on at this price\?$/);
  assert.match(hc.find((c) => c.key === 'lastHour').text, /^13:30\. Long 1 from 80\.02, now 79\.60\. What is this position still for: the original thesis, or hope\?$/);
  const flat = coachSession();
  assert.deepEqual(stepTo(flat, '14:00'), [], 'no position, no time cards');

  for (const c of [...cards, ...hc]) assert.ok(wordCount(c.text) <= COACH.maxCardWords, `${wordCount(c.text)} words: ${c.text}`);
  for (const t of [...Object.values(CARD_TEXT), NO_SIGNAL_WARNING]) assert.ok(wordCount(t) <= 40);
  assert.equal(NO_SIGNAL_WARNING, 'No signal. This is the trade type that has cost you the most.');
  const card = reportCard(s);
  const verdict = coachVerdict(s, card, card.process);
  assert.ok(wordCount(verdict) <= 40 && /\?$/.test(verdict) && /09:50 BUY 1 @ 80\.02/.test(verdict), verdict);

  // free play: no cards at all
  const free = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: dayBars() }, headlines: [head('08:00')], prevDay: '2026-01-02' });
  while (!free.isLastBar) assert.deepEqual(free.step().cards, []);
});

test('PASS: logged per headline with an optional reason, and it is not an entry', () => {
  const s = coachSession({ headlines: [head('08:00'), head('08:30')] });
  stepTo(s, '08:35');
  const idx = s.tape.map((t, i) => (t.kind === 'headline' ? i : -1)).filter((i) => i >= 0);
  assert.equal(s.pass(idx[0]), true);
  assert.equal(s.pass(idx[0], 'Already priced'), true, 'reason can be added after');
  assert.equal(s.pass(idx[1], 'Unconfirmed'), true);
  assert.equal(s.pass(999, 'Unconfirmed'), false, 'not a tape entry');
  assert.equal(s.pass(idx[0], 'made-up reason'), true);
  assert.equal(s.passes[0].reason, 'Already priced', 'unknown reasons are ignored');
  assert.deepEqual(s.passes.map((p) => [p.printedClock, p.reason]), [['08:00', 'Already priced'], ['08:30', 'Unconfirmed']]);
  assert.equal(s.entries.length, 0);
  s.finish();
  assert.equal(isTrained(s, true), true, 'a pass counts toward a trained session');
  assert.equal(isTrained(s, false), false, 'not without the debrief');
  const lazy = coachSession(); lazy.finish();
  assert.equal(isTrained(lazy, true), false, 'no ticket and no pass: untrained');
  const free = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: dayBars() } }); free.finish();
  assert.equal(isTrained(free, true), false, 'free play is never trained');
});

// ------------------------------------------------------------------ (4) coach.json has no hindsight
test('coach.json: 10 briefings written as of the morning, with no outcome words or own-day settles', () => {
  const own = {   // that day's own settle levels (from the desk owner's notes): must never appear in its briefing
    '2026-10-27': ['99.90'], '2026-10-28': ['102.56'], '2026-10-29': ['101.34'], '2026-10-30': ['104.12'], '2026-11-02': ['96.48'],
    '2026-11-03': ['96.17'], '2026-11-04': ['88.27'], '2026-11-05': ['90.52'], '2026-11-06': ['90.83', '98.32'], '2026-11-09': ['87.11'],
  };
  const lessons = {
    '2026-10-27': 'TRADE THE SURPRISE, NOT THE HEADLINE', '2026-10-28': 'SEPARATE CLAIM FROM CONFIRMATION', '2026-10-29': 'THE REACTION IS THE NEWS',
    '2026-10-30': 'DO NOT FADE CONFIRMED RISK', '2026-11-02': 'PREMIUM UNWIND IS NOT PHYSICAL LOOSENING', '2026-11-03': 'AFTER A WASHOUT, SIZE DOWN',
    '2026-11-04': 'KNOW THE THESIS HIERARCHY', '2026-11-05': 'OVERSOLD IS A CONDITION, NOT A SIGNAL', '2026-11-06': 'DO NOT CHASE THE SPIKE',
    '2026-11-09': 'TWO SOURCES OR IT IS A RUMOR',
  };
  assert.deepEqual(Object.keys(COACH_FILE.days).sort(), DAYS);
  const CL = load('CL'), BZ = load('BZ');
  for (const day of DAYS) {
    const d = COACH_FILE.days[day];
    assert.equal(d.lesson, lessons[day]);
    assert.ok(d.briefing.length > 40 && d.lesson_text.length > 10, day);
    assert.ok(d.scenarios.length >= 2 && d.scenarios.length <= 3, `${day} scenarios`);
    assert.ok(d.events.length >= 1, day);
    const sentences = d.driver_summary.split(/(?<=[.!?])\s+/).filter(Boolean).length;
    assert.ok(sentences >= 2 && sentences <= 3, `${day} driver_summary has ${sentences} sentences`);
    assert.ok(d.driver_keywords.length >= 3);

    const pre = [d.briefing, d.lesson, d.lesson_text, ...d.events.map((e) => `${e.time} ${e.label}`), ...d.scenarios.map((x) => `${x.name} ${x.if} ${x.tape}`)].join(' \n ');
    assert.doesNotMatch(pre, /\bsettled\b|\bsettle(?:ment)? price\b|fell to|rallied to|closed at|closes at|ended the day|finished (?:up|down|at)|by the close|session (?:high|low) of/i, `${day}: outcome wording`);
    for (const n of own[day]) assert.equal(pre.includes(n), false, `${day}: briefing contains its own settle ${n}`);
    // and not the day's actual last trade or extremes from the baked data
    for (const data of [CL, BZ]) {
      const bars = data.days[day];
      for (const v of [bars.at(-1).c, Math.max(...bars.map((b) => b.h)), Math.min(...bars.map((b) => b.l))]) {
        assert.equal(pre.includes(v.toFixed(2)), false, `${day}: briefing contains ${v.toFixed(2)} from that day's tape`);
      }
    }
    // the briefing panel never contains the debrief-only driver summary
    const html = briefingHtml({ day, product: 'CL', coachDay: d, carried: null, priorClose: null, overnight: [] });
    assert.ok(html.includes(d.lesson) && html.includes(d.scenarios[0].name));
    assert.equal(html.includes(d.driver_summary.slice(0, 40)), false, `${day}: driver_summary leaked into the briefing`);
    for (const k of ['driver_summary', 'driver_keywords']) assert.equal(html.includes(k), false);
  }
  assert.match(COACH_FILE.days['2026-10-27'].briefing, /^Settles Mon: WTI 101\.76, Brent 115\.81/, 'the prior day settle is allowed');
});

// ------------------------------------------------------------------ (5) debrief journal + carried rule
test('DEBRIEF: answers persist in the journal and the carried rule opens the next briefing', () => {
  const st = memStorage();
  assert.equal(carriedRule(st), null);
  assert.equal(DEBRIEF_QUESTIONS.length, 5);
  const answers = ['Diplomacy headlines', 'The 08:05 bar', 'Impulse', 'At 10:10; I was against it', 'Two sources before I trade a deal headline'];
  saveJournal({ playedAt: 'p1', day: '2026-10-27', product: 'CL', answers, named: true, rule: answers[4] }, st);
  // survives a "reload": read back through fresh calls on the same storage
  const j = loadJournal(st);
  assert.equal(j.length, 1);
  assert.deepEqual(j[0].answers, answers);
  assert.deepEqual(carriedRule(st), { rule: 'Two sources before I trade a deal headline', day: '2026-10-27', product: 'CL' });

  const html = briefingHtml({ day: '2026-10-28', product: 'CL', coachDay: COACH_FILE.days['2026-10-28'], carried: carriedRule(st),
    priorClose: { day: '2026-10-27', value: '99.84' }, overnight: [{ when: '06:00', text: 'An overnight headline' }] });
  const at = html.indexOf('Two sources before I trade a deal headline');
  assert.ok(at >= 0 && at < html.indexOf('Where we are'), 'carried rule is at the top of the next briefing');
  assert.ok(html.includes('Your rule from 2026-10-27') && html.includes('An overnight headline') && html.includes('09:30'));
  assert.ok(html.includes('CL last traded 99.84 at the 2026-10-27 pit close'));

  // the newest rule wins
  saveJournal({ playedAt: 'p2', day: '2026-10-28', product: 'CL', answers, named: false, rule: 'Size down after a washout' }, st);
  assert.equal(carriedRule(st).rule, 'Size down after a washout');

  assert.equal(namedDriver('It was the diplomacy talk again', COACH_FILE.days['2026-10-27'].driver_keywords), true);
  assert.equal(namedDriver('Inventories', COACH_FILE.days['2026-10-27'].driver_keywords), false);

  const { s } = scriptedSession();
  const pre = debriefPrefill(s, processScore(s));
  assert.equal(pre.length, 5);
  assert.match(pre[0], /^\[5 headlines printed; you entered 4 times and passed 3\]$/);
  assert.match(pre[2], /first entry: 07:30 BUY 1 @ 80\.02, signal "None, discretionary"/);
  assert.match(pre[3], /at the 10:10 high you were long 1/);
  assert.match(pre[4], /process 70 \(C\); biggest deduction: revenge/);
});

