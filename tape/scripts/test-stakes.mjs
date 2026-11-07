// Scoring rules, stakes and challenge tests: `node scripts/test-stakes.mjs` (part of `npm test`).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { RULES, limitState, limitsFor, lockSim, lockedPnl, maxDrawdown, verdict } from '../src/game/rules.js';
import { canWager, cancelWager, placeWager, settleWager } from '../src/game/wager.js';
import { challengeFromSearch, challengeKey, challengeUrl, compare, decodeChallenge, encodeChallenge, newSeed } from '../src/challenge/link.js';
import { toEntry } from '../src/challenge/leaderboard.js';
import { EXEC, execute, executeAll, hardenSession, livePrice } from '../src/trade/execution.js';
import { buildSession, simulate } from '../src/trade/engine.js';
import { habits, isHard, frontRunner, recordAdapt, trapOf, trapWeight } from '../src/game/adaptive.js';
import { applyDecay, bellStreak } from '../src/game/streaks.js';
import { printXp, tolerance } from '../src/forecast/engine.js';
import { emptyProgress } from '../src/lib/progress.js';
import { qrMatrix } from '../src/challenge/scorecard.js';

const json = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url)));
const callit = json('callit.json').cards;
const sessions = callit.map(buildSession);
let n = 0;
const ok = (name, fn) => { fn(); n++; if (process.env.VERBOSE) console.log('✓', name); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
const BOTS = [{ id: 'mo', pnl: 1500 }, { id: 'carla', pnl: -400 }, { id: 'quinn', pnl: 2200 }, { id: 'dan', pnl: -3000 }];

// ---------- 4. winning redefined ----------
ok('WIN needs all three: beat the best bot, beat the passive benchmark, drawdown inside the budget', () => {
  const lim = limitsFor(100_000);
  const passive = { pnl: 1800, label: 'hold long 2 lots' };
  const all = verdict({ pnl: 2500, bots: BOTS, passive, maxDD: 900, budget: lim.budget });
  assert.equal(all.win, true);
  assert.deepEqual(all.checks.map((c) => c.pass), [true, true, true]);
  assert.equal(all.checks[0].who, 'quinn');
  // Fail each one alone.
  assert.deepEqual(verdict({ pnl: 2100, bots: BOTS, passive: { ...passive, pnl: 0 }, maxDD: 0, budget: lim.budget }).checks.map((c) => c.pass), [false, true, true]);
  assert.deepEqual(verdict({ pnl: 2500, bots: BOTS, passive: { ...passive, pnl: 3000 }, maxDD: 0, budget: lim.budget }).checks.map((c) => c.pass), [true, false, true]);
  assert.deepEqual(verdict({ pnl: 2500, bots: BOTS, passive, maxDD: 2501, budget: lim.budget }).checks.map((c) => c.pass), [true, true, false]);
  // A tie with the best bot is not a beat.
  assert.equal(verdict({ pnl: 2200, bots: BOTS, passive, maxDD: 0, budget: lim.budget }).win, false);
});

ok('one lucky max-size bet cannot win: big P&L after a deep hole fails the risk budget', () => {
  const lim = limitsFor(100_000);
  const curve = [-1200, -2900, -2400, 4000, 9000]; // survived a −$2.9k hole, then ran
  const dd = maxDrawdown(curve);
  assert.equal(dd, 2900);
  const v = verdict({ pnl: 9000, bots: BOTS, passive: { pnl: 1000, label: 'x' }, maxDD: dd, budget: lim.budget });
  assert.equal(v.checks[0].pass && v.checks[1].pass, true);
  assert.equal(v.win, false);
});

ok('max drawdown runs from a high-water mark that starts at zero', () => {
  assert.equal(maxDrawdown([]), 0);
  assert.equal(maxDrawdown([500, 1500, 700, 2000, 1900]), 800);
  assert.equal(maxDrawdown([-300, -100, -800]), 800);
});

// ---------- 3. prop-firm loss limits ----------
ok('limits scale with starting equity: 3% daily loss, 4% trailing, 2.5% risk budget', () => {
  assert.deepEqual(limitsFor(100_000), { daily: 3000, trailing: 4000, budget: 2500 });
  assert.equal(limitsFor(250_000).daily, 250_000 * RULES.dailyLossPct);
  assert.ok(limitsFor(100_000).budget < limitsFor(100_000).trailing, 'budget is tighter than the cap');
});

ok('daily loss limit hits at −3% and locks the score where it hit', () => {
  const lim = limitsFor(100_000);
  assert.equal(limitState({ pnl: -2999, peak: 0 }, lim).hit, null);
  const st = limitState({ pnl: -3000, peak: 0 }, lim);
  assert.equal(st.hit, 'daily');
  assert.equal(st.daily, 1);
  // Walk a P&L path: the session ends at the first point a limit hits.
  const path = [-500, -1800, -3100, 2000];
  let peak = 0;
  let locked = null;
  for (const p of path) { peak = Math.max(peak, p); if (limitState({ pnl: p, peak }, lim).hit) { locked = p; break; } }
  assert.equal(locked, -3100, 'the later recovery never happens');
});

ok('trailing drawdown cap hits 4% below the session high, even while still in profit', () => {
  const lim = limitsFor(100_000);
  const st = limitState({ pnl: 1000, peak: 5000 }, lim);
  assert.equal(st.hit, 'trailing');
  assert.equal(st.daily, 0);
  assert.equal(limitState({ pnl: 1001, peak: 5000 }, lim).hit, null);
  near(limitState({ pnl: 3000, peak: 5000 }, lim).trailing, 0.5, 1e-9, 'meter at half');
});

ok('bots and the passive benchmark trade under the same limits: their P&L locks where one hits', () => {
  const lim = limitsFor(100_000);
  assert.deepEqual(lockedPnl([1000, -2000, -3200, 50_000], lim), { pnl: -3200, hit: 'daily', at: 2 });
  assert.deepEqual(lockedPnl([6000, 1900, 9000], lim), { pnl: 1900, hit: 'trailing', at: 1 });
  assert.deepEqual(lockedPnl([500, 900], lim), { pnl: 900, hit: null, at: null });
  const sim = { curve: [100, -3100, 20_000], final: 20_000 };
  const locked = lockSim(sim, lim);
  assert.equal(locked.final, -3100);
  assert.deepEqual(locked.curve, [100, -3100, -3100]);
});

// ---------- 7. wagers ----------
ok('wager math: stake is escrowed; win takes the pot (+stake), loss loses it, a tie returns it', () => {
  const p0 = { ...emptyProgress(), xp: 200 };
  const placed = placeWager(p0, 'dan', 50);
  assert.equal(placed.xp, 150, 'escrowed');
  assert.deepEqual(placed.wager.bot, 'dan');
  const win = settleWager(placed, { pnl: 1000, bots: [{ id: 'dan', pnl: 999 }] });
  assert.equal(win.progress.xp, 250);
  assert.equal(win.result.net, 50);
  assert.equal(win.progress.wager, null);
  assert.ok(win.progress.chat.msgs.at(-1).bot === 'dan');
  const lose = settleWager(placed, { pnl: -10, bots: [{ id: 'dan', pnl: 0 }] });
  assert.equal(lose.progress.xp, 150);
  assert.equal(lose.result.net, -50);
  const push = settleWager(placed, { pnl: 7, bots: [{ id: 'dan', pnl: 7 }] });
  assert.equal(push.progress.xp, 200);
  assert.equal(push.result.net, 0);
});

ok('wager rules: no stake above your XP, one wager at a time, cancel refunds', () => {
  const p0 = { ...emptyProgress(), xp: 40 };
  assert.equal(canWager(p0, 50), false);
  assert.equal(placeWager(p0, 'mo', 50), p0);
  const placed = placeWager(p0, 'mo', 25);
  assert.equal(placeWager(placed, 'carla', 10), placed, 'no second wager');
  assert.equal(cancelWager(placed).xp, 40);
  assert.equal(settleWager(p0, { pnl: 1, bots: [] }).result, null);
});

// ---------- 10. challenge links ----------
ok('challenge link round trip: encode → decode gives the identical run', () => {
  const run = { id: 'ci-wti-negative-2020', kind: 'paper', seed: 'k3j9x0aa', hard: true, name: 'Matthias R.', pnl: 12345, win: true, bots: BOTS };
  const back = decodeChallenge(encodeChallenge(run));
  assert.deepEqual(back, { v: 1, id: run.id, kind: 'paper', seed: run.seed, hard: true, name: 'Matthias R.', pnl: 12345, win: true, bots: BOTS, fade: null });
  const cargo = decodeChallenge(encodeChallenge({ ...run, kind: 'cargo', hard: false, fade: 'Rotterdam', name: 'Zoë ⛽' }));
  assert.equal(cargo.fade, 'Rotterdam');
  assert.equal(cargo.name, 'Zoë ⛽');
});

ok('challenge URL works on static hosting: query string in, run out; garbled links are rejected', () => {
  const run = { id: 'ci-abqaiq-2019', kind: 'paper', seed: newSeed(() => 0.5), hard: false, name: 'M', pnl: -2500, win: false, bots: [] };
  const url = challengeUrl(run, 'https://matthiasrattansingh.github.io/matthiasrattansingh/');
  assert.ok(url.startsWith('https://matthiasrattansingh.github.io/matthiasrattansingh/?c='));
  const back = challengeFromSearch(new URL(url).search);
  assert.equal(back.id, run.id);
  assert.equal(back.pnl, -2500);
  const code = encodeChallenge(run);
  assert.equal(decodeChallenge(code.slice(0, -1) + (code.at(-1) === 'a' ? 'b' : 'a')), null, 'bad checksum');
  assert.equal(decodeChallenge('not-a-code'), null);
  assert.equal(decodeChallenge(''), null);
  assert.ok(url.length < 400, `short enough for a QR code (${url.length})`);
  assert.ok(qrMatrix(url).length >= 21);
});

ok('challenge key groups the exact scenario; the end screen compares head to head', () => {
  const a = { id: 'x', seed: 's1', hard: false };
  assert.equal(challengeKey(a), challengeKey({ ...a, pnl: 9 }));
  assert.notEqual(challengeKey(a), challengeKey({ ...a, hard: true }));
  assert.deepEqual(compare(1500, 1200), { diff: 300, outcome: 'win' });
  assert.deepEqual(compare(-10, 0), { diff: -10, outcome: 'lose' });
  assert.equal(compare(5, 5).outcome, 'tie');
  const e = toEntry({ ...a, kind: 'paper', name: 'M', pnl: 10.4, win: true }, 7);
  assert.deepEqual(Object.keys(e).sort(), ['at', 'checks', 'hard', 'id', 'key', 'kind', 'name', 'pnl', 'seed', 'v', 'win']);
  assert.equal(e.pnl, 10);
});

// ---------- 2. execution costs (and why a challenge replays identically) ----------
ok('execution is seeded: same seed, same live ticks and fills; another seed differs', () => {
  const s = sessions[0];
  const a = execute(s, 0, { type: 'OPEN', side: 'LONG', lots: 5 }, { ms: 1700, seed: 'abc' });
  const b = execute(s, 0, { type: 'OPEN', side: 'LONG', lots: 5 }, { ms: 1700, seed: 'abc' });
  assert.deepEqual(a, b);
  assert.notEqual(livePrice(s, 0, 1700, 'abc'), livePrice(s, 0, 1700, 'xyz'));
  assert.equal(livePrice(s, 0, 0, 'abc'), s.p0, 'no time, no tick');
});

ok('slippage: buys fill above the live price, sells below; news widens the spread 3×; front-running adds more', () => {
  const s = sessions.find((x) => x.unit === '$/bbl' && x.news.length);
  const buy = execute(s, 1, { type: 'OPEN', side: 'LONG', lots: 1 }, { seed: 'q' }).cost;
  const sell = execute(s, 1, { type: 'OPEN', side: 'SHORT', lots: 1 }, { seed: 'q' }).cost;
  assert.ok(buy.fill > buy.mid && sell.fill < sell.mid);
  const k = s.news[0].at;
  const plain = [...Array(s.C).keys()].find((i) => !s.news.some((x) => x.at === i));
  near(execute(s, k, { type: 'OPEN', side: 'LONG', lots: 1 }, { seed: 'q' }).cost.slip, EXEC.halfSpreadBbl * EXEC.newsSpreadMult, 1e-12, 'news spread');
  near(execute(s, plain, { type: 'OPEN', side: 'LONG', lots: 1 }, { seed: 'q' }).cost.slip, EXEC.halfSpreadBbl, 1e-12, 'normal spread');
  near(execute(s, plain, { type: 'OPEN', side: 'LONG', lots: 1 }, { seed: 'q', frontRun: true }).cost.slip, EXEC.halfSpreadBbl + EXEC.frontRunBbl, 1e-12, 'front-run');
});

ok('partial fills above 2 lots; small orders fill in full; costs flow into P&L', () => {
  const s = sessions[3];
  for (const seed of ['a', 'b', 'c', 'd']) {
    const big = execute(s, 0, { type: 'OPEN', side: 'LONG', lots: 10 }, { seed }).action;
    assert.ok(big.lots >= 2 && big.lots < 10, `partial ${big.lots}`);
  }
  assert.equal(execute(s, 0, { type: 'OPEN', side: 'LONG', lots: 2 }, { seed: 'a' }).action.lots, 2);
  // Round trip with costs loses exactly the two half-spreads on a flat price.
  const plain = simulate(s, [{ type: 'OPEN', side: 'LONG', lots: 2 }, { type: 'CLOSE' }]).final;
  const costed = simulate(s, executeAll(s, [{ type: 'OPEN', side: 'LONG', lots: 2 }, { type: 'CLOSE' }], { seed: 'z' })).final;
  assert.ok(costed < plain, 'execution costs money');
});

// ---------- 1. adaptive bots and hard mode ----------
ok('hard mode keeps the real final close, fakes the first move and adds a reversing headline', () => {
  for (const s of sessions.slice(0, 12)) {
    const h = hardenSession(s, 'seed1');
    assert.equal(h.candles.at(-1).c, s.candles.at(-1).c, `${s.id} final close real`);
    assert.deepEqual(hardenSession(s, 'seed1'), h, 'seeded');
    assert.ok(h.news.some((x) => x.fake));
    assert.ok(h.label.includes('HARD'));
    h.candles.forEach((c, i) => { assert.ok(c.h >= Math.max(c.o, c.c) - 1e-9 && c.l <= Math.min(c.o, c.c) + 1e-9, 'valid OHLC'); if (i) assert.equal(c.o, h.candles[i - 1].c); });
  }
});

ok('win rate over 65% on a type (5+ sessions) serves the hard tape; bots read habits and front-run them', () => {
  let p = emptyProgress();
  const s = sessions.find((x) => x.card.category === 'crude');
  const card = s.card;
  // Five crude sessions, four wins, each time fading the move and chasing a news candle.
  for (let k = 0; k < 5; k++) {
    const into = s.history.at(-1) - s.history.at(-4);
    const fade = into > 0 ? 'SHORT' : 'LONG';
    p = recordAdapt(p, { card, s, decisions: [{ type: 'OPEN', side: fade, lots: 5 }], win: k !== 2, pnl: 100 });
  }
  assert.equal(isHard(p, 'crude'), true);
  assert.equal(isHard(p, 'spreads'), false);
  const h = habits(p);
  assert.ok(h.some((x) => x.key === 'faded' && x.bot === 'carla'));
  assert.ok(h.some((x) => x.key === 'oversize'), 'oversized right after wins');
  assert.equal(frontRunner(h, s, 0, { type: 'OPEN', side: 'LONG', lots: 1 }, null) !== null, true);
});

ok('priced-in traps are found in the real data and weighted up when you fall for them', () => {
  const traps = sessions.filter((s) => trapOf(s));
  assert.ok(traps.length >= 3 && traps.length < sessions.length, `${traps.length} traps`);
  const t = trapOf(traps[0]);
  assert.ok(['ran-before', 'headline'].includes(t.kind) && t.text.startsWith('Priced-in trap'));
  const fresh = emptyProgress();
  assert.equal(trapWeight(fresh), 0.15);
  const burnt = { ...fresh, adapt: { sessions: [], traps: { seen: 6, fell: 5 } } };
  assert.ok(trapWeight(burnt) > 0.4);
});

// ---------- 8. streaks and decay ----------
ok('OPEN BELL streak counts consecutive days ending today or yesterday', () => {
  const bell = (dates) => ({ ...emptyProgress(), bell: Object.fromEntries(dates.map((d) => [d, { saved: { result: { pnl: 1 } } }])) });
  assert.equal(bellStreak(bell(['2026-11-05', '2026-11-06', '2026-11-07']), '2026-11-07'), 3);
  assert.equal(bellStreak(bell(['2026-11-05', '2026-11-06']), '2026-11-07'), 2, "today's still open");
  assert.equal(bellStreak(bell(['2026-11-03', '2026-11-06']), '2026-11-07'), 1);
  assert.equal(bellStreak(bell([]), '2026-11-07'), 0);
});

ok('XP decays 2% per skipped day (cap 20%), once, never charging the same day twice', () => {
  const p = { ...emptyProgress(), xp: 1000, streak: { count: 3, best: 3, last: '2026-11-01' } };
  const a = applyDecay(p, '2026-11-04'); // missed 2nd and 3rd
  assert.equal(a.progress.xp, 960);
  assert.equal(applyDecay(a.progress, '2026-11-04').progress.xp, 960, 'once a day');
  const b = applyDecay(a.progress, '2026-11-05'); // still away: only the 4th is new
  assert.equal(b.progress.xp, 960 - Math.round(960 * 0.02));
  const long = applyDecay({ ...p, streak: { ...p.streak, last: '2026-09-01' } }, '2026-11-01');
  assert.equal(long.progress.xp, 800, 'capped at 20%');
  assert.equal(applyDecay({ ...p, streak: { ...p.streak, last: '2026-11-03' } }, '2026-11-04').progress.xp, 1000, 'played yesterday');
});

// ---------- 6. forecast bands tighten ----------
ok('forecast band tightens with experience and shrinks again for overcalling (7.1 vs 3.7)', () => {
  assert.equal(tolerance('petroleum', null).band, 1);
  const calibrated = { n: 60, avgGuessSize: 3.8, avgActualSize: 3.7 };
  near(tolerance('petroleum', calibrated).band, 0.5, 1e-9, 'experience halves it');
  const over = { n: 60, avgGuessSize: 7.1, avgActualSize: 3.7 };
  const t = tolerance('petroleum', over);
  assert.equal(t.overcalling, true);
  near(t.band, 0.5 * (3.7 / 7.1), 1e-9, 'overcall ratio');
  // Same 0.6 MMbbl miss: full XP when calibrated-new, less when overcalling.
  assert.equal(printXp('petroleum', 0.6, { n: 5, avgGuessSize: 3, avgActualSize: 3.5 }), 15);
  assert.ok(printXp('petroleum', 0.6, over) < 15);
  assert.equal(tolerance('gas', { n: 0 }).band, 10);
});

console.log(`stakes tests: ${n} passed ✓`);
