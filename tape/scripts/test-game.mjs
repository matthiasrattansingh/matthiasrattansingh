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

// ---------- step 2: quests ----------
const { makeQuests, checkQuests, ensureQuests, TEMPLATES } = await import('../src/game/quests.js');
const { newLeague, botXp, standings, ensureLeague, passCheck, SEATS, mondayOf } = await import('../src/game/league.js');
const info = (over = {}) => ({ session: abq, pnl: 0, stats: { traded: true, maxDD: 0, warned: false }, bots: [{ id: 'mo', pnl: 0 }, { id: 'carla', pnl: 0 }, { id: 'quinn', pnl: 0 }, { id: 'dan', pnl: 0 }], marginCall: false, ...over });

ok('3 distinct quests per day, same for the same date', () => {
  const a = makeQuests('2026-11-06');
  assert.equal(a.length, 3); assert.equal(new Set(a.map((q) => q.t)).size, 3);
  assert.deepEqual(a, makeQuests('2026-11-06'));
  const seen = new Set(); for (let d = 1; d <= 28; d++) makeQuests(`2026-02-${String(d).padStart(2, '0')}`).forEach((q) => seen.add(q.t));
  assert.equal(seen.size, Object.keys(TEMPLATES).length);
});
ok('quests pay $1,000 + XP once', () => {
  let p = { ...emptyProgress(), quests: { date: 'D', list: [{ t: 'earnX', x: 10000, done: false }, { t: 'lowDD', done: false }, { t: 'beatBot', bot: 'dan', done: false }] } };
  let out = checkQuests(p, info({ pnl: 12000, stats: { traded: true, maxDD: 9000, warned: false }, bots: [{ id: 'dan', pnl: 20000 }] }), 'D');
  assert.equal(out.progress.bankroll, 101000); assert.equal(out.events.length, 1); assert.equal(out.progress.xp, 40);
  out = checkQuests(out.progress, info({ pnl: 12000, stats: { traded: true, maxDD: 100, warned: false }, bots: [{ id: 'dan', pnl: 0 }] }), 'D');
  assert.equal(out.progress.bankroll, 103000); // lowDD + beatBot now; earnX not paid twice
  assert.ok(out.progress.quests.list.every((q) => q.done));
});
ok('spread / no-warning quest rules', () => {
  const spreadSess = buildSession(cards.find((c) => c.type === 'spread'));
  assert.ok(TEMPLATES.spreadWin.check({}, info({ session: spreadSess, pnl: 1 })));
  assert.ok(!TEMPLATES.spreadWin.check({}, info({ pnl: 1 })));
  assert.ok(!TEMPLATES.noWarning.check({}, info({ stats: { traded: true, warned: true } })));
  assert.ok(!TEMPLATES.noWarning.check({}, info({ stats: { traded: false, warned: false } })));
});
ok('new day = new quests', () => {
  const p = ensureQuests(ensureQuests(emptyProgress(), '2026-11-06'), '2026-11-07');
  assert.equal(p.quests.date, '2026-11-07');
});

// ---------- step 2: league ----------
const mon = new Date(2026, 10, 2, 0, 0); // Monday 2 Nov 2026
const at = (day, hour) => new Date(2026, 10, 2 + day, hour);
ok('30 seats: 4 desk bots + 25 generated + you', () => {
  const lg = newLeague('Bronze', at(2, 12), 0);
  assert.equal(lg.members.length, SEATS - 1);
  assert.equal(new Set(lg.members.map((m) => m.name)).size, SEATS - 1);
  assert.ok(['mo', 'carla', 'quinn', 'dan'].every((id) => lg.members.some((m) => m.id === id)));
  assert.equal(lg.week, '2026-11-02'); assert.equal(mondayOf(at(6, 23)).getDate(), 2);
});
ok('bot XP only grows through the week; weekdays heavier; some binge late Sunday', () => {
  const lg = newLeague('Bronze', at(0, 9), 0);
  let weekday = 0; let weekend = 0;
  for (const m of lg.members) {
    let prev = 0;
    for (let h = 0; h < 7 * 24; h += 3) { const v = botXp(m, lg, new Date(mon.getTime() + h * 3600e3)); assert.ok(v >= prev); prev = v; }
    const d = (k) => botXp(m, lg, at(k + 1, 0)) - botXp(m, lg, at(k, 0));
    weekday += (d(0) + d(1) + d(2) + d(3) + d(4)) / 5; weekend += d(5);
  }
  assert.ok(weekday > weekend);
  const binger = lg.members.find((m) => m.sunday);
  assert.ok(binger, 'some bot binges on Sunday');
  assert.ok(botXp(binger, lg, at(6, 23)) - botXp(binger, lg, at(6, 17)) > binger.mean);
});
ok('week end: top 10 promote, bottom 5 demote, new league', () => {
  const base = { ...emptyProgress(), xp: 0 };
  const lg = newLeague('Silver', at(1, 10), 0);
  const top = ensureLeague({ ...base, league: lg, xp: 999999 }, at(8, 9));
  assert.equal(top.progress.league.tier, 'Gold'); assert.equal(top.progress.leagueHistory[0].result, 'promoted');
  assert.equal(top.progress.league.week, '2026-11-09');
  const bottom = ensureLeague({ ...base, league: lg, xp: 0 }, at(8, 9));
  assert.equal(bottom.progress.league.tier, 'Bronze'); assert.equal(bottom.progress.leagueHistory[0].result, 'demoted');
  const two = ensureLeague({ ...base, league: lg, xp: 0 }, at(15, 9)); // two weeks away: both closed
  assert.equal(two.progress.leagueHistory.length, 2);
});
ok('standings rank you and pass checks announce changes', () => {
  let p = { ...emptyProgress(), xp: 0, league: newLeague('Bronze', at(2, 12), 0) };
  const t = standings(p, at(2, 12));
  assert.equal(t.length, SEATS); assert.ok(t.find((r) => r.me));
  p = passCheck(p, at(2, 12)).progress; // first check just records who's ahead
  p = { ...p, xp: 100000 };
  const out = passCheck(p, at(2, 12));
  assert.match(out.events[0].text, /You passed/);
});

console.log(`game tests: ${n} passed ✓`);
