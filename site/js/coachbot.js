// BEST REALISTIC trader for WATCH THE COACH TRADE. Two layers (BEST_TRADE_SPEC.md):
//   LAYER 1  THE VIEW     running fundamental bias from real headlines already printed (view.js)
//   LAYER 2  THE TRIGGER  price signals A/B/C, taken only when the view allows them
// It trades the same day through the same execution engine (same spread, slippage, fees),
// COACH_CONTRACTS contracts (10), one trade a session, deciding only on bars and headlines already revealed.
//
// Signals:
//   A  Range break     first 5-minute close outside the 07:00-07:30 range. Stop: range midpoint.
//   B  Failed extreme  a new session extreme outside the range that closes back inside within
//                      3 bars. Fade the extreme. Stop: one tick beyond it.
//   C  VWAP flip       after 08:30, a close across VWAP after 6 closes on the other side, with
//                      EMA 9 on the same side of EMA 21. Stop: half a morning range beyond VWAP.
// Gate: a signal counts only if it agrees with the view, or it is an A plus C fade of an
// exhausted move. A neutral view means no trade unless a weight-3 event lands mid-session.
// Exits: the stop; the stall rule (6 bars with no new favourable closing extreme); flat at 14:30.
import { Session, minutesOf } from './session.js';
import { vwap, ema } from './indicators.js';
import { roundTo } from './instruments.js';
import { View, viewLabel } from './view.js';
import { COACH_CONTRACTS, PRODUCTS } from './config.js';

export const BOT = { rangeBars: 6, failBars: 3, vwapSideBars: 6, vwapFrom: '08:30', lastEntry: '13:30', stallBars: 6,
  exhaustedMultiple: 2, noRiskBeforePrintMin: 10, barsAfterPrint: 3 };

const short = (t, n = 70) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function runCoach({ day, instrumentId, dayBars, headlines = [], prevDay = null }) {
  const s = new Session({ day, instrumentId, dayBars, headlines, prevDay });
  const tick = s.inst.tick;
  const px = (p) => s.fmtPx(p);
  const view = new View({ legs: s.inst.legs.map((l) => l.product) });
  const notes = [], frames = [];
  const say = (text, kind = 'note') => notes.push({ clock: s.clock(), text: `${s.clock()}: ${text}`, kind });
  const prints = s.headlines.filter((h) => h.date === day && h.time_precision === 'exact' && h.time >= '07:05' && h.time < '14:30')
    .map((h) => ({ time: h.time, type: h.type }));
  const frame = () => frames.push({ clock: s.clock(), position: s.account.position, entry: pos?.entry ?? null, stop: pos?.stop ?? null,
    equity: s.equity(), view: view.snapshot() });

  const unit = PRODUCTS[s.inst.legs[0].product].unit;
  const usd = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const three = (t) => `${t.net >= 0 ? '+' : ''}${usd(t.net)} at ${t.contracts} lots, ${t.perUnit >= 0 ? '+' : '-'}$${Math.abs(t.perUnit).toFixed(Math.min(4, s.inst.decimals + 1))}/${unit}, ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`;
  let range = null, pos = null, traded = false, trade = null, regimeMid = false, lastHourNote = '';
  let brokeUp = false, brokeDown = false;
  const fired = { A: { 1: -1, [-1]: -1 }, C: { 1: -1, [-1]: -1 } };   // bar index each signal last fired, per direction
  let seen = 0;

  // ---- Layer 1 bookkeeping: read whatever the tape has printed since last time
  const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
  const ingest = (price, bar, atOpen) => {
    const before = view.label;
    let added = 0;
    for (; seen < s.tape.length; seen++) {
      const t = s.tape[seen];
      if (t.kind !== 'headline') continue;
      const r = view.add(t, price, bar);
      if (r.status === 'ignored') continue;
      const e = r.event;
      const tag = signed(e.bias * e.weight);
      if (r.status === 'pending') {
        say(`${e.type} print reads ${e.bias > 0 ? 'bullish' : 'bearish'} against consensus (${tag}), but the view is ${before} on a weight-3 driver. One print does not flip it. It counts only if price holds ${e.bias > 0 ? 'above' : 'below'} ${px(e.px)} for ${view.holdBars} bars.`, 'view');
      } else {
        added += 1;
        if (!atOpen && e.weight === 3) regimeMid = true;
        if (!atOpen) say(`${tag}: "${short(e.headline)}"`, 'view');
      }
    }
    if (added && !atOpen) say(before === view.label ? `View stays ${view.label} (${signed(view.sum)}).` : `View ${before} to ${view.label} (${signed(view.sum)}).`, 'view');
  };

  const openPx = s.revealedBars()[0].o;
  ingest(openPx, 0, true);
  const openDir = view.dir;
  const setBy = view.events.map((e) => `${e.bias > 0 ? '+' : '-'}${e.weight} "${short(e.headline, 48)}"`).join('; ');
  say(`View at the open: ${view.label} (${view.sum > 0 ? '+' : ''}${view.sum}). ${setBy ? `Set by ${setBy}.` : 'Nothing overnight moves it.'}`, 'view');
  say(view.dir === 0 ? 'No view, no trade, unless a weight-3 event lands. Marking the morning range anyway.' : `Only ${view.dir > 0 ? 'long' : 'short'} setups count. No trade in the first 30 minutes; marking the morning range.`);
  frame();

  const closeOut = (reason, text) => {
    const t = s.account.trades.at(-1);
    const r = ((t.exit - t.entry) * pos.dir) / pos.R;
    // the three numbers: dollars at size, dollars per unit, and R (profit / initial stop risk in dollars)
    trade = { ...trade, exit: t.exit, exitClock: s.clock(), exitReason: reason, net: t.net, gross: t.gross, fees: t.fees,
      perUnit: t.net / (trade.contracts * s.inst.multiplier), r: t.net / trade.riskDollars, priceR: r };
    say(`${text(t, r)} ${three(trade)}. One trade a session: done for the day.`, 'exit');
    pos = null; traded = true;
  };

  while (!s.isLastBar) {
    const hadPos = s.account.position;
    s.step();
    const clock = s.clock();
    const now = minutesOf(clock);
    const bars = s.revealedBars();
    const i = bars.length - 1;
    const b = bars[i];
    const vws = vwap(bars);
    const vw = vws[i], e9 = ema(bars, 9)[i], e21 = ema(bars, 21)[i];

    // Layer 1: held-back prints first (this bar's close), then anything that just printed
    for (const e of view.onBar(b.c, i)) say(`Price held ${e.bias > 0 ? 'above' : 'below'} the pre-print ${px(e.px)} for ${view.holdBars} bars. The market overruled the hierarchy: view is now ${view.label} (${view.sum > 0 ? '+' : ''}${view.sum}).`, 'view');
    ingest(b.c, i, false);

    if (pos && hadPos !== 0 && s.account.position === 0) {
      closeOut('stop', (t, r) => `Stopped at ${px(t.exit)} (${r >= 0 ? '+' : ''}${r.toFixed(1)}R). The level said the idea was wrong. No argument.`);
    }

    if (i === BOT.rangeBars - 1) {
      const rb = bars.slice(0, BOT.rangeBars);
      range = { hi: Math.max(...rb.map((x) => x.h)), lo: Math.min(...rb.map((x) => x.l)) };
      range.mid = roundTo((range.hi + range.lo) / 2, tick);
      range.width = range.hi - range.lo;
      say(`Morning range ${px(range.lo)} to ${px(range.hi)}.`);
    }

    // manage the open trade: stall rule
    if (pos) {
      const better = pos.dir > 0 ? b.c > pos.bestClose : b.c < pos.bestClose;
      if (better) { pos.bestClose = b.c; pos.sinceBest = 0; } else pos.sinceBest += 1;
      if (pos.sinceBest >= BOT.stallBars && !s.isLastBar) {
        s.flatten('coach stall');
        closeOut('stall', (t, r) => `${BOT.stallBars} bars without a new ${pos.dir > 0 ? 'high' : 'low'} close since ${px(pos.bestClose)}. The move stalled: out at ${px(t.exit)} (${r >= 0 ? '+' : ''}${r.toFixed(1)}R).`);
      }
    }

    const nextPrint = prints.find((p) => minutesOf(p.time) > now);
    const minsToPrint = nextPrint ? minutesOf(nextPrint.time) - now : Infinity;
    const lastPrint = [...prints].reverse().find((p) => minutesOf(p.time) <= now);
    const barsSincePrint = lastPrint ? (now - minutesOf(lastPrint.time)) / 5 : Infinity;
    const blocked = minsToPrint <= BOT.noRiskBeforePrintMin ? `${nextPrint.type} in ${minsToPrint} minutes. No new risk into a print.`
      : barsSincePrint < BOT.barsAfterPrint ? `${lastPrint.type} just printed. Waiting ${BOT.barsAfterPrint} bars to see if the first move holds.` : '';

    // Layer 2: price signals on this bar
    let sig = null;
    if (range && i >= BOT.rangeBars) {
      const recent = bars.slice(Math.max(BOT.rangeBars, i - BOT.failBars), i);
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
        const before = bars.slice(i - BOT.vwapSideBars, i).map((x, k) => x.c - vws[i - BOT.vwapSideBars + k]);
        if (b.c > vw && e9 > e21 && before.every((d) => d < 0)) sig = { dir: 1, stop: roundTo(vw - range.width / 2, tick), signal: 'C', why: `Close back above VWAP (${px(vw)}) after ${BOT.vwapSideBars} bars below it, EMA 9 over 21.` };
        else if (b.c < vw && e9 < e21 && before.every((d) => d > 0)) sig = { dir: -1, stop: roundTo(vw + range.width / 2, tick), signal: 'C', why: `Close back below VWAP (${px(vw)}) after ${BOT.vwapSideBars} bars above it, EMA 9 under 21.` };
      }
      if (b.c > range.hi) brokeUp = true;
      if (b.c < range.lo) brokeDown = true;
      if (sig && (sig.signal === 'A' || sig.signal === 'C')) fired[sig.signal][sig.dir] = i;
    }

    if (sig && !pos && !traded) {
      const v = view.dir;
      const tradable = v !== 0 && (openDir !== 0 || regimeMid);
      const label = `Signal ${sig.signal}.`;
      const side = sig.dir > 0 ? 'long' : 'short';
      let take = false, how = '';
      if (!tradable) {
        say(`${sig.why} ${label} The view is ${v === 0 ? 'NEUTRAL' : `${viewLabel(v)} but no regime driver has landed today`}. No view, no trade.`, 'pass');
      } else if (sig.dir === v) {
        take = true; how = `${label} It agrees with the ${viewLabel(v)} view.`;
      } else {
        // fade of an exhausted move: needs both A and C in the fade direction
        const both = sig.signal !== 'B' && fired.A[sig.dir] >= 0 && fired.C[sig.dir] >= 0;
        const ls = view.lastSupport();
        const since = bars.slice(ls ? ls.bar : 0);
        const travel = ls ? (v > 0 ? Math.max(...since.map((x) => x.h)) - ls.px : ls.px - Math.min(...since.map((x) => x.l))) : 0;
        const stopDist = Math.abs(b.c - sig.stop);
        if (both && travel >= BOT.exhaustedMultiple * stopDist) {
          take = true; sig.signal = 'A+C';
          how = `Signal A plus C against the ${viewLabel(v)} view. The move ran ${px(travel)} from ${px(ls.px)} with no new supporting event: exhausted. Fade it.`;
        } else {
          say(`${sig.why} ${label} A ${side} against a ${viewLabel(v)} view${both ? `, and the move has only run ${px(travel)} (needs ${px(BOT.exhaustedMultiple * stopDist)})` : ''}. Not taken.`, 'pass');
        }
      }
      if (take && blocked) { say(`${sig.why} ${how} ${blocked} Pass.`, 'pass'); take = false; }
      if (take && clock > BOT.lastEntry) { say(`${sig.why} ${how} Too late in the day to start a new idea. Pass.`, 'pass'); take = false; }
      if (take) {
        const side = sig.dir > 0 ? 'BUY' : 'SELL';
        let qty = COACH_CONTRACTS;
        while (qty > 1 && !s.account.checkMargin(side, qty, s.mark(), s.lastByProduct()).ok) qty -= 1;
        const r = s.submit({ side, type: 'MKT', qty, bracket: { stop: sig.stop } });
        if (!r.ok) say(`${sig.why} ${how} Order refused (${r.error}). No trade.`, 'pass');
        else {
          const entry = r.order.fillPrice;
          pos = { dir: sig.dir, entry, stop: roundTo(sig.stop, tick), R: Math.max(Math.abs(entry - sig.stop), tick), signal: sig.signal, bestClose: b.c, sinceBest: 0 };
          // risk per trade = contracts x stop distance x contract multiplier, measured at entry
          trade = { side: sig.dir > 0 ? 'LONG' : 'SHORT', signal: sig.signal, entry, entryClock: clock, stop: pos.stop, view: viewLabel(v),
            contracts: qty, unit, riskDollars: qty * pos.R * s.inst.multiplier };
          say(`${sig.why} ${how} ${sig.dir > 0 ? 'Long' : 'Short'} ${qty} at ${px(entry)}. Stop ${px(pos.stop)}: ${px(pos.R)} per ${unit}, ${usd(trade.riskDollars)} of risk.${qty < COACH_CONTRACTS ? ` (${COACH_CONTRACTS} lots would exceed the account's margin; ${qty} fits.)` : ''}`, 'entry');
        }
      }
    } else if (clock.endsWith(':00') && clock !== lastHourNote && range && !traded) {
      lastHourNote = clock;
      if (pos) {
        const r = ((b.c - pos.entry) * pos.dir) / pos.R;
        say(`${pos.dir > 0 ? 'Long' : 'Short'} ${trade.contracts} from ${px(pos.entry)}, stop ${px(pos.stop)}, ${r >= 0 ? '+' : ''}${r.toFixed(1)}R. View still ${view.label}, no stall yet. Holding is the trade.`, 'hold');
      } else say(`Price ${px(b.c)}, VWAP ${px(vw)}, view ${view.label}. No valid setup. Flat is a position.`, 'hold');
    }
    frame();
  }
  if (pos) {
    s.finish();
    closeOut('close', (t, r) => `Flat at ${px(t.exit)} at 14:30 (${r >= 0 ? '+' : ''}${r.toFixed(1)}R). Nothing carries overnight.`);
  } else s.finish();
  frames[frames.length - 1].position = 0;
  frames[frames.length - 1].equity = s.equity();
  const net = s.equity() - s.account.startingCash;
  notes.push({ clock: s.clock(), kind: 'summary', text: `${s.clock()}: ${trade ? `Day done. One ${trade.side.toLowerCase()} on Signal ${trade.signal}: ${px(trade.entry)} to ${px(trade.exit)}. ${three(trade)}, after fees.` : `No trade today. ${openDir === 0 && !regimeMid ? 'The view was neutral.' : 'No setup agreed with the view.'} That is a result, not a failure.`}` });
  return { three: trade ? three(trade) : null, notes, frames, trade, trades: s.account.trades, fills: s.account.fills, net, bars: s.revealedBars(),
    openView: viewLabel(openDir), finalView: view.label, view: view.snapshot() };
}
