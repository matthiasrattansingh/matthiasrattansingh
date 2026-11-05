# TAPE

A vertical, swipe-up card feed for learning crude oil and refined products. Every card fits one
phone screen, takes under 15 seconds, and ends with a decision or one concrete fact.

```bash
cd tape
npm install
npm run dev        # open the printed URL; on your phone use the "Network" URL on the same Wi-Fi
```

No backend and no API keys. Progress lives in your browser's `localStorage`.

## What's in the feed

| Card | You do | Seed count |
| --- | --- | --- |
| **CALL IT** | Real historical moment, chart drawn up to the decision. Tap LONG / FLAT / SHORT, then size it (conviction 1-3). The reveal extends the chart, shows the move in $/bbl and the "why". | 40 |
| **CONCEPT BITE** | One idea in four lines, then one multiple-choice question. | 25 |
| **SPREAD SNAP** | Two related prices and the spread's last 30 sessions. Call WIDEN or NARROW over the horizon. | 11 |
| **TAPE CHECK** | Today's WTI, Brent, RBOB, ULSD and Henry Hub: price, day change, 5-day sparkline, and a driver line. | 5 |

Tabs at the top: **FEED** (the mixed endless feed), **LIVE** (just the five TAPE CHECK cards) and **ME** (profile).

## Scoring

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
  data/        JSON content + index.js loader (the only place content lives)
  cards/       one component per card type, registered in cards/index.js
  components/  Feed (scroll-snap), CardShell, StoryBar (15s reel timer), Hud, Sparkline, Reveal, Choice
  screens/     Profile
  lib/         scoring.js, progress.js (XP/streak/miss queue, all pure), feed.js (deck + reviews),
               yahoo.js (live quotes), storage.js, validate.js
```
