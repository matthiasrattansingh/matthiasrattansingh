# TAPE

A phone-first trading game for learning crude oil and refined products. Each TRADE session is a
famous oil-market day replayed candle by candle: you hold a live position while the chart draws
itself, and the market never waits for you.

```bash
cd tape
npm install
npm run dev        # open the printed URL; on your phone use the "Network" URL on the same Wi-Fi
```

No backend and no API keys. Progress lives in your browser's `localStorage`. Add
`?session=<id>` to the URL to open a specific session (e.g. `?session=ci-wti-negative-2020`).

## TRADE (the core loop)

- **A session = one famous day** (40 scenarios) or a spread move (10 sessions: Brent−WTI, diesel
  and gasoline cracks, 3-2-1, diesel vs gasoline). 12-16 candles per scenario, 8 per spread.
- **The chart animates**: each candle draws itself over 2 seconds (canvas, 60fps) with your dashed
  entry line and the live price. Your P&L and equity tick every frame.
- **You start flat**: pick a size (1/2/5 lots), then LONG / SHORT / SELL VOL (or WAIT). After that,
  each candle is a decision: HOLD / ADD 1 / CUT ½ / CLOSE. Swipe up = HOLD.
- **8-second decision timer** after every candle; if it runs out you HOLD and the next candle starts.
- **Breaking news** drops in between candles (one line; your phone buzzes on major ones).
- **Margin bar** under your equity turns amber, then pulses red; at zero you're margin-called
  mid-session (💀, refilled to $100k, permanent record).
- **Every candle close flashes its P&L**, and a strip shows the four bots' session P&L live.
- **Debrief**: decision grid (🟩 made money · 🟥 lost · 🟦 flat), equity curve with your best and
  worst decisions (valued by replaying the session without them), max drawdown, buy-and-hold
  LONG/SHORT benchmarks, the desk's results, the 2-line "why it moved", and one concept question
  tied to that day ($2,500 if right). Share it like OPEN BELL.
- Optional sounds (tick on close, thud on a >$2k losing candle) are off by default: ME tab.

**Where the candles come from**: real daily open/high/low/close for the front-month NYMEX WTI, ICE
Brent, NYMEX ULSD and RBOB contracts. Intraday history isn't freely available, so one-day scenarios
split the real day into candles with a simulated path that hits the real open, high, low and close,
and say so on screen ("path simulated, OHLC real"). Longer scenarios use real daily (or merged
multi-day) candles. Spread sessions are built from real daily settlements. Breaking-news timing
within a day is approximate. Regenerate with `python3 scripts/build-sessions.py` (downloads the
OHLC once); hand-written fields (`open`, `news`, `concept`) are kept.

### Adding a session

Add a CALL IT card to `callit.json` (format below), then run `python3 scripts/build-sessions.py <id>`
and add to its `session` block: `"open"` (≤ 44 chars), `"news"`: `[{ "day": "YYYY-MM-DD" or "at": candleIndex,
"text": "≤ 40 chars", "major": true }]` and `"concept"` (a concept id). Run `npm run validate`.

## Between sessions (the gamification layer)

None of this touches the trading screen except the bot strip and your RIDE balance.

- **Autoplay**: the debrief shows the next session with its first candle already moving behind a
  5-second ring (it starts once you've answered the concept). NEXT starts now, STOP pauses.
  Order: today's event special, then unplayed sessions, then your lowest grades, then the review queue.
- **RIDE**: after a winning session, RIDE moves its profit into a separate ride balance that counts
  as bonus margin and adds one lot per $10k to your largest size. A losing session pays from the
  ride first and forfeits the rest. It survives restarts; cash it out any time in ME.
- **Daily quests + rings**: three quests a day (win a spread session · max drawdown under $5,000 ·
  beat a named bot · earn $X in one session · no margin warning), $1,000 + 40 XP each. Rings for
  OPEN BELL / 3 sessions / quests show on DESK and between sessions.
- **Weekly league** (DESK → LEAGUE): you and 29 bots, XP earned Monday-Sunday. Top 10 promote, bottom
  5 drop through Bronze → Silver → Gold → Diamond; results land in ME. Bot XP is simulated
  (seeded daily totals, weekday-heavy, a few binge late Sunday). Joining mid-week starts everyone at zero.
- **LIBRARY** (ME): all 50 sessions as collectible cards graded S/A/B/C/D against holding the right
  side at 5 lots all session (S ≥ 90%, A ≥ 70%, B ≥ 45%, C any profit, D a loss). Tap to trade one.
  Replays draw your best run as a faint ghost line with "vs your best run" at each candle.
- **EVAL** (ME): a 30-day prop-firm evaluation on a $100k sub-account: +$20k target, 8% trailing
  drawdown from peak equity (counted intra-session) ends it instantly. TRADE routes to it while
  active. Pass = FUNDED: 10- and 25-lot sizes for good.
- **Desk chat**: Mo, Carla, Quinn and Dan post in character about your results, theirs, streaks and
  league moves. At most once a day one throws down a grudge challenge on a named session; ACCEPT
  jumps straight into it, and beating their number doubles that session's XP.
- **Event specials**: `src/data/events.json` holds the calendar: EIA petroleum report Wednesdays,
  EIA gas storage Thursdays, and OPEC+ meeting dates you add by hand. On an event day one special
  session (drawn from the matching scenarios) unlocks for that day only (+50 XP). Missed ones show
  greyed in the Library.

Progress is one localStorage save (`tape.progress.v1` key, `version: 2`); older saves migrate
automatically. `npm test` runs the session-engine and game-layer tests.

## The game

- **Play-money account**: you start with $100,000. One lot = 1,000 bbl, like the real contracts, so a
  $1/bbl move is $1,000 per lot. SELL VOL means selling volatility: you earn the flat band as time
  passes (theta) and pay for any distance price moves from your entry.
- **Win streaks pay**: 2 winning trades in a row ×1.25, 3 ×1.5, 5+ ×2 on winning P&L. Correct
  concept answers (debriefs and the bell warm-up) pay a $2,500 research bonus and keep the streak alive.
  Losing sessions return later through the miss queue (about 1 in 5 sessions).
- **Margin call**: if a trade takes the account to $0 or below, you're refilled to $100,000 and it
  counts as a blow-up on your record.
- **The desk**: four rival bots trade every session with you: Momentum Mo (rides the last few
  candles), Contrarian Carla (fades them), Quant Quinn (~60% right on direction) and Degen Dan (coin
  flip, 5 lots, adds after every losing candle). The DESK tab ranks today's P&L and all-time value.
- **OPEN BELL** (BELL tab): the daily challenge. A warm-up concept question, then the same session
  for everyone that day squeezed into 5 candles = 5 trades, one shot (leaving mid-bell forfeits it),
  then a shareable result (🟩🟥 grid + P&L).
- Play money only. There's no real-money wagering or prizes: that would be regulated gambling or
  futures trading.

## Scoring (XP and accuracy)

- **CALL IT**: a right call earns `10 × conviction × size`, where size runs from 1.0× to 4.0× with the
  $/bbl move (product moves are converted at 42 gal/bbl). A wrong call loses `5 × conviction × size`.
  FLAT is right when the move stays inside the card's `flatBandPct` (default 1.5%).
- **SPREAD SNAP**: right earns 15-45 depending on how far the spread moved; wrong costs 5-15.
- **CONCEPT BITE**: 10 for a right answer.
- **XP** = max(points, 0) + 2 per card, so XP never goes down. The **session score** in the header
  can go negative: think of it as your P&L for the session.
- **Levels** (`src/data/levels.json`): Scheduler → Analyst (600 XP) → Risk Trader (1,800) → Book Runner (4,500).
- **Streak**: consecutive calendar days with at least one card answered.
- **Miss queue**: a wrong card comes back after 4 cards, then 12, then 30. A correct review moves it up
  a step, and another miss resets it. About 1 in 5 feed slots is a review card (marked ↻ REVIEW).
  When the seed cards run out, the deck reshuffles with missed cards first.

## Live mode (TAPE CHECK)

`npm run dev` proxies `/yf/*` to `query1.finance.yahoo.com/v8/finance/chart`, because Yahoo
doesn't send CORS headers and a browser can't call it directly. Quotes are cached for 5 minutes. If
anything fails, the cards silently use the snapshot in `tapecheck.json` and show **○ SNAPSHOT**
instead of **● LIVE**. `npm run preview` has the same proxy. To host the built app elsewhere, set
`VITE_YF_BASE` to any CORS-enabled proxy of the same API.

## Adding your own cards: edit JSON only

All content is in `src/data/`. After editing, run `npm run validate`. The app also skips (and
logs a console warning for) any card with missing fields, so a typo never crashes it.

Every card needs `id` (unique), `type`, `category` (`crude` · `spreads` · `products` · `concepts`),
`difficulty` (1-3) and `source`.

**CALL IT** (`callit.json`)

```json
{
  "id": "ci-my-card", "type": "callit", "category": "crude", "difficulty": 2,
  "instrument": "Brent", "contract": "ICE Brent crude, front month", "unit": "$/bbl",
  "headline": "One-line headline at the decision point.",
  "setup": ["Context line 1 (no spoilers).", "Context line 2."],
  "decision": { "date": "2024-01-02", "price": 75.89 },
  "outcome":  { "date": "2024-01-03", "price": 78.25 },
  "horizon": "1 trading day", "flatBandPct": 1.5,
  "series": [74.1, 74.8, 75.2, 75.89],
  "after":  [78.25],
  "why": ["What happened.", "The lesson."],
  "source": "Where the prices came from."
}
```

`series` is the chart up to and including the decision price; `after` is every settlement from the
next day through the outcome. `unit` can be `$/bbl` or `$/gal`.

**CONCEPT BITE** (`concepts.json`): `title`, `lines` (≤ 4), `question: { prompt, choices, answer, explain }`.
`answer` is the index of the right choice. Choices are shuffled on screen, so listing the answer
first is fine.

**SPREAD SNAP** (`spreads.json`): `title`, `formula`, `unit`, `headline`, `setup`, `legs` (two
`{ name, price, unit }`), `spread: { date, now, series }`, `horizon`,
`outcome: { date, spread, result: "WIDEN" | "NARROW", after }`, `why`.

**TAPE CHECK headlines** (`tapecheck.json` → `headlines`): `{ "symbols": ["CL=F"], "date": "2026-11-05", "text": "…" }`.
A headline replaces the card's evergreen "What moves it" line when its date matches the latest bar
(or the day before).

## The physical desk

Physical sessions trade barrels, not just paper. Their P&L books to a separate company **desk
ledger** (`progress.phys`), never to your personal $100k account. Every cost constant lives in
`src/data/economics.json`, each with a `_source` note and a realistic range.

- **Cargo** (`cargo.json`). Day steps on a voyage: CHOOSE PORT, SAIL, WAIT, SELL. The chart shows
  flat price (real Yahoo settles) against the delivered price at each port (basis modeled:
  linear plus seeded noise, labeled on screen). Freight and demurrage meters run all the time. The
  events deck has outages, congestion, weather, demand spikes and distressed sellers. The P&L
  splits into flat, basis, freight + demurrage + port, and events.
- **Tank** (`tank.json`). Weekly steps on the real EIA RCLC1-4 curve and real weekly Cushing
  prints: CARRY, ROLL, SELL, WAIT, with rent and financing accruing. The debrief compares carry
  earned with rent paid. *The spread has to pay more than the tank.*
- **Two-book sessions.** Nine paper sessions carry a physical leg (`session.physical`) that you
  can only hedge. The position bar shows PHYS / PAPER / combined, margin applies to paper only,
  and you get an S-D hedge grade plus a lifetime average. These unlock after 5 cargoes.
- **Two career tracks** in ME: PAPER, and PHYSICAL (Scheduler → Senior Scheduler → Cargo
  Trader → Integrated Book). Basis-spread cards cover Midland, MEH, LLS and sweet-sour; their
  anchors are modeled on real WTI days.
- **Desk agents** (`agents.json`, `physical` block). Mo, Carla, Quinn and Dan play the same
  cargo, tank and two-book sessions by their own rules: port choice, demurrage tolerance, sell
  timing, hedge ratio and storage behavior. They see data only through `cargoView`, which throws
  on look-ahead, and a test corrupts future data to prove it. The debrief shows a desk table.
  After 5 cargoes the agents remember your habits and pre-position against your favorite port.

### Negotiation

SELL in a cargo session, or CARRY in a tank session, opens a bottom panel. In it you haggle
with 1-3 counterparties, each with hidden state: reservation, patience, desperation, bluff and
a preferred pricing term (NOW or AVG5).

- **Moves**: ACCEPT, COUNTER (±$0.05 stepper, optional term flip), STALL or WALK. Every round
  burns half a day: on a cargo the clock and demurrage tick, on a tank the rent does. An ask
  inside their limit goes to "checking with the desk".
- **Pressure**: once your demurrage meter is red, opening bids shade by
  `negotiation.distress_shading_usd_bbl_day` for each red day. With 2+ live bids, counters
  land more often (the leverage chip).
- **Buy side**: on a tank CARRY the counterparties are sellers with floors. Seller distress
  comes from the real EIA Cushing level vs working capacity. Above `seller_clock_ratio` a
  "their clock" hint shows, and the seller with barrels landing and no tank shades down every
  day.
- **Set-pieces from the events deck**:
  - The April 2022 NYH diesel squeeze brings 3 desperate buyers.
  - A stranded VLCC dumping at Houston in April 2020 leaves one lowballing buyer.
- **Relationships** persist per agent: `deals_closed`, `rounds_stalled_on_them` and
  `walk_aways_after_3plus_rounds`. They move opening bids by $0.03-0.08 and show up in the chat
  lines. Set the name they use in ME.
- **NEGOTIATION EDGE** (career stat in ME) = agreed value minus the value of accepting that
  party's first bid, summed over deals, plus a count of bids pulled on you. Each deal gets an
  S-D grade: the edge captured vs their reservation, minus the days burned.

## EIA tab: forecast cards on real weeks

A feed of real EIA weekly reports with the date hidden: 252 weeks of the Weekly Petroleum
Status Report and 252 weeks of the gas storage report (Jan 2022 to Oct 2026), built by
`python3 scripts/build-forecast.py` into `src/data/forecast.json`. Every record has a `source`.
API and consensus figures are not EIA data and have no open history, so they are stored only
for weeks with a cited published figure (`scripts/forecast-api-consensus.json`). Everywhere
else they are `null`.

- **Size classes** on the crude change: FLAT under 1 MMbbl, NORMAL 1-3, BIG 3-7, HUGE over 7.
  Gas uses 20 / 60 / 100 Bcf. The deck mirrors the real class mix in every block of 20 cards.
  The real crude mix is FLAT 12%, NORMAL 31%, BIG 40%, HUGE 17%: the typical week is a
  3-4 MMbbl move, not a flat one.
- **PRINT card**: shows utilization, imports and exports vs their 8-week averages, the
  production trend, API where stored, and a locked regime chip (hurricane, freeze, holiday,
  SPR release). You lock a number. The reveal shows:
  - the print and its class
  - the driver that dominated, from the stored flows ("the draw was exports, not demand")
  - the desk's forecasts
  - your running calibration: your average size vs the market's, and your error by class
- **REACTION card**: asked separately. Given the print and the 5-session run into it, did WTI
  (or Henry Hub) finish release day UP or DOWN? The reveal gives release-day and next-day moves
  and the reason from stored context: API telegraphed it, priced in by the run-up, a macro
  risk-off day, or other news. The naive "draw = up" rule is right on only ~49% of real
  release days.
- **ME → Forecasts** scores the two skills separately:
  - PRINT: mean absolute error vs repeat-last-week and vs consensus (on the weeks consensus
    is stored)
  - REACTION: your hit rate vs the naive rule
  - the desk's long-run record on the whole dataset. Quinn runs a ridge model on the prior two
    years of driver fields, Mo repeats last week, Carla fades the API, and Dan calls a tail
    every week. Dan's errors show what ignoring the base rate costs.

## Where the seed numbers come from

CALL IT and SPREAD SNAP prices, outcomes and sparklines come from exchange settlement history for
the front-month NYMEX WTI (CL), ICE Brent (BZ), NYMEX ULSD (HO) and RBOB (RB) contracts, via
Yahoo Finance's continuous series. They were cross-checked against EIA daily spot prices and the
EIA weekly crude stock series (for the surprise build/draw cards). Nothing numeric was typed by
hand. Continuous front-month series roll at expiry, so a few sparklines show a roll step, and
spreads between legs that roll on different dates can mix delivery months around expiry. Each
card's `source` field names the specific dates and events.

## Code map

```
src/
  trade/       engine.js (positions, P&L, sell-vol, replay, bots), chart.js (canvas), TradeSession, Debrief
  forecast/    engine.js (classes, drivers, reactions, agents, deck, scoring), ForecastScreen, ForecastCards, ForecastStats
  physical/    cargo.js, tank.js, twobook.js (pure engines), agents.js (no-look-ahead desk agents),
               memory.js, ledger.js (desk P&L + tracks), negotiation.js + relationships.js,
               CargoSession, TankSession, NegotiationPanel, PhysDebrief, DeskTable
  data/        JSON content + index.js loader (the only place content lives)
  cards/       one component per card type, registered in cards/index.js
  components/  Feed (scroll-snap), CardShell, StoryBar (15s reel timer), Hud, Sparkline, Reveal, Choice
  screens/     Profile
  lib/         scoring.js, progress.js (XP/streak/miss queue, all pure), feed.js (deck + reviews),
               yahoo.js (live quotes), storage.js, validate.js
```
