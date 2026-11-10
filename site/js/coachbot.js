// WATCH THE COACH TRADE: a rule-based trader that trades the same day through the same
// execution engine (same spread, slippage, fees), one contract, deciding only on bars
// already revealed. Every decision gets a narration line written from the rule that fired.
//
// Signals (edit freely; these are this file's definitions):
//   A  Range break     first 5-minute close outside the 07:00-07:30 range. Enter with it.
//                      Stop at the range midpoint.
//   B  Failed extreme  price trades outside the range to a new session extreme, then closes
//                      back inside the range within 3 bars. Fade it. Stop beyond the extreme.
//   C  VWAP flip       after 08:30, a close across VWAP after 6+ closes on the other side,
//                      with EMA 9 on the same side of EMA 21. Enter with it. Stop half a
//                      morning range the other side of VWAP.
// Risk rules: one contract; no trade in the first 30 minutes; no new risk in the 10 minutes
// before a scheduled print or the 3 bars after it; at +2R the stop moves to entry; an opposite
// signal reverses; at most 3 entries and 2 stop-outs a day; no entries after 13:30; flat at 14:25.
import { Session, minutesOf } from './session.js';
import { vwap, ema } from './indicators.js';
import { roundTo } from './instruments.js';

export const BOT = { rangeBars: 6, failBars: 3, vwapSideBars: 6, vwapFrom: '08:30', lastEntry: '13:30', flatAt: '14:25',
  maxEntries: 3, maxStops: 2, noRiskBeforePrintMin: 10, barsAfterPrint: 3 };

export function runCoach({ day, instrumentId, dayBars, scheduled = [] }) {
  const s = new Session({ day, instrumentId, dayBars, headlines: [] });
  const tick = s.inst.tick;
  const px = (p) => s.fmtPx(p);
  const notes = [];
  const frames = [];
  const say = (text, kind = 'note') => notes.push({ clock: s.clock(), text: `${s.clock()}: ${text}`, kind });
  const prints = scheduled.filter((p) => p.time >= '07:05' && p.time < '14:30').sort((a, b) => (a.time < b.time ? -1 : 1));
  let range = null, entries = 0, stops = 0, done = false;
  let pos = null;   // { dir, entry, stop, R, signal, beMoved }
  let brokeUp = false, brokeDown = false, lastHourNote = '';

  const stopOrder = () => s.workingOrders().find((o) => o.type === 'STP');
  const enter = (dir, stop, signal, why) => {
    if (pos) { s.flatten('coach reverse'); }
    const side = dir > 0 ? 'BUY' : 'SELL';
    const r = s.submit({ side, type: 'MKT', qty: 1, bracket: { stop } });
    if (!r.ok) { say(`${why} Signal ${signal}, but the order was refused (${r.error}). No trade.`); pos = null; return; }
    const entry = r.order.fillPrice;
    pos = { dir, entry, stop: roundTo(stop, tick), R: Math.max(Math.abs(entry - stop), tick), signal, beMoved: false };
    entries += 1;
    say(`${why} ${dir > 0 ? 'Long' : 'Short'} 1 at ${px(entry)}. Stop ${px(pos.stop)}: ${px(pos.R)} of risk.`, 'entry');
  };

  frames.push({ clock: s.clock(), position: 0, entry: null, stop: null, equity: s.equity() });
  say('No trade in the first 30 minutes. Marking the morning range.');

  while (!s.isLastBar) {
    const hadPos = s.account.position;
    s.step();
    const clock = s.clock();
    const now = minutesOf(clock);
    const bars = s.revealedBars();
    const i = bars.length - 1;
    const b = bars[i];
    const vw = vwap(bars)[i], e9 = ema(bars, 9)[i], e21 = ema(bars, 21)[i];

    // stopped by the engine on this bar?
    if (pos && hadPos !== 0 && s.account.position === 0) {
      const t = s.account.trades.at(-1);
      const r = ((t.exit - t.entry) * pos.dir) / pos.R;
      stops += 1;
      say(`Stopped at ${px(t.exit)} (${r >= 0 ? '+' : ''}${r.toFixed(1)}R). ${pos.beMoved ? 'Breakeven stop did its job.' : 'The level said the idea was wrong. No argument.'}`, 'exit');
      pos = null;
      if (stops >= BOT.maxStops) { done = true; say('Two stops. Done for the day: the tape is not paying this playbook.'); }
    }

    if (i === BOT.rangeBars - 1) {
      const rb = bars.slice(0, BOT.rangeBars);
      range = { hi: Math.max(...rb.map((x) => x.h)), lo: Math.min(...rb.map((x) => x.l)) };
      range.mid = roundTo((range.hi + range.lo) / 2, tick);
      range.width = range.hi - range.lo;
      say(`Morning range ${px(range.lo)} to ${px(range.hi)}. Plan: trade the first close outside it; fade a break that fails.`);
    }

    if (clock >= BOT.flatAt) {
      if (pos) {
        s.flatten('coach close');
        const t = s.account.trades.at(-1);
        say(`Flat at ${px(t.exit)} into the close (${(((t.exit - t.entry) * pos.dir) / pos.R).toFixed(1)}R). Nothing carries overnight in this playbook.`, 'exit');
        pos = null;
      }
      frames.push({ clock, position: 0, entry: null, stop: null, equity: s.equity() });
      continue;
    }

    const nextPrint = prints.find((p) => minutesOf(p.time) > now - 1);
    const minsToPrint = nextPrint ? minutesOf(nextPrint.time) - now : Infinity;
    const lastPrint = [...prints].reverse().find((p) => minutesOf(p.time) <= now);
    const barsSincePrint = lastPrint ? (now - minutesOf(lastPrint.time)) / 5 : Infinity;
    const blocked = minsToPrint > 0 && minsToPrint <= BOT.noRiskBeforePrintMin ? `${nextPrint.type} in ${minsToPrint} minutes. No new risk into a print.`
      : barsSincePrint < BOT.barsAfterPrint ? `${lastPrint.type} just printed. Waiting ${BOT.barsAfterPrint} bars to see if the first move holds.` : '';
    if (prints.some((p) => p.time === clock)) say(`${prints.find((p) => p.time === clock).type} print. ${pos ? `Position was on before it; the stop at ${px(pos.stop)} is the plan.` : 'Flat into it by design.'} Judge the first move after ${BOT.barsAfterPrint} bars.`);

    // manage an open position
    if (pos) {
      const fav = (b.c - pos.entry) * pos.dir;
      if (!pos.beMoved && fav >= 2 * pos.R) {
        const o = stopOrder();
        if (o) s.cancel(o.id);
        s.submit({ side: pos.dir > 0 ? 'SELL' : 'BUY', type: 'STP', qty: 1, price: pos.entry });
        pos.stop = pos.entry; pos.beMoved = true;
        say(`+2R at ${px(b.c)}. Stop to entry ${px(pos.entry)}. The trade is free; let it work.`, 'manage');
      }
    }

    // signals (need the range; respect the risk rules)
    let sig = null;
    if (range && !done && i >= BOT.rangeBars) {
      const recent = bars.slice(Math.max(BOT.rangeBars, i - BOT.failBars), i);       // the 3 bars before this one
      const sessHi = Math.max(...bars.slice(0, i).map((x) => x.h)), sessLo = Math.min(...bars.slice(0, i).map((x) => x.l));
      const spikedUp = recent.some((x) => x.h > range.hi && x.h >= sessHi) || (b.h > range.hi && b.h >= sessHi);
      const spikedDn = recent.some((x) => x.l < range.lo && x.l <= sessLo) || (b.l < range.lo && b.l <= sessLo);
      const prev = bars[i - 1];
      const inside = b.c <= range.hi && b.c >= range.lo;
      if (spikedUp && inside && prev.c > range.hi && b.c < b.o) {
        const ext = Math.max(b.h, ...recent.map((x) => x.h));
        sig = { dir: -1, stop: ext + tick, signal: 'B', why: `First close back inside the morning range after a failed spike to ${px(ext)}.` };
      } else if (spikedDn && inside && prev.c < range.lo && b.c > b.o) {
        const ext = Math.min(b.l, ...recent.map((x) => x.l));
        sig = { dir: 1, stop: ext - tick, signal: 'B', why: `First close back inside the morning range after a failed flush to ${px(ext)}.` };
      } else if (b.c > range.hi && !brokeUp) {
        sig = { dir: 1, stop: range.mid, signal: 'A', why: `First close above the morning range (${px(range.hi)}).` };
      } else if (b.c < range.lo && !brokeDown) {
        sig = { dir: -1, stop: range.mid, signal: 'A', why: `First close below the morning range (${px(range.lo)}).` };
      } else if (clock > BOT.vwapFrom && i >= BOT.vwapSideBars + 1) {
        const vws = vwap(bars);
        const before = bars.slice(i - BOT.vwapSideBars, i).map((x, k) => x.c - vws[i - BOT.vwapSideBars + k]);
        if (b.c > vw && e9 > e21 && before.every((d) => d < 0)) sig = { dir: 1, stop: vw - range.width / 2, signal: 'C', why: `Close back above VWAP (${px(vw)}) after ${BOT.vwapSideBars} bars below it, EMA 9 over 21.` };
        else if (b.c < vw && e9 < e21 && before.every((d) => d > 0)) sig = { dir: -1, stop: vw + range.width / 2, signal: 'C', why: `Close back below VWAP (${px(vw)}) after ${BOT.vwapSideBars} bars above it, EMA 9 under 21.` };
      }
      if (b.c > range.hi) brokeUp = true;
      if (b.c < range.lo) brokeDown = true;
    }

    if (sig) {
      const label = `Signal ${sig.signal}.`;
      if (pos && pos.dir === sig.dir) say(`${sig.why} ${label} Already ${pos.dir > 0 ? 'long' : 'short'} from ${px(pos.entry)}; it confirms the position, it does not add to it.`);
      else if (blocked) say(`${sig.why} ${label} ${blocked} Pass.`, 'pass');
      else if (clock > BOT.lastEntry) say(`${sig.why} ${label} Too late in the day to start a new idea. Pass.`, 'pass');
      else if (entries >= BOT.maxEntries) say(`${sig.why} ${label} Three entries already. Pass.`, 'pass');
      else enter(sig.dir, sig.stop, sig.signal, `${sig.why} ${label}${pos ? ' Opposite signal: reverse.' : ''}`);
    } else if (clock.endsWith(':00') && clock !== lastHourNote && range) {
      lastHourNote = clock;
      if (pos) {
        const r = ((b.c - pos.entry) * pos.dir) / pos.R;
        say(`${pos.dir > 0 ? 'Long' : 'Short'} from ${px(pos.entry)}, stop ${px(pos.stop)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}R. No exit signal. Holding is the trade.`, 'hold');
      } else if (!done) say(`Price ${px(b.c)}, VWAP ${px(vw)}. No signal. Flat is a position.`, 'hold');
    }

    frames.push({ clock, position: s.account.position, entry: pos?.entry ?? null, stop: pos?.stop ?? null, equity: s.equity() });
  }
  s.finish();
  const net = s.equity() - s.account.startingCash;
  notes.push({ clock: s.clock(), kind: 'summary', text: `${s.clock()}: Day done. ${s.account.trades.length} trade${s.account.trades.length === 1 ? "" : "s"}, ${net >= 0 ? '+' : '-'}$${Math.abs(net).toFixed(0)} after fees. The rules were followed; that is the part you can repeat.` });
  return { notes, frames, trades: s.account.trades, fills: s.account.fills, net, bars: s.revealedBars() };
}
