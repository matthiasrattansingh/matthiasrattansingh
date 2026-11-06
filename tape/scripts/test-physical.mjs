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

// ---------- tank ----------
const T = await import('../src/physical/tank.js');
const tankCards = json('tank.json').cards;
const tk = (id) => T.buildTank(tankCards.find((c) => c.id === id), econ);
const sc = tk('tk-super-contango-2020');
ok('tank: 8-12 weekly steps with a real 4-month curve and EIA prints', () => {
  for (const c of tankCards) {
    const t = T.buildTank(c, econ);
    assert.ok(t.W >= 8 && t.W <= 12);
    assert.ok(t.weeks.every((w) => w.curve.length === 4 && w.months.length === 4 && Number.isFinite(w.eia.cushing_mmbbl)));
  }
});
ok('holding a carry to delivery realizes exactly the locked spread minus rent and financing', () => {
  const st = T.runTank(sc, [{ type: 'CARRY', k: 1, bbl: 500000 }]);
  const sp = T.tankSplit(sc, st);
  assert.ok(Math.abs(sp.unwind) < 1, `unwind ${sp.unwind}`);
  assert.ok(Math.abs(sp.total - (sp.locked + sp.rent + sp.financing)) < 1);
  assert.match(st.log.map((l) => l.text).join(' '), /Delivered into futures at expiry/);
});
ok('the spread has to pay more than the tank: week-1 2020 carry loses, late-April carry pays', () => {
  const early = T.tankSplit(sc, T.runTank(sc, [{ type: 'CARRY', k: 1, bbl: 500000 }]));
  assert.ok(T.carryOffer(sc, 0, 1).perMonth < T.carryCost(sc, 0)); assert.ok(early.total < 0);
  const late = T.tankSplit(sc, T.runTank(sc, [...Array(7).fill({ type: 'WAIT' }), { type: 'CARRY', k: 3, bbl: 500000 }]));
  assert.ok(T.carryOffer(sc, 7, 1).perMonth > T.carryCost(sc, 7)); assert.ok(late.total > 2_000_000);
  assert.ok(T.bestTank(sc).pnl >= late.total);
});
ok('backwardation: a cash-and-carry locks in a loss', () => {
  const bw = tk('tk-backwardation-2021');
  const sp = T.tankSplit(bw, T.runTank(bw, [{ type: 'CARRY', k: 1, bbl: 500000 }]));
  assert.ok(sp.locked < 0); assert.ok(sp.total < 0);
});
ok('roll moves the hedge one month out and books the old leg', () => {
  let st = T.stepTank(sc, T.newTankState(), { type: 'CARRY', k: 1, bbl: 500000 });
  const m = st.hedge.month;
  st = T.stepTank(sc, st, { type: 'ROLL' });
  assert.notEqual(st.hedge.month, m); assert.equal(st.rolls, 1);
});
ok('rent is in the realistic $0.40-0.60/bbl/month band by default', () => {
  const t = T.buildTank({ ...tankCards[1], rent_usd_bbl_month: undefined }, econ);
  assert.ok(t.rent >= 0.4 && t.rent <= 0.6);
});

// ---------- two-book ----------
const TB = await import('../src/physical/twobook.js');
const E = await import('../src/trade/engine.js');
const agents = json('agents.json').agents;
const agent = (id) => agents.find((a) => a.id === id);
const callit = json('callit.json').cards;
const legged = callit.filter((c) => c.session.physical);
const wti = callit.find((c) => c.id === 'ci-wti-negative-2020');
const sWti = { ...E.buildSession(wti), maxLots: TB.HEDGE_MAX_LOTS, addStep: TB.HEDGE_ADD };
const phys = wti.session.physical;
const gradeFor = (decisions) => {
  const sim = E.simulate(sWti, decisions);
  const naked = TB.physCurve(phys, sWti);
  let book = E.emptyBook();
  const ratios = [];
  for (let i = 0; i < sWti.C; i++) { book = E.act(book, decisions[i] ?? { type: 'HOLD' }, E.decisionPrice(sWti, i), i, sWti); ratios.push(TB.hedgeRatio(phys, book.pos)); }
  return TB.hedgeGrade({ ratios, combined: sim.curve.map((v, i) => v + naked[i]), naked, news: sWti.news });
};
ok('at least 8 paper sessions carry a physical leg', () => assert.ok(legged.length >= 8));
ok('hedge ratio: short 250 lots vs long 250k bbl = 100%; same-side = doubled', () => {
  assert.equal(TB.hedgeRatio(phys, { side: 'SHORT', lots: 250 }), 1);
  assert.equal(TB.hedgeRatio(phys, { side: 'LONG', lots: 250 }), -1);
  assert.equal(TB.hedgeRatio(phys, null), 0);
});
ok('hedge grade: full hedge = S, doubled the bet = D, naked into the news = D', () => {
  assert.equal(gradeFor([{ type: 'OPEN', side: 'SHORT', lots: 250 }]).grade, 'S');
  assert.equal(gradeFor([{ type: 'OPEN', side: 'LONG', lots: 100 }]).grade, 'D');
  assert.equal(gradeFor([]).grade, 'D'); // naked through 'May WTI goes NEGATIVE'
});
ok('bots carry the same physical book: Mo 0%, Quinn ~80%, Dan the wrong way', () => {
  assert.equal(TB.botHedgeDecisions(agent('mo'), phys, sWti).filter(Boolean).length, 0);
  const q = TB.botHedgeDecisions(agent('quinn'), phys, sWti)[0];
  assert.equal(q.side, 'SHORT'); assert.equal(q.lots, 200);
  let wrong = 0;
  for (let i = 0; i < 20; i++) {
    const d = TB.botHedgeDecisions(agent('dan'), phys, sWti, `s${i}`)[0];
    if (d?.side === 'LONG') wrong++; // same side as the long physical = doubling the bet
  }
  assert.ok(wrong >= 10, `Dan should usually hedge the wrong way (${wrong}/20)`);
  const mo = TB.botTwoBook(agent('mo'), phys, sWti, 'x');
  assert.equal(Math.round(mo.final), Math.round(TB.physCurve(phys, sWti).at(-1)));
  const qb = TB.botTwoBook(agent('quinn'), phys, sWti, 'x');
  assert.ok(Math.abs(qb.final) < Math.abs(mo.final) * 0.3, "Quinn's hedge should absorb most of the move");
});
ok('basis events move only the physical leg', () => {
  const col = callit.find((c) => c.id === 'ci-colonial-hack-2021');
  const s = E.buildSession(col);
  const p = col.session.physical;
  const before = TB.physPnl(p, s, s.p0, 2);
  const after = TB.physPnl(p, s, s.p0, 3);
  assert.equal(Math.round(after - before), -625000); // -$2.50/bbl on 250k bbl, long the Gulf barrels
});

// ---------- agents (add-on A) ----------
const AG = await import('../src/physical/agents.js');
const MEM = await import('../src/physical/memory.js');
const { emptyProgress } = await import('../src/lib/progress.js');
const diesel = byId('cg-diesel-squeeze-2022');

ok("seeded cargo: Quinn's netback choice beats Mo's chased port after costs", () => {
  // Texas freeze, seed 'a': Mo chases Houston's recent gain into the refinery freeze; Quinn takes the best netback.
  const freeze = byId('cg-texas-freeze-2021');
  const q = AG.runAgentCargo(agent('quinn'), freeze, econ, { seed: 'a' });
  const m = AG.runAgentCargo(agent('mo'), freeze, econ, { seed: 'a' });
  assert.equal(m.st.sold.port, 'hou'); assert.equal(q.st.sold.port, 'rtm');
  assert.ok(q.pnl > m.pnl + 1_000_000, `quinn ${q.pnl} vs mo ${m.pnl}`);
  assert.ok(q.split.costs < 0 && m.split.costs < 0); // both after costs
  assert.equal(AG.runAgentCargo(agent('quinn'), freeze, econ, { seed: 'a' }).pnl, q.pnl); // deterministic
});
ok("Dan pays the desk's highest demurrage across 10 seeds", () => {
  const total = Object.fromEntries(agents.map((a) => [a.id, 0]));
  for (let i = 0; i < 10; i++) for (const card of cargoCards) for (const a of agents) total[a.id] += AG.runAgentCargo(a, card, econ, { seed: `s${i}` }).demurrage;
  const top = Object.entries(total).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(top, 'dan', JSON.stringify(total));
});
ok('no agent reads the future: the view throws on look-ahead', () => {
  const c = C.buildCargo(diesel, econ);
  assert.throws(() => AG.cargoView(c, 3).delivered('nyh', 4), /look-ahead/);
  for (const card of cargoCards) for (const a of agents) AG.runAgentCargo(a, card, econ); // would throw if any rule peeked
});
ok('no agent reads the future: poisoning every later day leaves earlier decisions unchanged', () => {
  for (const card of cargoCards) {
    for (const a of agents) {
      const real = AG.runAgentCargo(a, card, econ).actions;
      for (let d = 0; d < card.days.length - 1; d++) {
        const poisoned = { ...card, days: card.days.map((x, i) => (i > d ? { ...x, flat: x.flat * 3 + 50 } : x)) };
        const got = AG.runAgentCargo(a, poisoned, econ).actions.filter((x) => x.day <= d);
        assert.deepEqual(got, real.filter((x) => x.day <= d), `${a.id} on ${card.id} changed its day-${d} decisions after seeing poisoned future data`);
      }
    }
  }
});
ok('tank agents: Mo never stores, Quinn carries when the math clears, Dan pays rent', () => {
  const t = T.buildTank(tankCards.find((c) => c.id === 'tk-super-contango-2020'), econ);
  assert.equal(AG.runAgentTank(agent('mo'), t).st.rent, 0);
  assert.ok(AG.runAgentTank(agent('quinn'), t).pnl > 0);
  assert.ok(AG.runAgentTank(agent('dan'), t).rent > 0);
  assert.equal(AG.runAgentTank(agent('quinn'), T.buildTank(tankCards.find((c) => c.id === 'tk-backwardation-2021'), econ)).st.rent, 0);
});
ok('memory: after 5 cargoes Quinn scouts you and rivals fade your favorite port', () => {
  let p = emptyProgress();
  for (let i = 0; i < 5; i++) p = MEM.rememberCargo(p, { portName: 'Houston', days: 4 + i, demurrage: 45000 });
  assert.match(p.chat.msgs.at(-1).text, /Houston 5 of 5 times, sell in 6\.0 days/);
  const fz = C.buildCargo(byId('cg-texas-freeze-2021'), econ);
  const faded = MEM.rivalAdjust(p)(fz);
  assert.equal(faded.faded, 'hou');
  assert.ok(Math.abs(C.shiftAt(faded, 'hou', 0) - C.shiftAt(fz, 'hou', 0) + MEM.FADE_USD_BBL) < 1e-9);
  assert.equal(MEM.rivalAdjust(emptyProgress()), null);
});

// ---------- negotiation (add-on B) ----------
const N = await import('../src/physical/negotiation.js');
const negoBase = { side: 'sell', fair: 1.0, roster: agents, econ, seed: 'nego-test', desperation: 0.4 };
ok('negotiation: 1-3 counterparties with hidden reservation, patience, desperation, bluff', () => {
  const n0 = N.openNegotiation(negoBase);
  assert.ok(n0.parties.length >= 1 && n0.parties.length <= 3);
  for (const p of n0.parties) {
    assert.ok(p.bid < p.reservation, 'buyers open below their reservation (bluff)');
    assert.ok(p.patience >= 2 && p.patience <= 6);
    assert.ok(p.desperation >= 0 && p.desperation <= 1);
  }
  assert.deepEqual(N.openNegotiation(negoBase), n0); // seeded
});
ok('negotiated sale: AVG5 averages the 5 days around discharge; split still sums', () => {
  const c = C.buildCargo(diesel, econ);
  let st = C.step(c, C.newCargoState(), { type: 'PORT', port: 'nyh' });
  for (let i = 0; i < 6; i++) st = C.step(c, st, { type: 'SAIL' });
  const idx = C.indexFor(c, st.day, 'AVG5');
  assert.deepEqual(idx.days, [st.day - 2, st.day - 1, st.day, st.day + 1, st.day + 2]);
  const sold = C.sellNegotiated(c, st, { port: 'nyh', diff: 10.5, term: 'AVG5', afloat: false }).sold;
  const sp = sold.split;
  assert.equal(sp.flat + sp.basis + sp.costs + sp.events, sold.pnl);
  assert.ok(Math.abs(sold.price - (idx.price + 10.5)) < 1e-9);
});

// ---------- negotiation steps 2-3: pressure, relationships, buy side, set-pieces ----------
const REL = await import('../src/physical/relationships.js');
const shadeCfg = econ.negotiation.distress_shading_usd_bbl_day.value;
const cargoCtx = (c, st, port, extra = {}) => ({
  side: 'sell', fair: C.fairDiff(c, port, st.day), desperation: C.desperationAt(c, port, st.day),
  roster: agents, econ, seed: `test|${st.day}|${port}`, ...extra,
});

ok('accepting bid 1 yields exactly the baseline edge $0', () => {
  const c = C.buildCargo(diesel, econ);
  let st = C.step(c, C.newCargoState(), { type: 'PORT', port: 'nyh' });
  for (let i = 0; i < 6; i++) st = C.step(c, st, { type: 'SAIL' });
  const n0 = N.openNegotiation(cargoCtx(c, st, 'nyh'));
  for (const p of n0.parties) {
    const out = N.respond(n0, { type: 'ACCEPT', party: p.id }, 'seed');
    assert.equal(out.outcome, 'deal');
    const d = out.n.deal;
    assert.equal(d.diff, p.first);
    const idx = C.indexFor(c, st.day, d.term).price;
    const edge = N.edgeOf({ side: 'sell', bbl: c.bbl, indexAtOpen: idx, indexAtDeal: idx, diff: d.diff, first: d.first });
    assert.equal(edge === 0 ? 0 : edge, 0);
    // Booked sale at the accepted bid equals the first-bid baseline.
    const a = C.sellNegotiated(c, st, { port: 'nyh', diff: d.diff, term: d.term, afloat: false }).sold.pnl;
    const b = C.sellNegotiated(c, st, { port: 'nyh', diff: p.first, term: p.term, afloat: false }).sold.pnl;
    assert.equal(a, b);
  }
});

ok("a scripted counter sequence against Quinn's buyer converges within his patience", () => {
  for (let s = 0; s < 12; s++) {
    const seed = `quinn-${s}`;
    let nn = N.openNegotiation({ ...negoBase, roster: [agent('quinn')], count: 1, seed });
    const patience0 = nn.parties[0].patience;
    let rounds = 0;
    let ask = nn.parties[0].bid + 0.5; // open high, then shade toward each move
    while (!nn.deal && rounds < 10) {
      const q = nn.parties[0];
      assert.equal(q.status, 'live', `seed ${s}: Quinn pulled after ${rounds} rounds`);
      if (q.final) { nn = N.respond(nn, { type: 'ACCEPT', party: q.id }, seed).n; break; }
      nn = N.respond(nn, { type: 'COUNTER', party: q.id, ask: Math.round(ask * 20) / 20 }, seed).n;
      rounds++;
      ask = nn.parties[0].bid + 0.15;
    }
    assert.ok(nn.deal, `seed ${s}: no deal`);
    assert.ok(rounds <= patience0, `seed ${s}: ${rounds} rounds vs patience ${patience0}`);
    assert.ok(nn.deal.diff >= nn.parties[0].first, 'countering never ends below his first bid');
  }
});

ok('stalling 6 rounds against an impatient buyer gets the bid pulled', () => {
  let nn = N.openNegotiation({ ...negoBase, desperation: 0.95, roster: [agent('mo')], count: 1, seed: 'impatient' });
  assert.ok(nn.parties[0].desperation > 0.6 && nn.parties[0].patience <= 5, 'desperate buyers are impatient');
  let pulledAt = null;
  for (let i = 1; i <= 6; i++) {
    const out = N.respond(nn, { type: 'STALL' }, 'impatient');
    nn = out.n;
    if (out.outcome === 'pulled' && pulledAt == null) pulledAt = i;
  }
  assert.equal(nn.parties[0].status, 'pulled');
  assert.ok(pulledAt != null && pulledAt <= 6);
  assert.equal(N.liveParties(nn).length, 0);
  assert.equal(N.respond(nn, { type: 'ACCEPT', party: 'mo' }).outcome, 'none', 'a pulled bid cannot be accepted');
});

ok('distress shading changes opening bids by the configured amount on the configured day', () => {
  const c = C.buildCargo(byId('cg-texas-freeze-2021'), econ);
  const lay = c.ports.find((p) => p.id === 'sj').laytime;
  let st = C.step(c, C.newCargoState(), { type: 'PORT', port: 'sj' });
  while (!st.at) st = C.step(c, st, { type: 'SAIL' });
  assert.equal(C.distressDaysAt(c, st), 0, 'arrival: meter not red yet');
  const seen = [];
  while (st.day < c.D - 2) {
    st = C.step(c, st, { type: 'WAIT' });
    const dd = C.distressDaysAt(c, st);
    // Distress days are exactly the demurrage days charged (the meter in the red).
    assert.equal(dd, Math.round(st.cost.demurrage / c.demurrage));
    assert.equal(dd > 0, st.waited > lay);
    const base = N.openNegotiation(cargoCtx(c, st, 'sj', { distressDays: 0 }));
    const shaded = N.openNegotiation(cargoCtx(c, st, 'sj', { distressDays: dd }));
    base.parties.forEach((p, i) => {
      assert.ok(Math.abs(p.first - shaded.parties[i].first - shadeCfg * dd) < 1e-9, `day ${st.day}: ${p.first} vs ${shaded.parties[i].first}`);
      assert.equal(p.reservation, shaded.parties[i].reservation, 'shading moves the opening, not their limit');
    });
    seen.push(dd);
  }
  assert.equal(seen[0], 0, 'first day at the berth is inside laytime');
  assert.ok(seen.some((d) => d >= 2), 'shading grows day by day');
});

ok('relationships persist per agent and move opening bids by $0.03-0.08', () => {
  let p = emptyProgress();
  const parties = [{ id: 'carla', rounds: 2, stalled: 3, status: 'walked' }, { id: 'quinn', rounds: 1, stalled: 3, status: 'live' }];
  p = REL.recordNegotiation(p, { parties, deal: { party: 'quinn' }, edge: 12345 });
  assert.deepEqual(p.phys.relationships.carla, { deals_closed: 0, rounds_stalled_on_them: 3, walk_aways_after_3plus_rounds: 1 });
  assert.equal(p.phys.relationships.quinn.deals_closed, 1);
  assert.deepEqual(p.phys.negotiation, { edge: 12345, pulled: 0, deals: 1 });
  const [lo, hi] = econ.negotiation.relationship_adjust_usd_bbl.value;
  const cold = N.relationAdjust(p.phys.relationships.carla, econ);
  assert.ok(cold <= -lo && cold >= -hi);
  const opts = { ...negoBase, roster: [agent('carla')], count: 1, seed: 'rel' };
  const a = N.openNegotiation(opts).parties[0];
  const b = N.openNegotiation({ ...opts, relationships: p.phys.relationships }).parties[0];
  assert.ok(Math.abs(b.first - a.first - cold) < 0.051, 'opening moves by the relationship adjustment');
  assert.match(N.tell(b, 'sell', p.phys.relationships.carla, 'Matthias'), /Matthias/);
});

ok('buy side: sellers ask above their floor; Cushing level drives their clock', () => {
  const m20 = T.spotMarket(sc, 8, econ); // 29 Apr 2020: Cushing ~83% full
  const m21 = T.spotMarket(tk('tk-backwardation-2021'), 4, econ);
  assert.ok(m20.theirClock && m20.desperation > 0.6 && m20.fair < 0);
  assert.equal(m21.theirClock, null);
  assert.ok(m21.fair > 0, 'tight Cushing: sellers hold the cards');
  let nn = N.openNegotiation({ side: 'buy', fair: m20.fair, desperation: m20.desperation, theirClock: m20.theirClock, roster: agents, econ, seed: 'buy', count: 3 });
  for (const p of nn.parties) assert.ok(p.bid > p.reservation, 'sellers open above their floor');
  const desperate = nn.parties.filter((p) => p.desperation > 0.6).map((p) => p.id);
  assert.ok(desperate.length > 0);
  const before = Object.fromEntries(nn.parties.map((p) => [p.id, p.bid]));
  nn = N.respond(N.respond(nn, { type: 'STALL' }).n, { type: 'STALL' }).n; // one full day
  assert.equal(nn.theirClock.days, m20.theirClock.days - 1);
  for (const p of nn.parties.filter((x) => desperate.includes(x.id) && x.status === 'live')) {
    assert.ok(p.bid <= before[p.id] - shadeCfg + 1e-9, 'a seller with no home shades down every day');
  }
});

ok('negotiated CARRY: the agreed differential lands in the locked carry and the P&L', () => {
  const plain = T.runTank(sc, [{ type: 'WAIT' }, { type: 'CARRY', k: 2, bbl: 500000 }]);
  const haggled = T.runTank(sc, [{ type: 'WAIT' }, { type: 'CARRY', k: 2, bbl: 500000, diff: -0.25 }]);
  assert.ok(Math.abs(haggled.locked - plain.locked - 0.25 * 500000) < 1e-6);
  assert.ok(Math.abs(T.tankPnl(sc, haggled) - T.tankPnl(sc, plain) - 0.25 * 500000) < 1e-6);
  const sp = T.tankSplit(sc, haggled);
  assert.ok(Math.abs(sp.locked + sp.unwind + sp.rent + sp.financing - sp.total) < 1e-6);
});

ok('set-pieces: a desperate NYH diesel buyer and a distressed seller at Houston', () => {
  const dz = C.buildCargo(diesel, econ);
  assert.equal(C.setPieceAt(dz, 'nyh', 4), null);
  const spike = C.setPieceAt(dz, 'nyh', 6);
  assert.equal(spike.count, 3);
  assert.ok(C.desperationAt(dz, 'nyh', 6) > 0.6);
  assert.equal(C.setPieceAt(dz, 'nyh', 9), null, 'the squeeze ends when May ULSD expires');
  const fsc = C.buildCargo(byId('cg-floating-storage-2020'), econ);
  const dump = C.setPieceAt(fsc, 'hou', 3);
  assert.equal(dump.type, 'distressed_seller');
  assert.equal(dump.count, 1);
  assert.ok(C.desperationAt(fsc, 'hou', 3) < C.desperationAt(fsc, 'hou', 1));
  const nn = N.openNegotiation({ ...cargoCtx(dz, { day: 6 }, 'nyh'), count: spike.count, line: spike.line });
  assert.equal(nn.parties.length, 3);
  assert.ok(N.leverage(nn), '3 live bids is leverage');
  assert.equal(N.tell(nn.parties[0], 'sell'), spike.line);
});

console.log(`physical tests: ${n} passed ✓`);
