// DESK economics, scenarios, scheduler and feed tests: `node scripts/test-desk.mjs` (part of `npm test`).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import * as E from '../src/desk/econ.js';
import * as S from '../src/desk/scenario.js';
import * as F from '../src/desk/feed.js';
import * as SCH from '../src/physical/scheduler.js';
import * as C from '../src/physical/cargo.js';
import * as T from '../src/physical/tank.js';
import { emptyProgress } from '../src/lib/progress.js';

const json = (f) => JSON.parse(readFileSync(new URL(`../src/data/${f}`, import.meta.url)));
const econ = json('economics.json');
const DESK = json('desk.json').cards;
const agents = json('agents.json').agents;
const sc = (id) => S.buildDesk(DESK.find((c) => c.id === id));
let n = 0;
const ok = (name, fn) => { fn(); n++; if (process.env.VERBOSE) console.log('✓', name); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// ---------- the economics math ----------
ok('arb break-even: spread must cover transport + fees (+ in-transit loss)', () => {
  const a = E.arbBreakeven({ buy: 85.0, sell: 88.0, transport: 1.33, fees: 0.30 });
  near(a.spread, 3.0, 1e-9, 'spread');
  near(a.cost, 1.63, 1e-9, 'cost');
  near(a.margin, 1.37, 1e-9, 'margin');
  near(a.breakeven, 1.63, 1e-9, 'break-even');
  assert.equal(a.open, true);
  const shut = E.arbBreakeven({ buy: 85.0, sell: 86.0, transport: 1.33, fees: 0.30, lossPct: 0.002 });
  near(shut.cost, 1.63 + 0.17, 1e-9, 'loss priced at purchase');
  assert.equal(shut.open, false);
  near(shut.margin, -0.8, 1e-9, 'negative margin');
});

ok('freight per barrel: day rate × voyage days ÷ cargo', () => {
  near(E.freightPerBbl(50000, 8, 300000), 1.3333, 1e-4, 'Jones Act MR');
  near(E.freightPerBbl(92000, 30, 750000), 3.68, 1e-9, 'LR2');
});

ok('carry coverage: the spread has to pay rent + financing + in/out', () => {
  const c = E.carryCoverage({ spot: 20, forward: 24, months: 3, rent: 0.6, financePct: 0.025, inout: 0.1 });
  near(c.carry, 4, 1e-9, 'carry');
  near(c.rent, 1.8, 1e-9, 'rent');
  near(c.financing, 0.125, 1e-9, 'financing');
  near(c.cost, 2.025, 1e-9, 'cost');
  near(c.net, 1.975, 1e-9, 'net');
  assert.equal(c.covers, true);
  const thin = E.carryCoverage({ spot: 40, forward: 41, months: 2, rent: 0.45, financePct: 0.06, inout: 0.1 });
  near(thin.cost, 0.9 + 0.4 + 0.1, 1e-9, 'thin cost');
  assert.equal(thin.covers, false);
  near(thin.breakeven, 1.4, 1e-9, 'break-even carry');
});

ok('differential P&L: long gains when the diff rises, short when it falls, net of costs', () => {
  assert.equal(E.diffPnl({ side: 'long', entry: -33.5, exit: -29.25, bbl: 100000, costs: 35000 }), 4.25 * 100000 - 35000);
  assert.equal(E.diffPnl({ side: 'short', entry: -4, exit: -8.25, bbl: 300000 }), 4.25 * 300000);
  assert.equal(E.diffPnl({ side: 'short', entry: -8.25, exit: -7, bbl: 300000, costs: 30000 }), -1.25 * 300000 - 30000);
});

ok('idea P&L = legs − costs, by hand: the Colonial Jones Act arb', () => {
  const s = sc('dsk-colonial-2021');
  const i = s.steps.findIndex((x) => x.kind === 'idea' && x.type === 'location_arb');
  const idea = s.steps[i];
  const e = idea.day;
  const x = e + idea.horizon;
  const v = (k, d) => s.series[k].values[d];
  const freight = v('jones_mr', e) * 8;
  const fin = (v('gas_usgc', e) * 300000 * 0.02 * idea.horizon) / 365;
  const want = (v('gas_nyh', x) - v('gas_usgc', e)) * 300000 - freight - 0.30 * 300000 - fin;
  near(E.ideaPnl(s, idea, e, x), want, 1e-6, 'hand-computed P&L');
  near(E.settle(s, idea, e).pnl, want, 1e-6, 'settles at horizon');
  // The card's economics agree with the same math.
  const ec = E.ideaEconomics(s, idea, e);
  near(ec.cost, freight + 0.30 * 300000 + fin, 1e-6, 'card cost');
  near(ec.edge, (v('gas_nyh', e) - v('gas_usgc', e)) * 300000 - ec.cost, 1e-6, 'edge if nothing moves');
});

ok('break-even is exact for every authored idea with one exit leg', () => {
  for (const card of DESK) {
    const s = S.buildDesk(card);
    s.steps.forEach((step) => {
      if (step.kind !== 'idea') return;
      const ec = E.ideaEconomics(s, step, step.day);
      if (!ec.breakeven) return;
      // Re-run the horizon P&L with the exit leg priced exactly at break-even: zero.
      const forced = { ...s, series: { ...s.series, __be: { values: s.series[ec.breakeven.series].values.map(() => ec.breakeven.value) } } };
      const idea = { ...step, legs: step.legs.map((l) => (l.at === 'exit' ? { ...l, series: '__be' } : l)) };
      near(E.ideaPnl(forced, idea, step.day, step.day + step.horizon), 0, 1e-3, `${card.id} ${step.title}`);
    });
  }
});

ok('storage: locked at entry (Uri gas pull) does not move with the market', () => {
  const s = sc('dsk-uri-freeze-2021');
  const idea = s.steps.find((x) => x.kind === 'idea' && x.type === 'storage');
  const e = idea.day;
  const want = (s.series.hh.values[e] - s.series.ng_fut.values[e]) * 1e6 - 0.02 * 1e6;
  near(E.ideaPnl(s, idea, e, e), want, 1e-6, 'day 0');
  near(E.ideaPnl(s, idea, e, e + idea.horizon), want, 1e-6, 'horizon');
  near(want, (6.5 - 2.868) * 1e6 - 20000, 1, 'Feb 11 2021: HH $6.50 vs futures $2.868');
});

ok('freight play: (exit rate − entry rate) × charter days − commission', () => {
  const s = sc('dsk-red-sea-2024');
  const idea = s.steps.find((x) => x.kind === 'idea' && x.type === 'freight');
  const r = s.series.lr2.values;
  const want = (r[idea.day + idea.horizon] - r[idea.day]) * 60 - 0.0125 * 60 * 43000;
  near(E.settle(s, idea, idea.day).pnl, want, 1e-6, 'LR2 charter');
  assert.ok(want > 2_000_000, 'capacity was the trade');
});

// ---------- the scenarios ----------
ok('5 scenarios, 8-12 cards each, mixing news, ideas, decisions and rival pitches', () => {
  assert.equal(DESK.length, 5);
  for (const c of DESK) {
    assert.ok(c.steps.length >= 8 && c.steps.length <= 12, c.id);
    for (const k of ['news', 'idea', 'decision', 'pitch']) assert.ok(c.steps.some((s) => s.kind === k), `${c.id} has ${k}`);
  }
});

ok('real data anchors: EIA spot and cited modeled points land on the right days', () => {
  const day = (s, d) => s.days.indexOf(d);
  const uri = sc('dsk-uri-freeze-2021');
  assert.equal(uri.series.hh.values[day(uri, '2021-02-17')], 23.86);
  assert.equal(uri.series.hh.kind, 'real');
  const col = sc('dsk-colonial-2021');
  near(col.series.gas_nyh.values[day(col, '2021-05-12')], 2.172 * 42, 1e-6, 'NYH gasoline May 12 2021');
  assert.equal(col.series.jones_mr.values[day(col, '2021-05-12')], 50000);
  const ks = sc('dsk-keystone-2022');
  assert.equal(ks.series.wcs.values[day(ks, '2022-12-08')], -33.5);
  assert.equal(ks.series.wcs.kind, 'modeled');
  const spr = sc('dsk-spr-release-2022');
  assert.equal(spr.series.mars.values[day(spr, '2022-06-13')], -8.25);
  const rs = sc('dsk-red-sea-2024');
  assert.equal(rs.series.lr2.values[day(rs, '2024-01-25')], 92000);
});

ok('rival pitches use no future data (poisoning later days changes nothing)', () => {
  for (const card of DESK) {
    const s = S.buildDesk(card);
    for (const step of s.steps.filter((x) => x.kind === 'pitch')) {
      const clean = S.botPitch(s, step.by, step.day);
      const poisoned = { ...s, series: Object.fromEntries(Object.entries(s.series).map(([k, v]) => [k, { ...v, values: v.values.map((x, d) => (d > step.day ? x * -50 + 999 : x)) }])) };
      assert.deepEqual(S.botPitch(poisoned, step.by, step.day), clean);
    }
  }
});

ok('rival pitches are a real judgment call: some win, some lose', () => {
  const results = DESK.flatMap((card) => {
    const s = S.buildDesk(card);
    return s.steps.filter((x) => x.kind === 'pitch').map((x) => E.settle(s, S.botPitch(s, x.by, x.day), x.day).pnl);
  });
  assert.ok(results.some((x) => x > 0) && results.some((x) => x < 0));
});

ok('desk book: run, pass, decide; consequences land on their day; P&L = ideas + scheduler', () => {
  const s = sc('dsk-keystone-2022');
  let st = S.newDeskState();
  const di = s.steps.findIndex((x) => x.kind === 'decision');
  const ii = s.steps.findIndex((x) => x.kind === 'idea');
  st = S.advance(st, s.steps[di].day);
  st = S.decide(st, di, s.steps[di], 1); // rent tank: lands later
  assert.equal(st.sched.length, 0);
  assert.equal(st.pending.length, 1);
  const landDay = s.steps[di].options[1].later.day;
  assert.equal(S.advance(st, landDay - 1).sched.length, 0);
  assert.equal(S.advance(st, landDay).sched[0].usd, s.steps[di].options[1].later.usd);
  st = S.run(s, st, ii, S.ideaFor(s, s.steps[ii]), agents);
  const pi = s.steps.findIndex((x) => x.kind === 'pitch');
  st = S.pass(s, st, pi, S.ideaFor(s, s.steps[pi]));
  const r = S.finishDesk(s, st, agents);
  const ideaPnl = E.settle(s, s.steps[ii], s.steps[ii].day).pnl;
  near(r.split.ideas, ideaPnl, 1e-6, 'ideas');
  assert.equal(r.split.sched, s.steps[di].options[1].later.usd);
  near(r.pnl, r.split.ideas + r.split.sched, 1e-6, 'total');
  assert.equal(r.calls, 2);
  assert.ok(r.best >= r.pnl);
  // A passed loser is a right call; a run winner is a right call.
  for (const o of r.outcomes) assert.equal(o.right, o.ran ? o.pnl > 0 : o.pnl <= 0);
});

ok('counterparty: a rival on the other side books exactly the mirror of your trade', () => {
  for (const card of DESK) {
    const s = S.buildDesk(card);
    let st = S.newDeskState();
    s.steps.forEach((step, i) => { if (step.kind === 'idea') st = S.run(s, st, i, S.ideaFor(s, step), agents); });
    const r = S.finishDesk(s, st, agents);
    const own = Object.fromEntries(agents.map((a) => [a.id, 0]));
    s.steps.forEach((step) => { if (step.kind === 'pitch') own[step.by] += E.settle(s, S.botPitch(s, step.by, step.day), step.day).pnl; });
    for (const a of agents) {
      const mirror = r.outcomes.filter((o) => o.counterparty === a.id).reduce((x, o) => x - o.pnl, 0);
      near(r.bots[a.id].pnl, own[a.id] + mirror, 1e-6, `${card.id} ${a.id}`);
    }
  }
});

// ---------- scheduler decisions in cargo and tank sessions ----------
ok('cargo scheduler: cost now, consequence lands on its day, split still sums', () => {
  const card = json('cargo.json').cards.find((c) => c.id === 'cg-diesel-squeeze-2022');
  const c = C.buildCargo(card, econ);
  const dec = card.scheduler[0];
  let st = C.step(c, C.newCargoState(), { type: 'PORT', port: 'nyh' });
  while (st.day < dec.day) st = C.step(c, st, { type: 'SAIL' });
  st = SCH.decideSched(st, dec, 0, st.day); // blend: +$100k now, penalty later
  assert.equal(SCH.schedUsd(st), 100000);
  while (st.day < dec.options[0].later.day) st = C.step(c, st, { type: st.at ? 'WAIT' : 'SAIL' });
  assert.equal(SCH.schedUsd(st), 100000 + dec.options[0].later.usd);
  assert.ok(st.log.some((l) => l.type === 'sched' && l.text.includes('off-spec')));
  const sold = C.step(c, st, { type: 'SELL' }).sold;
  assert.equal(sold.split.sched, 100000 + dec.options[0].later.usd);
  assert.equal(sold.split.flat + sold.split.basis + sold.split.costs + sold.split.events + sold.split.sched, sold.pnl);
  // Selling before the consequence lands still books it (the invoice arrives at settlement).
  let early = SCH.decideSched(C.step(c, C.newCargoState(), { type: 'PORT', port: 'nyh' }), dec, 0, 0);
  early = C.step(c, early, { type: 'SELL' });
  assert.equal(early.sold.split.sched, 100000 + dec.options[0].later.usd);
});

ok('tank scheduler: lands by week and shows as its own debrief line', () => {
  const card = json('tank.json').cards.find((c) => c.id === 'tk-super-contango-2020');
  const t = T.buildTank(card, econ);
  const dec = card.scheduler[0];
  let st = T.stepTank(t, T.newTankState(), { type: 'WAIT' });
  st = SCH.decideSched(st, dec, 1, st.week); // pay spot later
  while (!st.done) st = T.stepTank(t, st, { type: 'WAIT' });
  const sp = T.tankSplit(t, st);
  assert.equal(sp.sched, dec.options[1].later.usd);
  near(sp.locked + sp.unwind + sp.rent + sp.financing + sp.sched, sp.total, 1e-6, 'split sums');
  assert.equal(SCH.dueDecision(card, st, 99), null);
  assert.equal(SCH.dueDecision(card, T.newTankState(), dec.day).id, dec.id);
});

// ---------- the main feed ----------
ok('one feed item in four is a physical idea card (25%)', () => {
  const slots = Array.from({ length: 400 }, (_, i) => F.isIdeaSlot(i));
  assert.equal(slots.filter(Boolean).length, 100);
});

ok('RUN IT stays open across swipes, ticks a day per swipe and settles to the desk ledger', () => {
  const card = { id: 'idea-x', scenarioId: 'dsk-keystone-2022', stepIdx: DESK.find((c) => c.id === 'dsk-keystone-2022').steps.findIndex((x) => x.kind === 'idea') };
  let p = emptyProgress();
  const paper = p.bankroll;
  p = F.runIdea(p, card, DESK);
  const s = sc('dsk-keystone-2022');
  const step = s.steps[card.stepIdx];
  for (let k = 1; k < step.horizon; k++) {
    const r = F.tickIdeas(p, DESK);
    p = r.progress;
    assert.equal(p.phys.ideas.open.length, 1, `still open after swipe ${k}`);
    near(F.ideaMarks(p, DESK)[0].mtm, E.ideaPnl(s, step, step.day, step.day + k), 1e-6, 'marked');
  }
  const r = F.tickIdeas(p, DESK);
  assert.equal(r.progress.phys.ideas.open.length, 0);
  const want = Math.round(E.settle(s, step, step.day).pnl);
  assert.equal(r.progress.phys.pnl, want);
  assert.equal(r.progress.bankroll, paper, 'never touches the paper account');
  assert.equal(r.events.length, 1);
});

ok('PASS reveals the outcome and scores the call', () => {
  const ks = DESK.find((c) => c.id === 'dsk-uri-freeze-2021');
  const stepIdx = ks.steps.findIndex((x) => x.kind === 'idea' && x.type === 'location_arb'); // Midland arb: runs the wrong way
  const r = F.passIdea(emptyProgress(), { id: 'idea-m', scenarioId: ks.id, stepIdx }, DESK);
  assert.ok(r.outcome.pnl < 0);
  assert.equal(r.outcome.right, true);
  assert.equal(r.progress.phys.ideas.right, 1);
});

console.log(`desk tests: ${n} passed ✓`);
