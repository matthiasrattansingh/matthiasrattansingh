import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PRODUCTS } from '../../site/js/config.js';
import { getInstrument, instrumentQuote, productQuote, slippage, feesFor, pnlDollars, marginFor } from '../../site/js/instruments.js';
import { barFillPrice, marketFillPrice } from '../../site/js/orders.js';
import { Account } from '../../site/js/account.js';
import { Session } from '../../site/js/session.js';
import { vwap, ema } from '../../site/js/indicators.js';
import { reportCard, tradesToCsv, maxDrawdown } from '../../site/js/report.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// Build a synthetic day of bars for unit tests (test fixtures only; the app uses /data).
function makeDay(closes, start = '07:00') {
  let [h, m] = start.split(':').map(Number);
  return closes.map((c, i) => {
    const time = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    m += 5; if (m >= 60) { h += 1; m -= 60; }
    const o = i ? closes[i - 1] : c;
    return { t: i, time, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 100 };
  });
}
const bar = (o, h, l, c) => ({ o, h, l, c, v: 1 });

// ------------------------------------------------------------------ fills
test('limit buy fills only when a bar trades THROUGH the limit', () => {
  const o = { side: 'BUY', type: 'LMT', price: 80.0 };
  assert.equal(barFillPrice(o, bar(80.2, 80.3, 80.0, 80.1), 0.01, 0.01), null, 'touching the limit is not a fill');
  assert.equal(barFillPrice(o, bar(80.2, 80.3, 80.01, 80.1), 0.01, 0.01), null);
  assert.equal(barFillPrice(o, bar(80.2, 80.3, 79.99, 80.1), 0.01, 0.01), 80.0, 'trades through -> fill at limit, no slippage');
  assert.equal(barFillPrice(o, bar(79.5, 79.9, 79.4, 79.8), 0.01, 0.01), 79.5, 'gap below limit -> fill at the open');
});

test('limit sell fills only when a bar trades through the limit', () => {
  const o = { side: 'SELL', type: 'LMT', price: 3.05 };
  assert.equal(barFillPrice(o, bar(3.0, 3.05, 2.99, 3.01), 0.0001, 0.0001), null);
  assert.equal(barFillPrice(o, bar(3.0, 3.0501, 2.99, 3.01), 0.0001, 0.0001), 3.05);
  assert.equal(barFillPrice(o, bar(3.1, 3.12, 3.09, 3.1), 0.0001, 0.0001), 3.1);
});

test('stop orders trigger on touch and slip 1 tick against you', () => {
  const buyStop = { side: 'BUY', type: 'STP', price: 81.0 };
  assert.equal(barFillPrice(buyStop, bar(80.5, 80.99, 80.4, 80.9), 0.01, 0.01), null);
  assert.equal(barFillPrice(buyStop, bar(80.5, 81.0, 80.4, 80.9), 0.01, 0.01), 81.01);
  assert.equal(barFillPrice(buyStop, bar(81.5, 81.6, 81.4, 81.5), 0.01, 0.01), 81.51, 'gap through stop fills at open + slip');
  const sellStop = { side: 'SELL', type: 'STP', price: 2.9 };
  assert.equal(barFillPrice(sellStop, bar(2.95, 2.96, 2.9, 2.91), 0.001, 0.001), 2.899);
});

test('market fills: buy lifts ask + 1 tick, sell hits bid - 1 tick, per product spread', () => {
  // CL: 2 ticks wide around last; bid = last - 1 tick, ask = last + 1 tick
  const cl = productQuote('CL', 80.0);
  assert.deepEqual(cl, { last: 80, bid: 79.99, ask: 80.01 });
  assert.equal(marketFillPrice('BUY', cl, 0.01, 0.01), 80.02);
  assert.equal(marketFillPrice('SELL', cl, 0.01, 0.01), 79.98);
  // NG: 3 ticks of 0.001
  const ng = productQuote('NG', 3.0);
  assert.equal(ng.bid, 2.999); assert.equal(ng.ask, 3.002);
  // RB / HO: 2 ticks of 0.0001
  const rb = productQuote('RB', 2.5);
  assert.equal(rb.bid, 2.4999); assert.equal(rb.ask, 2.5001);
  assert.equal(marketFillPrice('BUY', rb, 0.0001, 0.0001), 2.5002);
});

test('fees: $4.50 per contract per side, both legs for spreads', () => {
  assert.equal(feesFor(getInstrument('CL'), 3), 13.5);
  assert.equal(feesFor(getInstrument('BZ-CL'), 3), 27);
  const acct = new Account(getInstrument('CL'));
  acct.fill({ side: 'BUY', qty: 2, price: 80, time: '07:05' });
  acct.fill({ side: 'SELL', qty: 2, price: 80, time: '07:10' });
  assert.equal(acct.feesPaid, 18);
  assert.equal(acct.trades[0].fees, 18);
  close(acct.trades[0].net, -18);
  close(acct.equity(80), 100000 - 18);
});

// ------------------------------------------------------------------ P&L per product
test('contract P&L math per product', () => {
  const cases = [
    ['CL', 80.0, 80.5, 500],        // 0.50 * 1,000 bbl
    ['BZ', 90.0, 89.25, -750],
    ['NG', 3.0, 3.1, 1000],         // 0.10 * 10,000 MMBtu
    ['RB', 2.5, 2.51, 420],         // 0.01 * 42,000 gal
    ['HO', 4.0, 3.99, -420],
  ];
  for (const [id, entry, exit, expected] of cases) {
    const inst = getInstrument(id);
    close(pnlDollars(inst, 1, entry, exit), expected, 1e-6);
    close(pnlDollars(inst, -2, entry, exit), -2 * expected, 1e-6);
    // one tick is worth: CL/BZ $10, NG $10, RB/HO $4.20
    close(pnlDollars(inst, 1, entry, entry + PRODUCTS[id].tick), { CL: 10, BZ: 10, NG: 10, RB: 4.2, HO: 4.2 }[id], 1e-6);
    const acct = new Account(inst);
    acct.fill({ side: 'BUY', qty: 1, price: entry, time: 'a' });
    close(acct.unrealized(exit), expected, 1e-6);
    acct.fill({ side: 'SELL', qty: 1, price: exit, time: 'b' });
    close(acct.trades[0].gross, expected, 1e-6);
    close(acct.trades[0].net, expected - 9, 1e-6);
  }
});

test('FIFO partial closes and position flips', () => {
  const acct = new Account(getInstrument('CL'));
  acct.fill({ side: 'BUY', qty: 2, price: 80, time: '1' });
  acct.fill({ side: 'BUY', qty: 1, price: 81, time: '2' });
  close(acct.avgEntry, 80 + 1 / 3);
  acct.fill({ side: 'SELL', qty: 4, price: 82, time: '3' }); // closes 3, opens short 1
  assert.equal(acct.position, -1);
  assert.equal(acct.trades.length, 2);
  close(acct.trades[0].gross, 4000); close(acct.trades[1].gross, 1000);
  close(acct.realizedGross, 5000);
});

// ------------------------------------------------------------------ spread
test('spread quote, fills and P&L use both legs with fees on both', () => {
  const inst = getInstrument('BZ-CL');
  const q = instrumentQuote(inst, { BZ: 95.0, CL: 88.0 });
  assert.equal(q.last, 7.0);
  assert.equal(q.ask, 7.02, 'buy spread = BZ ask 95.01 - CL bid 87.99');
  assert.equal(q.bid, 6.98, 'sell spread = BZ bid 94.99 - CL ask 88.01');
  close(slippage(inst), 0.02);
  assert.equal(marketFillPrice('BUY', q, slippage(inst), inst.tick), 7.04);

  const acct = new Account(inst);
  acct.fill({ side: 'BUY', qty: 2, price: 7.04, time: '07:05' });
  // spread widens to 7.50: long BZ leg +, short CL leg - ... net (7.50 - 7.04) * 2 * 1000
  close(acct.unrealized(7.5), 920, 1e-6);
  acct.fill({ side: 'SELL', qty: 2, price: 7.5, time: '08:00' });
  const t = acct.trades[0];
  close(t.gross, 920, 1e-6);
  assert.equal(t.fees, 2 * 2 * 2 * 4.5, '2 spreads x 2 legs x 2 sides x $4.50');
  close(t.net, 920 - 36, 1e-6);

  // leg-by-leg equivalence: long 2 BZ 95.01->95.30 and short 2 CL 87.97->87.80
  const legPnl = pnlDollars(getInstrument('BZ'), 2, 95.01, 95.3) + pnlDollars(getInstrument('CL'), -2, 87.97, 87.8);
  close(pnlDollars(inst, 2, 95.01 - 87.97, 95.3 - 87.8), legPnl, 1e-6);
});

test('spread session trades off both legs', () => {
  const days = { BZ: makeDay([95, 95.2, 95.5, 95.4]), CL: makeDay([88, 88.0, 88.1, 88.3]) };
  const s = new Session({ day: '2026-01-05', instrumentId: 'BZ-CL', dayBars: days });
  assert.equal(s.quote().last, 7.0);
  s.submit({ side: 'BUY', qty: 1, type: 'MKT' });
  assert.equal(s.account.avgEntry, 7.04);
  s.step(); s.step();
  close(s.mark(), 95.5 - 88.1);
  s.flatten();
  const t = s.account.trades[0];
  close(t.exit, roundSpread(7.4 - 0.02 - 0.02));
  assert.equal(t.fees, 18);
});
function roundSpread(x) { return Math.round(x * 100) / 100; }

// ------------------------------------------------------------------ session behaviour
test('working limit order is only tested on bars revealed after it was placed', () => {
  const s = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: makeDay([80, 79.5, 79.8, 80.5]) } });
  // bar 0 (already revealed) traded 80.00 only; bar 1 trades down to 79.50
  const r = s.submit({ side: 'BUY', type: 'LMT', qty: 1, price: 79.7 });
  assert.ok(r.ok);
  assert.equal(s.account.position, 0, 'nothing fills against already-revealed bars');
  s.step();
  assert.equal(s.account.position, 1);
  assert.equal(r.order.fillPrice, 79.7);
});

test('bracket: stop loss and take profit are OCO and reduce-only', () => {
  const s = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: makeDay([80, 80.2, 80.6, 80.1, 79.0]) } });
  const r = s.submit({ side: 'BUY', type: 'MKT', qty: 2, bracket: { stop: 79.5, target: 80.5 } });
  assert.ok(r.ok, r.error);
  assert.equal(s.workingOrders().length, 2);
  s.step(); // 80.0 -> 80.2 nothing
  assert.equal(s.account.position, 2);
  s.step(); // 80.2 -> 80.6 trades through 80.5 target
  assert.equal(s.account.position, 0);
  assert.equal(s.workingOrders().length, 0, 'stop was cancelled by OCO');
  close(s.account.trades.reduce((a, t) => a + t.gross, 0), (80.5 - 80.02) * 2000, 1e-6);
});

test('rejects bad bracket and orders exceeding the account', () => {
  const s = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: makeDay([80, 80.1]) } });
  assert.equal(s.submit({ side: 'BUY', qty: 1, bracket: { stop: 81 } }).ok, false);
  // 80 * 1000 * 8% = $6,400 margin per contract -> 15 contracts ok, 16 blocked
  assert.equal(s.submit({ side: 'BUY', qty: 16 }).ok, false);
  assert.match(s.submit({ side: 'BUY', qty: 16 }).error, /margin/);
  assert.equal(s.submit({ side: 'BUY', qty: 15 }).ok, true);
  assert.equal(s.submit({ side: 'BUY', qty: 1 }).ok, false, 'adding beyond margin is blocked');
  assert.equal(s.submit({ side: 'SELL', qty: 5 }).ok, true, 'reducing is always allowed');
  close(marginFor(getInstrument('CL'), 1, { CL: 80 }), 6400);
});

test('headlines print as replay time passes and EIA auto-pauses', () => {
  const closes = Array.from({ length: 40 }, (_, i) => 80 + i * 0.01);
  const headlines = [
    { date: '2026-01-04', time: '16:00', type: 'HORMUZ', headline: 'overnight', products: [] },
    { date: '2026-01-05', time: '08:00', type: 'HORMUZ', headline: 'eight', products: ['CL'], pause: false },
    { date: '2026-01-05', time: '09:30', type: 'EIA', headline: 'EIA print', products: ['CL'], pause: true },
    { date: '2026-01-05', time: '09:00', type: 'EIA-NG', headline: 'NG only', products: ['NG'], pause: true },
  ];
  const s = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: makeDay(closes) }, headlines, prevDay: '2026-01-02' });
  const printed = () => s.tape.filter((t) => t.kind === 'headline').map((t) => t.text);
  assert.deepEqual(printed(), ['overnight']);
  let pause = null;
  while (!pause && !s.isLastBar) pause = s.step().pauseEvent;
  assert.equal(pause.headline, 'EIA print');
  assert.equal(s.clock(), '09:30', 'paused exactly when the print time hit, before the 09:30 bar is revealed');
  assert.deepEqual(printed(), ['overnight', 'eight', 'EIA print']);
});

test('report card: win rate, expectancy, drawdown, benchmarks', () => {
  const s = new Session({ day: '2026-01-05', instrumentId: 'CL', dayBars: { CL: makeDay([80, 81, 80, 79, 80]) } });
  s.submit({ side: 'BUY', qty: 1 });       // 80.02
  s.step();                                 // 81
  s.flatten();                              // sell 80.98 -> +960 gross
  s.submit({ side: 'SELL', qty: 1 });      // 80.98
  s.step();                                 // 80
  s.step();                                 // 79
  s.step();                                 // 80 (last bar)
  s.finish();                               // buy back 80.02 -> +960
  const c = reportCard(s);
  assert.equal(c.trades, 2);
  assert.equal(c.winRate, 1);
  // 4 fills x 1 contract x $4.50 = $18 in fees
  close(c.totalNet, 960 * 2 - 18, 1e-6);
  close(c.expectancy, (960 * 2 - 18) / 2, 1e-6);
  close(c.fees, 18);
  assert.equal(c.doNothing, 0);
  close(c.passiveLong.net, (79.98 - 80.02) * 1000 - 9, 1e-6);
  assert.ok(c.maxDrawdown >= 0);
  close(maxDrawdown([{ equity: 100 }, { equity: 120 }, { equity: 90 }, { equity: 130 }]), 30);
  const csv = tradesToCsv(s.account.trades, s.day, 2);
  assert.match(csv.split('\n')[0], /^date,entryTime,exitTime,product,side,size,entry,exit,gross,fees,net/);
  assert.equal(csv.trim().split('\n').length, 3);
});

// ------------------------------------------------------------------ no lookahead
test('NO LOOKAHEAD: indicators, quotes and the order book never use bars after the replay time', () => {
  const real = JSON.parse(readFileSync(new URL('../../data/CL.json', import.meta.url)));
  const day = Object.keys(real.days)[0];
  const bars = real.days[day];
  const K = 30;
  // a poisoned copy: every bar after K is garbage that would explode any calculation
  const poisoned = bars.map((b, i) => (i <= K ? b : { ...b, o: 1e9, h: 1e9, l: -1e9, c: 1e9 * (i % 2 ? 1 : -1), v: 1e12 }));

  const run = (dayBars) => {
    const s = new Session({ day, instrumentId: 'CL', dayBars: { CL: dayBars } });
    const mid = bars[5].c;
    s.submit({ side: 'BUY', type: 'LMT', qty: 1, price: mid - 0.3 });
    s.submit({ side: 'SELL', type: 'STP', qty: 1, price: mid - 0.6 });
    s.submit({ side: 'SELL', type: 'LMT', qty: 1, price: mid + 0.5 });
    for (let i = 0; i < K; i++) s.step();
    const seen = s.revealedBars();
    return {
      clock: s.clock(), n: seen.length, last: seen.at(-1),
      vwap: vwap(seen), ema9: ema(seen, 9), ema21: ema(seen, 21),
      quote: s.quote(), equity: s.equity(), position: s.account.position,
      orders: s.orders.map((o) => ({ id: o.id, status: o.status, fill: o.fillPrice ?? null })),
      tape: s.tape.map((t) => t.text), curve: s.equityCurve,
    };
  };
  const a = run(bars), b = run(poisoned);
  assert.equal(a.n, K + 1);
  assert.deepEqual(a, b, 'identical state whether or not future bars are poisoned');
  assert.ok(a.vwap.every(Number.isFinite) && a.ema21.every(Number.isFinite));

  // and the private store refuses direct reads beyond the cursor
  const s = new Session({ day, instrumentId: 'CL', dayBars: { CL: bars } });
  assert.equal(s.revealedBars().length, 1);
  assert.equal(Object.keys(s).some((k) => Array.isArray(s[k]) && s[k].length === bars.length && s[k][0] === bars[0]), false,
    'no public field holds the full day');
  assert.equal(JSON.stringify(s).includes(String(bars.at(-1).c) + ','), false);
});

test('NO LOOKAHEAD: indicator values at bar k depend only on bars 0..k', () => {
  const real = JSON.parse(readFileSync(new URL('../../data/BZ.json', import.meta.url)));
  const bars = Object.values(real.days).at(-1);
  const full = { v: vwap(bars), e9: ema(bars, 9), e21: ema(bars, 21) };
  for (const k of [0, 1, 10, 45, bars.length - 1]) {
    const pre = bars.slice(0, k + 1);
    close(vwap(pre).at(-1), full.v[k]);
    close(ema(pre, 9).at(-1), full.e9[k]);
    close(ema(pre, 21).at(-1), full.e21[k]);
  }
});

test('baked data: every product file has 10 days of real-looking 5m bars inside the session', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../data/manifest.json', import.meta.url)));
  for (const [sym, meta] of Object.entries(manifest.products)) {
    const d = JSON.parse(readFileSync(new URL(`../../data/${meta.file}`, import.meta.url)));
    assert.equal(Object.keys(d.days).length, 10, sym);
    for (const [day, bars] of Object.entries(d.days)) {
      for (const b of bars) {
        assert.ok(b.h >= Math.max(b.o, b.c) - 1e-9 && b.l <= Math.min(b.o, b.c) + 1e-9, `${sym} ${day} ${b.time} OHLC`);
        assert.ok(b.time >= '07:00' && b.time < '14:30');
      }
    }
  }
});
