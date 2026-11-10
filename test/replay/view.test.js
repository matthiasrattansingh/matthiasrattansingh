import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { View, biasOf, viewLabel } from '../../site/js/view.js';
import { runCoach } from '../../site/js/coachbot.js';

const read = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}`, import.meta.url), 'utf8'));
const H = read('headlines.json').headlines;
const COACH_FILE = read('coach.json');
const DATA = Object.fromEntries(['CL', 'BZ', 'NG', 'RB', 'HO'].map((s) => [s, read(`${s}.json`)]));
const DAYS = Object.keys(DATA.CL.days);
const run = (day, inst = 'CL', headlines = H) => {
  const legs = inst === 'BZ-CL' ? ['BZ', 'CL'] : [inst];
  return runCoach({ day, instrumentId: inst, dayBars: Object.fromEntries(legs.map((p) => [p, DATA[p].days[day]])), headlines, prevDay: DAYS[DAYS.indexOf(day) - 1] ?? null });
};
const entry = (o) => ({ clock: o.clock ?? o.time, prior: o.prior ?? false, item: { class: 'real', type: 'OTHER', time_precision: 'approx', headline: 'x', ...o } });

// ------------------------------------------------------------------ data
test('VIEW DATA: every real headline has bias and weight; herrings are bias 0; prints carry consensus', () => {
  for (const h of H) {
    const id = `${h.date} ${h.time} ${h.headline.slice(0, 40)}`;
    if (h.class === 'noise') { assert.equal(h.bias, 0, `herring must be bias 0: ${id}`); assert.equal(h.weight, undefined, id); continue; }
    assert.ok([-1, 0, 1].includes(h.bias), `bias: ${id}`);
    assert.ok([1, 2, 3].includes(h.weight), `weight: ${id}`);
    if (h.time_precision === 'exact') assert.ok(typeof h.consensus === 'string' && h.consensus.length > 3, `scheduled print needs a consensus note: ${id}`);
  }
  // an in-line or unscored print moves nothing
  for (const h of H.filter((x) => x.class === 'real' && /not recorded: treated as in line|treated as in line/.test(x.consensus || ''))) assert.equal(h.bias, 0);
  // consensus notes are in the briefings for every scheduled print in the session
  for (const [day, d] of Object.entries(COACH_FILE.days)) {
    for (const ev of d.events.filter((e) => /^\d\d:\d\d$/.test(e.time) && !/press conference|Commitments/.test(e.label))) assert.ok(ev.consensus, `${day} ${ev.time} ${ev.label}`);
  }
  // a herring can never set the view, even if someone edits a bias onto it
  assert.equal(biasOf({ class: 'noise', bias: 1, weight: 3 }, ['CL']), 0);
  assert.equal(biasOf({ class: 'real', bias: 0, bias_by_product: { NG: 1 } }, ['NG']), 1);
  assert.equal(biasOf({ class: 'real', bias: 0, bias_by_product: { NG: 1 } }, ['CL']), 0);
});

// ------------------------------------------------------------------ view arithmetic
test('VIEW: sign of the weighted sum, neutral band, carried from overnight items', () => {
  const v = new View({ legs: ['CL'] });
  assert.equal(v.label, 'NEUTRAL');
  v.add(entry({ time: '06:00', prior: true, bias: 1, weight: 1 }), 80, 0);
  assert.deepEqual([v.sum, v.label], [1, 'NEUTRAL'], 'a single piece of color is not a view');
  v.add(entry({ time: '08:00', bias: 1, weight: 2 }), 80.5, 12);
  assert.deepEqual([v.sum, v.label], [3, 'LONG']);
  v.add(entry({ time: '09:00', bias: -1, weight: 3 }), 81, 24);
  assert.deepEqual([v.sum, v.label], [0, 'NEUTRAL']);
  assert.equal(v.add(entry({ time: '09:05', bias: 0, weight: 2 }), 81, 25).status, 'ignored');
  assert.equal(v.add(entry({ time: '09:10', class: 'noise', bias: 1, weight: 3 }), 81, 26).status, 'ignored');
  assert.equal(viewLabel(-1), 'SHORT');
  assert.equal(v.lastSupport(), null);
});

test('VIEW at the open for each of the 10 days (CL), from real overnight items only', () => {
  const expected = { '2026-10-27': 'SHORT', '2026-10-28': 'LONG', '2026-10-29': 'SHORT', '2026-10-30': 'LONG', '2026-11-02': 'SHORT',
    '2026-11-03': 'SHORT', '2026-11-04': 'SHORT', '2026-11-05': 'LONG', '2026-11-06': 'NEUTRAL', '2026-11-09': 'NEUTRAL' };
  const got = Object.fromEntries(DAYS.map((d) => [d, run(d).openView]));
  assert.deepEqual(got, expected);
  // stripping every herring from the file changes nothing in any view frame
  const realOnly = H.filter((h) => h.class === 'real');
  for (const d of DAYS) assert.deepEqual(run(d, 'CL', realOnly).frames.map((f) => [f.view.dir, f.view.sum]), run(d).frames.map((f) => [f.view.dir, f.view.sum]), d);
  // natural gas has its own view: the Nov 9 decoupling item is bullish for NG only
  assert.equal(run('2026-11-09', 'NG').frames.at(-1).view.dir, 1);
});

// ------------------------------------------------------------------ thesis hierarchy
test('THESIS HIERARCHY: one scheduled print cannot flip a weight-3 view unless price holds 3 bars', () => {
  const print = (o = {}) => entry({ time: '09:30', type: 'EIA', time_precision: 'exact', bias: 1, weight: 2, ...o });
  const mk = () => { const v = new View({ legs: ['CL'] }); v.add(entry({ time: '06:00', prior: true, bias: -1, weight: 3 }), 94, 0); return v; };

  let v = mk();
  assert.equal(v.add(print(), 93.9, 29).status, 'pending');
  assert.deepEqual([v.sum, v.label], [-3, 'SHORT'], 'the print is held back, not netted');
  for (const c of [93.5, 93.2, 94.0, 94.1, 93.8, 94.2]) v.onBar(c, 30);          // never 3 in a row above 93.90
  assert.deepEqual([v.label, v.pending.length], ['SHORT', 1]);

  v = mk();
  v.add(print(), 93.9, 29);
  assert.deepEqual(v.onBar(94.0, 30), []); assert.deepEqual(v.onBar(94.1, 31), []);
  const flipped = v.onBar(94.3, 32);
  assert.equal(flipped.length, 1, 'three consecutive closes above the pre-print level');
  assert.deepEqual([v.sum, v.label, v.pending.length], [2, 'LONG', 0], 'the market overruled the hierarchy');
  assert.equal(v.events.find((e) => e.weight === 3).overruled, true);

  // a print that agrees with the view, or a view not set by a weight-3 driver, is simply added
  v = mk();
  assert.equal(v.add(print({ bias: -1 }), 93.9, 29).status, 'added');
  const w2 = new View({ legs: ['CL'] });
  w2.add(entry({ time: '06:00', prior: true, bias: -1, weight: 2 }), 94, 0);
  assert.equal(w2.add(print(), 93.9, 29).status, 'added');
  assert.equal(w2.label, 'NEUTRAL');
  // an unscheduled weight-2 development is not a "single scheduled print": it nets normally
  v = mk();
  assert.equal(v.add(entry({ time: '10:00', bias: 1, weight: 2 }), 93.9, 36).status, 'added');
});

test('Nov 4 (CL): bullish EIA against an election-repricing view. The view stays SHORT all day', () => {
  const r = run('2026-11-04');
  assert.equal(r.openView, 'SHORT');
  assert.ok(r.frames.every((f) => f.view.dir === -1), 'SHORT on every bar');
  assert.equal(r.view.pending.length, 1, 'the EIA print stays held back');
  assert.equal(r.view.pending[0].type, 'EIA');
  assert.ok(r.notes.some((n) => /^09:30: EIA print reads bullish against consensus \(\+2\), but the view is SHORT on a weight-3 driver/.test(n.text)));
  assert.equal(r.trade.side, 'SHORT');
});

// ------------------------------------------------------------------ gating
test('GATING: one trade a session, always with the view (or an A plus C fade), none on a neutral day', () => {
  for (const inst of ['CL', 'BZ', 'RB', 'HO', 'NG', 'BZ-CL']) {
    for (const day of DAYS) {
      const r = run(day, inst);
      const entries = r.fills.filter((f) => f.reason === 'market');
      assert.ok(entries.length <= 1 && r.trades.length <= 1, `${inst} ${day}: more than one trade`);
      assert.equal(r.frames.length, DATA.CL.days[day].length);
      assert.equal(r.frames.at(-1).position, 0, 'flat at 14:30');
      if (!r.trade) { assert.equal(entries.length, 0); continue; }
      const f = r.frames.find((x) => x.clock === r.trade.entryClock);
      const dir = r.trade.side === 'LONG' ? 1 : -1;
      assert.notEqual(f.view.dir, 0, `${inst} ${day}: traded on a neutral view`);
      if (r.trade.signal === 'A+C') assert.equal(f.view.dir, -dir, 'a fade is against the view');
      else assert.equal(f.view.dir, dir, `${inst} ${day}: ${r.trade.side} on Signal ${r.trade.signal} against a ${f.view.label} view`);
      assert.ok(['stop', 'stall', 'close'].includes(r.trade.exitReason));
      assert.equal(r.notes.filter((n) => n.kind === 'entry').length, 1);
    }
  }
  // Nov 6 opens neutral and no weight-3 event lands: no best trade
  const n6 = run('2026-11-06');
  assert.equal(n6.trade, null); assert.equal(n6.net, 0);
  assert.match(n6.notes.at(-1).text, /No trade today\. The view was neutral\./);
  // Nov 9 opens neutral; the weight-3 report at 09:00 unlocks the day, short only
  const n9 = run('2026-11-09');
  assert.equal(n9.openView, 'NEUTRAL');
  assert.equal(n9.frames.find((f) => f.clock === '09:00').view.label, 'SHORT');
  assert.ok(!n9.trade || (n9.trade.side === 'SHORT' && n9.trade.entryClock >= '09:00'));
});

test('FADE: an A plus C signal against the view counts only when the move is exhausted', () => {
  // synthetic tape: LONG view (weight-3 at the open), a rally, then a breakdown through VWAP and the range
  const closes = [100.2, 100.3, 100.1, 100.2, 100.3, 100.2];                         // 07:00-07:25 range 100.05..100.35
  closes.push(100.6);                                                                // 07:30 bar: A up, blocked by the print
  for (let k = 0; k < 20; k++) closes.push(100.6 + (k + 1) * 0.12);                  // rally to 103.0
  for (let k = 0; k < 30; k++) closes.push(103.0 - (k + 1) * 0.11);                  // slide to 99.7
  while (closes.length < 90) closes.push(99.7);
  let h = 7, m = 0;
  const bars = closes.map((c, i) => { const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`; m += 5; if (m >= 60) { h += 1; m = 0; }
    const o = i ? closes[i - 1] : c; return { t: i, time, o, h: Math.max(o, c) + 0.05, l: Math.min(o, c) - 0.05, c, v: 100 }; });
  const base = { date: '2026-01-05', products: ['CL'], class: 'real', pause: false };
  const heads = [
    { ...base, time: '06:00', type: 'HORMUZ', time_precision: 'approx', headline: 'Verified attack', bias: 1, weight: 3 },
    { ...base, time: '07:35', type: 'MACRO', time_precision: 'exact', headline: 'A scheduled print, in line', bias: 0, weight: 2, consensus: 'in line' },
  ];
  const r = runCoach({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: bars }, headlines: heads, prevDay: '2026-01-02' });
  const text = r.notes.map((n) => n.text).join('\n');
  assert.match(text, /Signal A\. It agrees with the LONG view\. MACRO just printed\..* Pass\./, text);
  assert.match(text, /Signal C\. A short against a LONG view\. Not taken\./, 'C alone is not a fade');
  assert.equal(r.trade.signal, 'A+C', text);
  assert.equal(r.trade.side, 'SHORT');
  assert.match(text, /Signal A plus C against the LONG view\. The move ran [\d.]+ from 100\.20 with no new supporting event: exhausted\. Fade it\./);

  // same tape, but a new supporting event lands at the top of the rally: the move is measured from
  // there, has gone nowhere since, and so is not exhausted. No fade.
  const fresh = [...heads, { ...base, time: '09:15', type: 'HORMUZ', time_precision: 'approx', headline: 'A second confirmed attack', bias: 1, weight: 2 }];
  const r2 = runCoach({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: bars }, headlines: fresh, prevDay: '2026-01-02' });
  const text2 = r2.notes.map((n) => n.text).join('\n');
  assert.equal(r2.trade, null, text2);
  assert.match(text2, /Signal A\. A short against a LONG view, and the move has only run 0\.\d+ \(needs \d\.\d+\)\. Not taken\./, text2);
});

// ------------------------------------------------------------------ acceptance tests
test('ACCEPTANCE 1: 2026-10-29 CL (diplomacy fade). View SHORT from the open; best realistic is a short', (t) => {
  const r = run('2026-10-29');
  assert.equal(r.openView, 'SHORT');
  assert.deepEqual(r.view.events.filter((e) => e.bias < 0).map((e) => [e.time, e.weight]), [['06:00', 3], ['07:30', 2]], 'Vance letter, then hot PCE');
  const untilNoon = r.frames.filter((f) => f.clock < '12:00');
  assert.ok(untilNoon.every((f) => f.view.dir === -1), 'SHORT on every bar from the open until the 12:00 pushback');
  assert.equal(r.trade.side, 'SHORT');
  assert.ok(r.net > 0);
  // reference from the desk owner: short about 100.90, exit about 99.45
  const bars = DATA.CL.days['2026-10-29'];
  const lowAfterEntry = Math.min(...bars.filter((b) => b.time >= r.trade.entryClock).map((b) => b.l));
  t.diagnostic(`engine: short ${r.trade.entry} at ${r.trade.entryClock} (Signal ${r.trade.signal}), exit ${r.trade.exit} at ${r.trade.exitClock} (${r.trade.exitReason}), net $${r.net.toFixed(0)}`);
  t.diagnostic(`reference: short ~100.90, exit ~99.45. Session low on this tape ${Math.min(...bars.map((b) => b.l))}; low after the entry ${lowAfterEntry}`);
  assert.ok(Math.abs(r.trade.entry - 100.9) <= 0.35, `entry ${r.trade.entry} is within 0.35 of the 100.90 reference`);
  // the reference exit never traded on this day in the baked data, so no rule set can reach it
  assert.ok(Math.min(...bars.map((b) => b.l)) > 99.45, 'the 99.45 reference exit is below the session low in the data');
});

test('ACCEPTANCE 2: 2026-10-30 CL (verified attack). View LONG from the open; best realistic is a long or no trade', (t) => {
  const r = run('2026-10-30');
  assert.equal(r.openView, 'LONG');
  assert.ok(r.frames.every((f) => f.view.dir === 1), 'LONG on every bar');
  assert.ok(r.trade === null || r.trade.side === 'LONG', 'a short here means the gating is broken');
  assert.equal(r.fills.filter((f) => f.reason === 'market' && f.side === 'SELL').length, 0, 'no short entry was ever sent');
  assert.ok(r.notes.some((n) => /A short against a LONG view\. Not taken\./.test(n.text)), 'the short signal fired and was refused');
  t.diagnostic(r.trade ? `engine: long ${r.trade.entry} at ${r.trade.entryClock} (Signal ${r.trade.signal}), exit ${r.trade.exit} at ${r.trade.exitClock} (${r.trade.exitReason}), net $${r.net.toFixed(0)}` : 'engine: no trade');
});

// ------------------------------------------------------------------ real-time only
test('REAL TIME ONLY: view and trades up to 10:00 are identical when every later bar and headline is poisoned', () => {
  const K = 36;
  for (const day of DAYS) {
    const r = run(day);
    const cut = r.frames[K].clock;
    const poisonedBars = DATA.CL.days[day].map((b, i) => (i <= K ? b : { ...b, o: 1e6, h: 1e6, l: 1, c: i % 2 ? 1e6 : 1, v: 1e9 }));
    const poisonedHeads = H.map((h) => (h.date === day && h.time > cut ? { ...h, class: 'real', bias: -1 * (h.bias || 1), weight: 3 } : h));
    const p = runCoach({ day, instrumentId: 'CL', dayBars: { CL: poisonedBars }, headlines: poisonedHeads, prevDay: DAYS[DAYS.indexOf(day) - 1] ?? null });
    assert.deepEqual(p.frames.slice(0, K + 1), r.frames.slice(0, K + 1), `${day}: frames`);
    assert.deepEqual(p.notes.filter((n) => n.clock <= cut && n.kind !== 'summary'), r.notes.filter((n) => n.clock <= cut && n.kind !== 'summary'), `${day}: narration`);
  }
});

// ------------------------------------------------------------------ coach size
test('COACH SIZE: the coach trades 10 contracts and reports dollars, dollars per barrel and R', async () => {
  const { COACH_CONTRACTS, ACCOUNT } = await import('../../site/js/config.js');
  const { Session } = await import('../../site/js/session.js');
  const { reportCard } = await import('../../site/js/report.js');
  assert.equal(COACH_CONTRACTS, 10);
  const r = run('2026-10-29');
  const t = r.trade;
  assert.equal(t.contracts, 10);
  assert.deepEqual(r.fills.map((f) => f.qty), [10, 10], 'entry and exit are both 10 lots');
  // same fills, slippage and per-contract fees as one lot: short 100.61, out 100.38
  assert.deepEqual([t.entry, t.exit], [100.61, 100.38]);
  const gross = (100.61 - 100.38) * 1000 * 10;
  const fees = 10 * 2 * ACCOUNT.feePerContractPerSide;
  assert.ok(Math.abs(t.gross - gross) < 1e-6 && t.fees === fees && fees === 90);
  assert.ok(Math.abs(r.net - (gross - fees)) < 1e-6, 'dollars at 10 lots = 2,210');
  assert.ok(Math.abs(t.perUnit - 0.221) < 1e-9, 'dollars per barrel = net / 10,000 bbl');
  // risk per trade = contracts x stop distance x contract multiplier, measured at entry
  assert.ok(Math.abs(t.riskDollars - 10 * (t.stop - t.entry) * 1000) < 1e-6);
  assert.ok(Math.abs(t.riskDollars - 2900) < 1e-6);
  assert.ok(Math.abs(t.r - 2210 / 2900) < 1e-9, 'R = profit / initial stop risk in dollars');
  assert.equal(r.three, '+$2,210 at 10 lots, +$0.221/bbl, +0.76R');
  assert.match(r.notes.at(-1).text, /One short on Signal C: 100\.61 to 100\.38\. \+\$2,210 at 10 lots, \+\$0\.221\/bbl, \+0\.76R, after fees\.$/);
  assert.match(r.notes.find((n) => n.kind === 'entry').text, /Short 10 at 100\.61\. Stop 100\.90: 0\.29 per bbl, \$2,900 of risk\./);
  assert.ok(r.frames.some((f) => f.position === -10));
  // a losing day shows all three with the right signs
  assert.equal(run('2026-10-27').three, '-$3,990 at 10 lots, -$0.399/bbl, -1.05R');
  // where 10 lots would exceed the margin estimate, the coach takes the largest size that fits
  for (const day of DAYS) { const h = run(day, 'HO').trade; if (h) { assert.ok(h.contracts >= 1 && h.contracts < 10, `HO ${day}: ${h.contracts}`); } }

  // the trader's side of the report-card risk line: average of contracts x stop distance x multiplier
  const bars = DATA.CL.days['2026-10-29'];
  const s = new Session({ day: '2026-10-29', instrumentId: 'CL', dayBars: { CL: bars }, headlines: [], coach: true });
  s.briefingViewed = true;
  const tk = (wrong) => ({ pricing: 'x', signal: 'Range break', wrong, size: 'Normal' });
  const a = s.submit({ side: 'SELL', qty: 10, ticket: tk(102.5) }); s.flatten();
  const b = s.submit({ side: 'SELL', qty: 4, ticket: tk(102.3) }); s.flatten();
  s.finish();
  const c = reportCard(s);
  const expect = (10 * (102.5 - a.order.fillPrice) * 1000 + 4 * (102.3 - b.order.fillPrice) * 1000) / 2;
  assert.ok(Math.abs(c.avgRisk - expect) < 1e-6, `${c.avgRisk} vs ${expect}`);
  assert.ok(Math.abs(c.avgRiskPct - (expect / 100000) * 100) < 1e-9);
  const none = new Session({ day: '2026-10-29', instrumentId: 'CL', dayBars: { CL: bars }, headlines: [] }); none.finish();
  assert.equal(reportCard(none).avgRisk, null);
});
