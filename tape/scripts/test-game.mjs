// Gamification-layer tests: `npm test`. Pure functions only.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { hydrate, emptyProgress, recordResult, startRide, cashOutRide, SAVE_VERSION } from '../src/lib/progress.js';
import { buildSession } from '../src/trade/engine.js';
import { bestAchievable, gradeFor, recordPlay } from '../src/game/collection.js';
import { pickNext } from '../src/game/order.js';
import { sizesFor } from '../src/game/ride.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url))).cards;
const cards = [...load('callit.json'), ...load('spreads.json')].filter((c) => c.session);
let n = 0;
const ok = (name, fn) => { fn(); n++; if (process.env.VERBOSE) console.log('✓', name); };
const sessionTrade = (pnl) => ({ cardId: 'x', category: 'crude', correct: pnl > 0, points: 5, trade: { pnl, win: pnl > 0, mult: 1, bots: [], session: true } });

// ---------- save migration ----------
ok('v1 save migrates without losing account, XP or records', () => {
  const v1 = { version: 1, xp: 777, bankroll: 187654, blowups: 2, bestCombo: 4, combo: 1, peak: 200000, bigWin: 30000,
    streak: { count: 3, best: 5, last: '2026-11-05' }, stats: { crude: { right: 10, total: 20 } }, misses: { a: { due: 1, step: 0 } },
    day: { date: '2026-11-05', you: 5, bots: {}, trades: 3 }, bell: { '2026-11-05': { saved: {} } } };
  const p = hydrate(v1);
  assert.equal(p.version, SAVE_VERSION);
  assert.equal(p.xp, 777); assert.equal(p.bankroll, 187654); assert.equal(p.blowups, 2); assert.equal(p.bestCombo, 4);
  assert.equal(p.streak.best, 5); assert.equal(p.stats.crude.right, 10); assert.ok(p.misses.a);
  assert.deepEqual(p.played, {}); assert.equal(p.ride.active, false);
});
ok('unknown/future save versions start fresh', () => assert.equal(hydrate({ version: 99, xp: 5 }).xp, 0));

// ---------- RIDE ----------
ok('ride moves profit out of the account into the ride', () => {
  const p = startRide(emptyProgress(), 13220);
  assert.equal(p.bankroll, 100000 - 13220); assert.equal(p.ride.balance, 13220); assert.equal(p.ride.active, true);
});
ok('winning while riding keeps the ride; RIDE again adds to it', () => {
  let p = startRide(emptyProgress(), 10000);
  p = recordResult(p, sessionTrade(5000));
  assert.equal(p.ride.active, true); assert.equal(p.bankroll, 95000);
  p = startRide(p, 5000);
  assert.equal(p.ride.balance, 15000); assert.equal(p.bankroll, 90000);
});
ok('a losing session forfeits the whole ride; the loss is paid from the ride first', () => {
  let p = startRide(emptyProgress(), 10000); // bank 90k, ride 10k
  p = recordResult(p, sessionTrade(-4000));
  assert.equal(p.ride.active, false); assert.equal(p.ride.balance, 0);
  assert.equal(p.bankroll, 90000); // 4k of the loss came out of the ride, the remaining 6k of ride is forfeited
  let q = startRide(emptyProgress(), 10000);
  q = recordResult(q, sessionTrade(-25000));
  assert.equal(q.bankroll, 90000 - 15000);
});
ok('concept bonuses never end a ride', () => {
  let p = startRide(emptyProgress(), 10000);
  p = recordResult(p, { cardId: 'c', category: 'concepts', correct: false, points: 0, trade: { pnl: 0, win: false, bots: [] } });
  assert.equal(p.ride.active, true);
});
ok('cash out returns the ride to the account', () => {
  const p = cashOutRide(startRide(emptyProgress(), 10000));
  assert.equal(p.bankroll, 100000); assert.equal(p.ride.active, false);
});
ok('ride adds lots: one per $10k on top of the largest size', () => {
  assert.deepEqual(sizesFor(emptyProgress()).sizes, [1, 2, 5]);
  const s = sizesFor(startRide(emptyProgress(), 23000));
  assert.deepEqual(s.sizes, [1, 2, 5, 7]); assert.equal(s.maxLots, 12);
  assert.deepEqual(sizesFor({ ...emptyProgress(), funded: true }).sizes, [1, 2, 5, 10, 25]);
});

// ---------- grades + order ----------
const abq = buildSession(cards.find((c) => c.id === 'ci-abqaiq-2019'));
ok('grades: S ≥90% of best achievable, A 70, B 45, C >0, D lost', () => {
  const best = bestAchievable(abq);
  assert.ok(best > 40000); // holding LONG 5 lots through Abqaiq
  assert.equal(gradeFor(best * 0.95, best), 'S'); assert.equal(gradeFor(best * 0.75, best), 'A');
  assert.equal(gradeFor(best * 0.5, best), 'B'); assert.equal(gradeFor(1, best), 'C'); assert.equal(gradeFor(-1, best), 'D');
});
ok('collection keeps the best run and its curve', () => {
  let p = recordPlay(emptyProgress(), abq, 1000, Array(abq.C).fill(1000));
  p = recordPlay(p, abq, 500, Array(abq.C).fill(500));
  assert.equal(p.played[abq.id].best, 1000); assert.equal(p.played[abq.id].plays, 2); assert.equal(p.played[abq.id].curve[0], 1000);
});
ok('order: unplayed first, then lowest grade, recent skipped', () => {
  let p = emptyProgress();
  const first = pickNext(p, cards);
  assert.ok(!p.played[first.id]);
  p = { ...p, played: Object.fromEntries(cards.map((c, i) => [c.id, { grade: i === 3 ? 'D' : i === 7 ? 'C' : 'S', at: i }])) };
  assert.equal(pickNext(p, cards).id, cards[3].id);
  assert.equal(pickNext(p, cards, { recent: [cards[3].id] }).id, cards[7].id);
});

console.log(`game tests: ${n} passed ✓`);
