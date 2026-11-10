# BEST TRADE SPEC

How REPLAY DESK computes the **best realistic trade** for a session: the trade the coach takes in
*Watch the coach trade* and the "Best realistic" line on the report card.

> Provenance. This file did not exist in the repository before the VIEW amendment. The signal
> definitions (A, B, C), the stall rule and the print blackout below are the ones implemented in
> `site/js/coachbot.js`; they were written when the coach replay was built, without access to an
> earlier spec. If your own spec defines them differently, edit this file and the constants in
> `BOT` (coachbot.js) and `VIEW` (view.js). The two-layer model in sections 1 and 2 is the amendment.

It is a two-layer model: **VIEW, then TRIGGER**. Everything is real time only: at any bar the
engine has seen only the bars and headlines already revealed (a test poisons the future and
checks nothing changes).

## 1. Layer 1: THE VIEW (fundamentals)

**Inputs.** Every real entry in `data/headlines.json` has:

- `bias`: -1, 0 or +1. Direction for the products the entry is tagged with (crude and products
  for most; `bias_by_product` overrides per product, e.g. the Nov 9 natural gas item).
- `weight`: 1 to 3. 3 = regime driver (a verified attack, a deal report with named parties, an
  election repricing). 2 = a scheduled print surprise or a confirmed development. 1 = color.

Red herrings (`class: "noise"`) have `bias: 0` and are ignored by the view even if a bias is
edited onto them. The coach's view is never set by a herring.

**Scheduled prints score against consensus, not zero.** EIA, API, gas storage and macro prints
carry a `consensus` note (also shown per event in the `data/coach.json` briefing). A print gets a
non-zero bias only if it surprises; an in-line print, or one with no recorded consensus or
figures, is bias 0 and changes nothing.

**Running view.** At any bar: the sign of the weighted sum of `bias x weight` over the events
printed so far today, starting from the overnight items at the open (everything since the prior
14:30 close). `|sum| <= 1` is NEUTRAL (`VIEW.neutralBand`); above is LONG, below is SHORT.

**Thesis hierarchy.** A single scheduled print (weight below 3) cannot flip a view set by a
weight-3 regime driver. When such a print lands against the view it is *held back*, not netted.
It is accepted only if price then closes beyond the pre-print level, in the print's direction,
for 3 consecutive bars (`VIEW.holdBars`): the market itself overruled the hierarchy. On
acceptance the opposing weight-3 drivers are marked overruled and the print sets the view.
Unscheduled developments net normally. (Nov 4: bullish EIA, view stays SHORT.)

**Display.** The Coach Replay shows a bias meter (LONG / SHORT / NEUTRAL and the sum) with the
events that set it, held-back prints, and overruled drivers.

## 2. Layer 2: THE TRIGGER (price signals, gated by the view)

Signals, on 5-minute bars:

- **A, Range break.** First close outside the 07:00 to 07:30 range. Stop: the range midpoint.
- **B, Failed extreme.** A new session extreme outside the range that closes back inside the
  range within 3 bars. Fade the extreme. Stop: one tick beyond it.
- **C, VWAP flip.** After 08:30, a close across VWAP after 6 consecutive closes on the other
  side, with EMA 9 on the same side of EMA 21. Stop: half a morning range beyond VWAP.

**Gate.**

- A signal counts only if its direction agrees with the current view.
- Exception, the exhausted-move fade: a signal against the view counts if it is **A plus C**
  (both a range break and a VWAP flip have fired in the fade direction; the later one is the
  entry) and the move has already travelled at least 2 times the entry's stop distance from the
  price at the view's last supporting event, with no new supporting event since.
- If the view is NEUTRAL there is no trade. A day that opens neutral becomes tradable only if a
  weight-3 event lands mid-session.

**Trade rules.**

- 10 contracts (`COACH_CONTRACTS`; the largest size the margin estimate allows where 10 does not fit), one trade per session: the first valid setup in time order.
- No trade in the first 30 minutes (the range is being formed).
- No new risk in the 10 minutes before a scheduled print or the 3 bars after it; no entries
  after 13:30.
- Exits: the stop; the stall rule (6 bars with no new favourable closing extreme, exit at
  market); flat at 14:30.
- Execution is the simulator's own: bid/ask spread, 1 tick of slippage on market and stop fills,
  $4.50 per contract per side.

## 3. Results on the baked data (CL, 10 contracts, after costs)

R = net profit divided by the initial stop risk in dollars (contracts x stop distance x 1,000).

| Day | View at open | Trade | Entry | Exit | Risk | $ at 10 lots | $/bbl | R |
|---|---|---|---|---|---|---|---|---|
| 2026-10-27 | SHORT | short, B | 07:50 @ 100.99 | 08:05 @ 101.38 (stop) | $3,800 | -$3,990 | -0.399 | -1.05 |
| 2026-10-28 | LONG | long, A | 07:45 @ 102.00 | 08:10 @ 101.70 (stop) | $2,900 | -$3,090 | -0.309 | -1.07 |
| 2026-10-29 | SHORT | short, C | 09:35 @ 100.61 | 10:40 @ 100.38 (stall) | $2,900 | +$2,210 | +0.221 | +0.76 |
| 2026-10-30 | LONG | long, B | 08:50 @ 103.98 | 09:40 @ 104.21 (stall) | $3,400 | +$2,210 | +0.221 | +0.65 |
| 2026-11-02 | SHORT | short, A | 07:40 @ 97.65 | 09:40 @ 97.36 (stall) | $19,100 | +$2,810 | +0.281 | +0.15 |
| 2026-11-03 | SHORT | short, A | 07:35 @ 94.06 | 08:05 @ 95.19 (stall) | $24,600 | -$11,390 | -1.139 | -0.46 |
| 2026-11-04 | SHORT | short, A | 07:40 @ 93.65 | 08:45 @ 93.34 (stall) | $6,400 | +$3,010 | +0.301 | +0.47 |
| 2026-11-05 | LONG | long, B | 07:55 @ 89.29 | 09:15 @ 89.96 (stall) | $2,600 | +$6,610 | +0.661 | +2.54 |
| 2026-11-06 | NEUTRAL | none | | | | $0 | | |
| 2026-11-09 | NEUTRAL, SHORT from 09:00 | short, C | 13:05 @ 87.49 | 14:10 @ 86.12 (stall) | $4,100 | +$13,610 | +1.361 | +3.32 |

Total +$11,990. Regenerate with the `view.test.js` diagnostics or the Coach Replay.

## 4. Acceptance tests (`test/replay/view.test.js`)

1. **2026-10-29 CL, diplomacy fade.** The view is SHORT from the open (Vance letter -3, then hot
   PCE -2) on every bar until the 12:00 pushback. Best realistic: short 100.61 at 09:35 on
   Signal C, out 100.38 at 10:40 on the stall rule (+$2,210 at 10 lots, +$0.221/bbl, +0.76R). The reference was short about 100.90, exit
   about 99.45. The entry is within 0.30 of the reference. The exit is not reachable: on this
   day's bars CL never traded below 99.79 in the 07:00 to 14:30 session, and not below 100.02
   after the entry. (A 100.90 to 99.45 short does exist on 2026-10-27, whose session low is 99.44.)
2. **2026-10-30 CL, verified attack.** The view is LONG on every bar. A Signal A short fires at
   08:45 and is refused; the trade is a long on Signal B at 08:50 (+$2,210 at 10 lots, +$0.221/bbl, +0.65R). No short entry is ever sent.
