// Physical-trading tests: `npm test`. Pure engine functions only.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as C from '../src/physical/cargo.js';

const json = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url)));
const econ = json('economics.json');
const cargoCards = json('cargo.json').cards;
let n = 0;
const ok = (name, fn) => { fn(); n++; if (process.env.VERBOSE) console.log('✓', name); };
const byId = (id) => cargoCards.find((c) => c.id === id);

// ---------- economics config ----------
ok('every economics value has a source and a realistic range', () => {
  for (const [group, vals] of Object.entries(econ)) {
    if (group.startsWith('_')) continue;
    for (const [key, v] of Object.entries(vals)) {
      assert.ok(v._source && v._source.length > 20, `${group}.${key} needs a _source`);
      if (v.range) assert.ok(Array.isArray(v.value) || (v.value >= v.range[0] && v.value <= v.range[1]), `${group}.${key} outside its range`);
    }
  }
  assert.ok(econ.tank.rent_cushing_usd_bbl_month.value >= 0.4 && econ.tank.rent_cushing_usd_bbl_month.value <= 0.6);
});

// ---------- cargo ----------
for (const card of cargoCards) {
  const c = C.buildCargo(card, econ);
  ok(`${card.id}: deterministic build, 10-14 day-steps`, () => {
    assert.deepEqual(C.buildCargo(card, econ).ports[0].base, c.ports[0].base);
    assert.ok(c.D >= 10 && c.D <= 14);
  });
  ok(`${card.id}: P&L split sums to total for every simple plan`, () => {
    for (const p of c.ports) for (let s = 0; s < c.D; s++) {
      const acts = [{ type: 'PORT', port: p.id }, ...Array(s).fill({ type: 'SAIL' }), { type: 'SELL' }];
      const st = C.runCargo(c, acts);
      const sp = st.sold.split;
      assert.equal(sp.flat + sp.basis + sp.costs + sp.events, st.sold.pnl);
    }
  });
  ok(`${card.id}: costs are tens of thousands a day, value moves in the hundreds of thousands+`, () => {
    assert.ok(c.charter >= 10000 && c.charter <= 150000);
    const st = C.runCargo(c, [{ type: 'PORT', port: c.ports[0].id }, ...Array(c.D).fill({ type: 'SAIL' })]);
    const costs = -st.sold.split.costs;
    assert.ok(costs > 50000, `costs ${costs}`);
    const swing = Math.max(...c.flat) - Math.min(...c.flat);
    assert.ok(swing * c.bbl > 300000, 'cargo value should move by hundreds of thousands');
  });
  ok(`${card.id}: best achievable beats every simple plan`, () => {
    const best = C.bestCargo(c);
    for (const p of c.ports) {
      const st = C.runCargo(c, [{ type: 'PORT', port: p.id }, ...Array(p.voyage).fill({ type: 'SAIL' }), { type: 'SELL' }]);
      assert.ok(best.pnl >= st.sold.pnl);
    }
    assert.equal(C.runCargo(c, best.actions).sold.pnl, best.pnl);
  });
}

const fs = C.buildCargo(byId('cg-floating-storage-2020'), econ);
ok('floating storage pays in April 2020: Rotterdam via the rebound beats dumping in Houston', () => {
  const dump = C.runCargo(fs, [{ type: 'PORT', port: 'hou' }, { type: 'SAIL' }, { type: 'SELL' }]);
  const float = C.runCargo(fs, [{ type: 'PORT', port: 'rtm' }, ...Array(13).fill({ type: 'SAIL' }), { type: 'SELL' }]);
  assert.ok(float.sold.pnl > dump.sold.pnl + 1_000_000);
});
ok('port congestion queues the ship: no berth sale until it clears, demurrage accrues', () => {
  let st = C.step(fs, C.newCargoState(), { type: 'PORT', port: 'hou' });
  st = C.step(fs, st, { type: 'SAIL' }); // arrive day 1 into the queue
  assert.equal(st.at, 'hou'); assert.ok(st.queue > 0);
  assert.notEqual(C.bestSale(fs, st).port === 'hou' && !C.bestSale(fs, st).afloat, true);
  st = C.step(fs, C.step(fs, st, { type: 'WAIT' }), { type: 'WAIT' });
  assert.equal(st.queue, 0); assert.ok(st.cost.demurrage > 0);
});
ok('weather delay pushes the ETA; quality dispute penalizes sales at that port', () => {
  let st = C.step(fs, C.newCargoState(), { type: 'PORT', port: 'rtm' });
  const eta = st.eta;
  for (let i = 0; i < 7; i++) st = C.step(fs, st, { type: 'SAIL' });
  assert.equal(st.eta, eta + 1);
  const ds = C.buildCargo(byId('cg-diesel-squeeze-2022'), econ);
  assert.ok(C.penaltyAt(ds, 'ara', 10) > 0); assert.equal(C.penaltyAt(ds, 'ara', 9), 0); assert.equal(C.penaltyAt(ds, 'nyh', 12), 0);
});
ok('pipeline outage collapses basis at the port and widens it elsewhere', () => {
  const fz = C.buildCargo(byId('cg-texas-freeze-2021'), econ);
  assert.ok(C.shiftAt(fz, 'hou', 5) < C.shiftAt(fz, 'hou', 3));
  assert.ok(C.shiftAt(fz, 'sj', 5) > C.shiftAt(fz, 'sj', 4));
  assert.equal(C.shiftAt(fz, 'rtm', 5), 0); // widen_ports limits who benefits
});

console.log(`physical tests: ${n} passed ✓`);
