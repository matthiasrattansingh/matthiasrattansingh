// FORECAST data + engine tests: `node scripts/test-forecast.mjs` (part of `npm test`).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as E from '../src/forecast/engine.js';

const fc = JSON.parse(readFileSync(new URL('../src/data/forecast.json', import.meta.url)));
const P = fc.petroleum;
const G = fc.gas;
const pc = E.classesFor(fc, 'petroleum');
const gc = E.classesFor(fc, 'gas');
const week = (recs, w) => recs.find((r) => r.week_ending === w);
let n = 0;
const ok = (name, fn) => { fn(); n++; if (process.env.VERBOSE) console.log('✓', name); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---------- the real dataset ----------
ok('at least 3 years of weekly prints, both reports, every record sourced', () => {
  assert.ok(P.length >= 150 && G.length >= 150);
  for (const r of [...P, ...G]) assert.ok(r.source && r.source.includes(r.week_ending));
  assert.ok(fc.sources.petroleum.includes('WCESTUS1') && fc.sources.gas.includes('NW2_EPG0_SWO_R48_BCF'));
});

ok('anchor: week ending 28 Jul 2023, crude -17.0 MMbbl, the largest draw on record and in the set', () => {
  const r = week(P, '2023-07-28');
  near(r.crude, -17.049, 0.001, 'crude change');
  assert.equal(r.class, 'HUGE');
  assert.equal(Math.min(...P.map((x) => x.crude)), r.crude);
  assert.equal(r.release_date, '2023-08-02');
  near(r.wti.settle, 79.49, 0.02, 'WTI settle 2 Aug 2023');
  assert.equal(r.api, -15.4);
  assert.equal(r.consensus, -1.4);
});

ok('anchor: week ending 6 Jan 2023, crude +19.0 MMbbl build (third-largest on record)', () => {
  const r = week(P, '2023-01-06');
  near(r.crude, 18.962, 0.002, 'crude change');
  assert.equal(Math.max(...P.map((x) => x.crude)), r.crude, 'largest build in the set');
  assert.equal(r.api, 14.865);
});

ok('anchor: week ending 10 Feb 2023, crude +16.3 MMbbl on a record adjustment', () => {
  const r = week(P, '2023-02-10');
  near(r.crude, 16.283, 0.001, 'crude change');
  assert.ok(r.adjustment > 10, 'Reuters flagged an unusually large adjustment that week');
});

ok('anchor: Winter Storm Heather, gas storage -326 Bcf for week ending 19 Jan 2024', () => {
  const r = week(G, '2024-01-19');
  assert.equal(r.change, -326);
  assert.equal(r.class, 'HUGE');
  assert.equal(r.release_date, '2024-01-25');
  assert.ok(week(P, '2024-01-19').regime.some((t) => t.tag === 'freeze'));
});

ok('release dates follow the schedule and move for holidays (Juneteenth 2024 -> Thursday)', () => {
  const r = week(P, '2024-06-14');
  assert.equal(r.release_date, '2024-06-20');
  assert.ok(r.regime.some((t) => t.tag === 'holiday'));
  for (const x of P) assert.ok(x.wti.date >= x.release_date && new Date(`${x.wti.date}T12:00`).getDay() % 6 !== 0);
});

ok('SPR release weeks are tagged from EIA SPR data (2022 drawdown)', () => {
  const spr = P.filter((r) => r.regime.some((t) => t.tag === 'spr_release'));
  assert.ok(spr.length >= 20);
  assert.ok(spr.every((r) => r.spr_chg <= -2));
});

// ---------- size classes and real base rates ----------
ok('classes are on |change| with the brief thresholds; base rates are computed, not picked', () => {
  assert.equal(E.classOf(0.99, pc), 'FLAT');
  assert.equal(E.classOf(-1, pc), 'NORMAL');
  assert.equal(E.classOf(3, pc), 'BIG');
  assert.equal(E.classOf(-7.01, pc), 'HUGE');
  for (const [kind, recs, cl, key] of [['petroleum', P, pc, 'crude'], ['gas', G, gc, 'gas']]) {
    const real = E.baseRates(recs, kind, cl);
    near(Object.values(real).reduce((a, b) => a + b), 1, 1e-9, 'rates sum');
    for (const c of E.CLASS_NAMES) near(fc.base_rates[key][c], real[c], 1e-3, `${kind} ${c}`);
  }
});

ok('the feed deck mirrors the real class mix in every block, and covers every week once', () => {
  for (const [kind, recs, cl] of [['petroleum', P, pc], ['gas', G, gc]]) {
    const rates = E.baseRates(recs, kind, cl);
    const deck = E.buildDeck(kind, recs, cl, { seed: 'test' });
    assert.equal(new Set(deck).size, recs.length);
    const byId = new Map(recs.map((r) => [r.id, r]));
    for (let b = 0; b + E.BLOCK <= 100; b += E.BLOCK) {
      const q = E.blockQuota(rates, b / E.BLOCK);
      const cnt = Object.fromEntries(E.CLASS_NAMES.map((c) => [c, 0]));
      for (const id of deck.slice(b, b + E.BLOCK)) cnt[E.classOf(E.actualOf(kind, byId.get(id)), cl)]++;
      assert.deepEqual(cnt, q, `${kind} block ${b / E.BLOCK}`);
    }
    // 100 cards: every class within a card of the dataset's real share.
    const first = deck.slice(0, 100).map((id) => E.classOf(E.actualOf(kind, byId.get(id)), cl));
    for (const c of E.CLASS_NAMES) near(first.filter((x) => x === c).length / 100, rates[c], 0.01, `${kind} ${c} share`);
  }
});

// ---------- drivers and the dominant cause ----------
ok('driver clues come from stored fields, API only where published', () => {
  const r = week(P, '2023-07-28');
  const clues = E.driverClues('petroleum', r);
  assert.deepEqual(clues.map((c) => c.key), ['util', 'imports', 'exports', 'prod', 'api']);
  assert.ok(!E.driverClues('petroleum', week(P, '2024-06-14')).some((c) => c.key === 'api'));
  assert.ok(clues.every((c) => !c.text.includes('2023')), 'no date leaks into the clues');
});

ok('the -17M draw was exports, not demand', () => {
  const d = E.dominantDriver('petroleum', week(P, '2023-07-28'));
  assert.equal(d.key, 'exports');
  assert.match(d.text, /exports, not demand: exports \+0\.69 MMb\/d w\/w/);
});

// ---------- the price-move link ----------
ok('priced in: the -17M draw week, WTI fell on release day; API telegraphed it, risk-off macro', () => {
  const rx = E.reaction('petroleum', week(P, '2023-07-28'));
  assert.equal(rx.naive, 'UP');
  assert.equal(rx.actual, 'DOWN');
  assert.equal(rx.matched, false);
  assert.deepEqual(rx.reasons.map((x) => x.key), ['api', 'macro']);
  assert.ok(rx.price.next_chg > 0, 'and bounced the next day');
});

ok('the naive "draw = up" rule is close to a coin flip on real release days', () => {
  for (const [kind, recs] of [['petroleum', P], ['gas', G]]) {
    const hit = recs.filter((r) => E.reaction(kind, r).matched).length / recs.length;
    assert.ok(hit > 0.35 && hit < 0.65, `${kind} naive hit rate ${hit}`);
  }
});

// ---------- scoring ----------
ok('PRINT stats: MAE, repeat-last baseline, consensus only on stored weeks, error by class', () => {
  const ids = ['2023-07-28', '2023-01-06', '2024-06-14'].map((w) => week(P, w).id);
  const idx = new Map(P.map((r, i) => [r.id, i]));
  // Guessing exactly last week's print scores exactly the repeat-last baseline.
  const echo = Object.fromEntries(ids.map((id) => [id, P[idx.get(id) - 1].crude]));
  const s = E.printStats('petroleum', P, pc, echo);
  assert.equal(s.n, 3);
  near(s.mae, s.baselines.repeatLast, 1e-9, 'echo = baseline');
  assert.equal(s.baselines.consensus.n, 2, 'consensus stored for 2 of these weeks');
  assert.equal(s.byClass.HUGE.n, 2);
  // Perfect guesses: zero error, calibration exact.
  const perfect = E.printStats('petroleum', P, pc, Object.fromEntries(ids.map((id) => [id, P[idx.get(id)].crude])));
  assert.equal(perfect.mae, 0);
  near(perfect.avgGuessSize, perfect.avgActualSize, 1e-9, 'calibration');
});

ok('REACTION stats score the direction call separately', () => {
  const r = week(P, '2023-07-28');
  const s = E.reactionStats('petroleum', P, { [r.id]: 'DOWN', [week(P, '2023-01-06').id]: 'UP' });
  assert.equal(s.n, 2);
  assert.equal(s.right, 1 + (week(P, '2023-01-06').wti.chg > 0 ? 1 : 0));
});

// ---------- agents on the same real weeks ----------
ok('agents never read a later week (corrupting the future changes nothing)', () => {
  for (const [kind, recs] of [['petroleum', P], ['gas', G]]) {
    for (const i of [30, 120, recs.length - 2]) {
      const clean = E.agentForecasts(kind, recs, i);
      const poisoned = recs.map((r, j) => (j > i ? { ...r, crude: 999, change: 999, contrib: {}, api: 999, avg5_change: 999 } : r));
      assert.deepEqual(E.agentForecasts(kind, poisoned, i), clean);
    }
  }
});

ok('archetypes: Mo repeats last week, Carla fades the API, Dan calls a tail every week', () => {
  const i = P.findIndex((r) => r.week_ending === '2023-07-28');
  const f = E.agentForecasts('petroleum', P, i);
  near(f.mo, P[i - 1].crude, 0.05, 'Mo');
  near(f.carla, 7.7, 0.05, 'Carla fades API -15.4');
  for (let k = 0; k < P.length; k++) assert.ok(Math.abs(E.agentForecasts('petroleum', P, k).dan) >= 9, 'Dan always tails');
});

ok("long run on the real dataset: Quinn is tightest, Dan's tails cost the most", () => {
  for (const [kind, recs, cl] of [['petroleum', P, pc], ['gas', G, gc]]) {
    const s = E.agentSeason(kind, recs, cl);
    assert.ok(s.quinn.mae < s.mo.mae && s.quinn.mae < s.carla.mae && s.quinn.mae < s.dan.mae, `${kind} Quinn best`);
    assert.ok(s.dan.mae > s.mo.mae && s.dan.mae > s.carla.mae, `${kind} Dan worst`);
    assert.ok(s.dan.byClass.FLAT > 3 * s.quinn.byClass.FLAT, 'Dan pays on boring weeks');
  }
});

console.log(`forecast tests: ${n} passed ✓`);
