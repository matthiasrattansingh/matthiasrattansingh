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
  data/        JSON content + index.js loader (the only place content lives)
  cards/       one component per card type, registered in cards/index.js
  components/  Feed (scroll-snap), CardShell, StoryBar (15s reel timer), Hud, Sparkline, Reveal, Choice
  screens/     Profile
  lib/         scoring.js, progress.js (XP/streak/miss queue, all pure), feed.js (deck + reviews),
               yahoo.js (live quotes), storage.js, validate.js
```
