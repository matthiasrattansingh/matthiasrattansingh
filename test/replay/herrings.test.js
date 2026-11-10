import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Session } from '../../site/js/session.js';
import { headlineHtml } from '../../site/js/tape.js';
import { reportCard, tapeAutopsy, tradesToCsv, saveScore, loadScores, aggregate } from '../../site/js/report.js';

const raw = readFileSync(new URL('../../data/headlines.json', import.meta.url), 'utf8');
const file = JSON.parse(raw); // (1) valid JSON, or this throws
const H = file.headlines;
const DAYS = ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
const CL = JSON.parse(readFileSync(new URL('../../data/CL.json', import.meta.url)));
const NG = JSON.parse(readFileSync(new URL('../../data/NG.json', import.meta.url)));

function flatDay(n = 60, px = 80) {
  let h = 7, m = 0;
  return Array.from({ length: n }, (_, i) => {
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 5; if (m >= 60) { h += 1; m = 0; }
    return { t: i, time, o: px, h: px + 0.05, l: px - 0.05, c: px, v: 100 };
  });
}
const herring = (time, implies, headline = 'Videos circulating online purport to show a fire') =>
  ({ date: '2026-01-05', time, type: 'HORMUZ', time_precision: 'approx', pause: false, products: ['CL'], headline, class: 'noise', implies, herring_type: 'a' });
function sessionWith(headlines) {
  return new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: flatDay() }, headlines, prevDay: '2026-01-02' });
}
const stepTo = (s, clock) => { while (s.clock() < clock) s.step(); assert.equal(s.clock(), clock); };

// ------------------------------------------------------------------ (1) schema
test('headlines.json: valid JSON, every entry has class real|noise and the required fields', () => {
  assert.equal(file.timezone, 'America/Chicago');
  assert.ok(H.length > 60);
  for (const h of H) {
    const id = `${h.date} ${h.time} ${h.headline.slice(0, 40)}`;
    assert.ok(h.class === 'real' || h.class === 'noise', `class missing/invalid: ${id}`);
    assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/, id);
    assert.match(h.time, /^\d{2}:\d{2}$/, id);
    assert.ok(['EIA', 'EIA-NG', 'API', 'HORMUZ', 'MACRO', 'OTHER'].includes(h.type), id);
    assert.ok(h.headline.length > 10, id);
    assert.doesNotMatch(h.headline, /noise|herring/i, `headline hints at its class: ${id}`);
    if (h.class === 'noise') {
      assert.ok(h.implies === 'up' || h.implies === 'down', `noise needs implies: ${id}`);
      assert.equal(h.time_precision, 'approx', id);
      assert.equal(h.pause, false, id);
      assert.ok(!['EIA', 'EIA-NG', 'API'].includes(h.type), `noise must not be a scheduled data print: ${id}`);
      assert.ok(h.time >= '07:00' && h.time < '14:30', `noise should print inside the session: ${id}`);
    }
  }
  // file order says nothing about class
  const sorted = [...H].sort((a, b) => (a.date + a.time + a.headline < b.date + b.time + b.headline ? -1 : 1));
  assert.deepEqual(H.map((h) => h.headline), sorted.map((h) => h.headline));
  // noise never shares a timestamp with a scheduled (exact) print
  for (const n of H.filter((h) => h.class === 'noise')) {
    assert.equal(H.some((r) => r.class === 'real' && r.time_precision === 'exact' && r.date === n.date && r.time === n.time), false, `${n.date} ${n.time}`);
  }
  // verified EIA entries with figures are still there
  const eia = (d, kw) => H.some((h) => h.date === d && h.time === '09:30' && h.class === 'real' && h.pause === true && h.headline.includes(kw));
  assert.ok(eia('2026-10-28', '-1.892M') && eia('2026-11-04', '-0.865M') && eia('2026-10-29', '+80 Bcf') && eia('2026-11-05', '+77 Bcf'));
});

// ------------------------------------------------------------------ (4) coverage per day
test('each of the 10 days has at least 2 red herrings and all Part 1 real drivers', () => {
  const part1 = {
    '2026-10-27': [['06:00', 'supreme leader'], ['06:00', '3 ballistic missiles'], ['15:30', 'crude -2.03M']],
    '2026-10-28': [['06:00', 'Ras Tanura'], ['09:30', '-1.892M'], ['13:00', 'Fed holds rates'], ['13:30', 'Warsh']],
    '2026-10-29': [['06:00', 'Vance wrote'], ['07:30', 'Q3 GDP'], ['07:30', 'tanker'], ['09:30', '+80 Bcf'], ['12:00', 'not a negotiation restart']],
    '2026-10-30': [['06:00', 'limpet-mine'], ['06:00', 'Tankers defy'], ['07:30', 'Employment Cost Index'], ['08:00', 'December Brent futures expire']],
    '2026-11-02': [['06:00', 'Qatar-mediated draft'], ['06:00', 'OPEC+'], ['12:00', 'Distillate cracks']],
    '2026-11-03': [['06:00', 'abundance'], ['07:00', 'midterm election'], ['10:30', '$93.60'], ['15:30', 'API']],
    '2026-11-04': [['06:00', 'Democrats take the Senate'], ['09:30', '-0.865M'], ['11:00', 'JPMorgan']],
    '2026-11-05': [['06:00', 'More ships attacked'], ['08:00', 'Prediction markets'], ['09:30', '+77 Bcf']],
    '2026-11-06': [['06:00', 'Brent spikes through $100'], ['07:30', 'jobs report'], ['12:00', 'spike fades']],
    '2026-11-09': [['07:00', 'Natural gas decouples'], ['09:00', "Qatar's prime minister"], ['10:00', 'Israel Hayom'], ['11:00', 'Trump meets']],
  };
  assert.deepEqual(Object.keys(part1), DAYS);
  for (const day of DAYS) {
    const noise = H.filter((h) => h.date === day && h.class === 'noise');
    assert.ok(noise.length >= 2 && noise.length <= 3, `${day}: ${noise.length} noise entries`);
    for (const [time, kw] of part1[day]) {
      const hit = H.filter((h) => h.date === day && h.time === time && h.class === 'real' && h.headline.toLowerCase().includes(kw.toLowerCase()));
      assert.equal(hit.length, 1, `${day} ${time} "${kw}" should appear exactly once as a real entry`);
    }
  }
  assert.match(H.find((h) => h.date === '2026-11-04' && h.type === 'EIA').autopsy_note, /FELL/);
  // herring types rotate: all six kinds are used
  assert.deepEqual([...new Set(H.filter((h) => h.class === 'noise').map((h) => h.herring_type))].sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
});

// ------------------------------------------------------------------ (2) no class leak
test('NO LEAK: a red herring renders byte-identically to a real item on the session tape', () => {
  // same visible fields, different hidden fields -> identical bytes
  const visible = { date: '2026-01-05', time: '08:10', type: 'HORMUZ', time_precision: 'approx', headline: 'Fire reported at a terminal' };
  const real = { ...visible, class: 'real', source: 'Reuters', url: 'https://example.com/a', pause: false, products: ['CL'] };
  const noise = { ...visible, class: 'noise', implies: 'up', herring_type: 'a', autopsy_note: 'unverified', source: 'Authored red herring', url: '', pause: false, products: ['CL'] };
  for (const prior of [false, true]) {
    assert.equal(headlineHtml({ clock: '08:10', kind: 'headline', item: noise, prior }), headlineHtml({ clock: '08:10', kind: 'headline', item: real, prior }));
  }

  // every item in the real file, rendered the way a session renders it: structure depends only on
  // (type, precision, prior), and nothing hidden reaches the markup
  const skeleton = (html, h) => html.replace(h.headline.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), '§').replace(/\d{2}:\d{2}/g, 'T').replace(/\d{2}-\d{2} /g, 'D ');
  const shapes = new Map();
  for (const day of DAYS) {
    for (const [inst, data] of [['CL', CL], ['NG', NG]]) {
      const s = new Session({ day, instrumentId: inst, dayBars: { [inst]: data.days[day] }, headlines: H });
      while (!s.isLastBar) s.step();
      for (const t of s.tape.filter((x) => x.kind === 'headline')) {
        const html = headlineHtml(t);
        const h = t.item;
        for (const hidden of ['noise', 'herring', 'implies', 'autopsy', 'data-', 'title=', 'href', 'Desk owner', 'Authored', h.source, h.autopsy_note, h.url]) {
          if (hidden) assert.equal(html.toLowerCase().includes(String(hidden).toLowerCase()), false, `"${hidden}" leaked for: ${h.headline}`);
        }
        assert.deepEqual([...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]).filter((c) => !['', 'prior', 't', 'muted', `tag tag-${h.type}`].includes(c)), [], 'only class-blind CSS classes');
        const key = `${h.type}|${h.time_precision}|${Boolean(t.prior)}`;
        const sk = skeleton(html, h);
        if (!shapes.has(key)) shapes.set(key, sk);
        assert.equal(sk, shapes.get(key), `structure differs within ${key}: ${h.headline}`);
      }
    }
  }
  // both classes were actually exercised under at least one shared shape
  const seen = (c) => new Set(H.filter((h) => h.class === c).map((h) => `${h.type}|${h.time_precision}`));
  assert.ok([...seen('noise')].every((k) => seen('real').has(k)), 'every noise shape is also a real shape');
});

test('NO LEAK: session state exposes nothing class-dependent until it is finished', () => {
  const s = sessionWith([herring('08:00', 'up')]);
  stepTo(s, '08:05');
  s.submit({ side: 'BUY', qty: 1 });
  assert.throws(() => tapeAutopsy(s), /after the session ends/);
  const mid = reportCard(s);
  assert.deepEqual([mid.autopsy.length, mid.herringsSeen, mid.timesBaited], [0, 0, 0]);
  const midCsv = tradesToCsv(s.account.trades, s.day, 2, null);
  assert.equal(midCsv.includes('BAITED'), false);
  assert.equal(s.tape.filter((t) => t.kind !== 'headline').some((t) => /bait|herring|noise/i.test(t.text)), false, 'no fill/system tape line mentions it');
});

// ------------------------------------------------------------------ (3) baited detector
test('BAITED: entry 10 minutes after a herring in its implied direction is flagged', () => {
  const s = sessionWith([herring('08:00', 'up')]);
  stepTo(s, '08:10');
  s.submit({ side: 'BUY', qty: 2 });
  stepTo(s, '09:00');
  s.flatten();
  s.finish();
  assert.equal(s.baitEvents.length, 1);
  assert.deepEqual([s.baitEvents[0].herringClock, s.baitEvents[0].clock, s.baitEvents[0].qty], ['08:00', '08:10', 2]);
  assert.equal(s.account.trades.length, 1);
  assert.equal(s.account.trades[0].baited, true);
  const c = reportCard(s);
  assert.deepEqual([c.herringsSeen, c.timesBaited, c.baitedTrades], [1, 1, 1]);
  assert.ok(Math.abs(c.baitedNet - s.account.trades[0].net) < 1e-9 && c.cleanNet === 0);
  const a = tapeAutopsy(s);
  assert.equal(a[0].label, 'RED HERRING');
  assert.equal(a[0].baits.length, 1);
});

test('BAITED: boundary is 15 minutes inclusive; adding to a position also counts', () => {
  const s = sessionWith([herring('08:00', 'down')]);
  stepTo(s, '07:30'); s.submit({ side: 'SELL', qty: 1 });           // before the herring: clean
  stepTo(s, '08:15'); s.submit({ side: 'SELL', qty: 1 });           // adds at +15 min: baited
  s.finish();
  assert.equal(s.baitEvents.length, 1);
  assert.deepEqual(s.account.trades.map((t) => t.baited), [false, true]);
});

test('NOT BAITED: 20 minutes after, or in the opposite direction, or a herring that has not printed', () => {
  const late = sessionWith([herring('08:00', 'up')]);
  stepTo(late, '08:20'); late.submit({ side: 'BUY', qty: 1 }); late.finish();
  assert.equal(late.baitEvents.length, 0);
  assert.equal(late.account.trades[0].baited, false);

  const opposite = sessionWith([herring('08:00', 'up')]);
  stepTo(opposite, '08:10'); opposite.submit({ side: 'SELL', qty: 1 }); opposite.finish();
  assert.equal(opposite.baitEvents.length, 0);
  assert.equal(opposite.account.trades[0].baited, false);

  const before = sessionWith([herring('08:00', 'up')]);
  stepTo(before, '07:55'); before.submit({ side: 'BUY', qty: 1 }); before.finish();
  assert.equal(before.baitEvents.length, 0);
});

test('NOT BAITED: real headlines, exits, and resting orders placed before the herring', () => {
  const realItem = { ...herring('08:00', 'up'), class: 'real' };
  const r = sessionWith([realItem]);
  stepTo(r, '08:10'); r.submit({ side: 'BUY', qty: 1 }); r.finish();
  assert.equal(r.baitEvents.length, 0);
  assert.equal(tapeAutopsy(r)[0].label, 'REAL');

  // closing a short by buying right after an "up" herring is an exit, not a baited entry
  const x = sessionWith([herring('08:00', 'up')]);
  stepTo(x, '07:30'); x.submit({ side: 'SELL', qty: 1 });
  stepTo(x, '08:05'); x.submit({ side: 'BUY', qty: 1 }); x.finish();
  assert.equal(x.baitEvents.length, 0);

  // a limit placed BEFORE the herring that fills after it was not a reaction to it
  const bars = flatDay(); bars[14] = { ...bars[14], l: 79.5 };      // 08:10 bar dips through 79.80
  const l = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: bars }, headlines: [herring('08:00', 'up')], prevDay: '2026-01-02' });
  stepTo(l, '07:30'); l.submit({ side: 'BUY', type: 'LMT', qty: 1, price: 79.8 });
  stepTo(l, '08:15');
  assert.equal(l.account.position, 1);
  l.finish();
  assert.equal(l.baitEvents.length, 0);
});

// ------------------------------------------------------------------ scoreboard + CSV
test('scoreboard and CSV carry herrings seen and times baited', () => {
  const s = sessionWith([herring('08:00', 'up'), herring('09:00', 'down', 'Sources say a deal is close')]);
  stepTo(s, '08:05'); s.submit({ side: 'BUY', qty: 1 });
  stepTo(s, '08:30'); s.flatten();
  stepTo(s, '10:00'); s.submit({ side: 'BUY', qty: 1 });
  s.finish();
  const c = reportCard(s);
  assert.deepEqual([c.herringsSeen, c.timesBaited, c.trades], [2, 1, 2]);

  const csv = tradesToCsv(s.account.trades, s.day, 2, { finished: true, herringsSeen: c.herringsSeen, timesBaited: c.timesBaited, product: 'CL' });
  const [head, r1, r2] = csv.trim().split('\n');
  assert.match(head, /,baited,baitHeadline,sessionHerringsSeen,sessionTimesBaited$/);
  assert.match(r1, /,BAITED,Videos circulating online purport to show a fire,2,1$/);
  assert.match(r2, /,,,2,1$/);
  const none = tradesToCsv([], s.day, 2, { finished: true, herringsSeen: 2, timesBaited: 0, product: 'CL' });
  assert.match(none.trim().split('\n')[1], /NO TRADES.*,2,0$/);

  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  saveScore(c, storage); saveScore(c, storage);
  const list = loadScores(storage);
  assert.deepEqual([list[0].herrings, list[0].baited], [2, 1]);
  const agg = aggregate(list, 'product')[0];
  assert.deepEqual([agg.sessions, agg.herrings, agg.baited], [2, 4, 2]);
  // sessions saved before this upgrade (no herring fields) still aggregate
  assert.equal(aggregate([{ day: 'd', product: 'CL', net: 1, trades: 1, passive: 0 }], 'day')[0].herrings, 0);
});
