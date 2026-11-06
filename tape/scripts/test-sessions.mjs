// Session engine tests: `npm test`. No browser needed.
// 1) Holding through every session reproduces the scenario's real outcome.
// 2) Engine actions (add/cut/close/flip, sell-vol) behave as specified.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { buildSession, simulate, act, emptyBook, botDecisions, decisionValues, gradeGrid } from '../src/trade/engine.js';
import { pnlCallIt, pnlSpread } from '../src/lib/book.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url))).cards;
const cards = [...load('callit.json'), ...load('spreads.json')].filter((c) => c.session);
let n = 0;
const ok = (name, fn) => { fn(); n++; if (process.env.VERBOSE) console.log('✓', name); };

ok('50 sessions present', () => assert.equal(cards.length, 50));

for (const c of cards) {
  const s = buildSession(c);
  ok(`${c.id}: hold reproduces real outcome`, () => {
    const held = simulate(s, [{ type: 'OPEN', side: 'LONG', lots: 2 }]).final;
    const expect = c.type === 'spread' ? pnlSpread(c, 'WIDEN', 2) : pnlCallIt(c, 'LONG', 2);
    assert.ok(Math.abs(held - expect) < 1, `${held} vs ${expect}`);
  });
  if (c.type !== 'spread') {
    ok(`${c.id}: sell-vol reproduces flat band`, () => {
      const vol = simulate(s, [{ type: 'OPEN', side: 'VOL', lots: 2 }]).final;
      assert.ok(Math.abs(vol - pnlCallIt(c, 'FLAT', 2)) < 1);
    });
  }
  ok(`${c.id}: bots trade deterministically`, () => {
    for (const b of ['mo', 'carla', 'quinn', 'dan']) {
      assert.equal(simulate(s, botDecisions(b, s, 'x')).final, simulate(s, botDecisions(b, s, 'x')).final);
    }
  });
}

const neg = buildSession(cards.find((c) => c.id === 'ci-wti-negative-2020'));
ok('short 5 through negative WTI = +$279,500', () => {
  assert.equal(Math.round(simulate(neg, [{ type: 'OPEN', side: 'SHORT', lots: 5 }]).final), 279500);
});
ok('add averages entry, cut halves, close flattens', () => {
  let b = act(emptyBook(), { type: 'OPEN', side: 'LONG', lots: 2 }, 10, 0, neg);
  b = act(b, { type: 'ADD' }, 13, 1, neg);
  assert.equal(b.pos.lots, 3);
  assert.equal(b.pos.entry, 11);
  b = act(b, { type: 'CUT' }, 12, 2, neg);
  assert.equal(b.pos.lots, 2);
  assert.equal(Math.round(b.realized), 1000);
  b = act(b, { type: 'CLOSE' }, 12, 3, neg);
  assert.equal(b.pos, null);
  assert.equal(Math.round(b.realized), 3000);
});
ok('max lots respected', () => {
  let b = act(emptyBook(), { type: 'OPEN', side: 'LONG', lots: 10 }, 10, 0, neg);
  b = act(b, { type: 'ADD' }, 10, 1, neg);
  assert.equal(b.pos.lots, 10);
  b = act(b, { type: 'ADD' }, 10, 1, { ...neg, maxLots: 12 });
  assert.equal(b.pos.lots, 11);
});
ok('decision values and grade grid', () => {
  const d = [{ type: 'OPEN', side: 'SHORT', lots: 2 }, , , { type: 'CLOSE' }];
  assert.equal(decisionValues(neg, d).length, 2);
  assert.equal([...gradeGrid(simulate(neg, d))].length, neg.C);
});

console.log(`session tests: ${n} passed ✓`);
