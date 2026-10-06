# Crack Spread Paper Trader

A live-market **paper-trading game** for Brent and refined products. Each weekday you read a
timestamped recap, look at a neutral market snapshot, and decide whether to enter a simulated
trade. Open positions are marked to market from real quotes for the exact contract months,
the ledger enforces margin and a 15% peak-drawdown rule, and EIA release reactions are captured
from recorded market data — never invented.

> **Simulation only.** There is no broker connection anywhere in this code. Every fill, exit and
> liquidation is a simulated paper record; no real order is ever sent.

## Quick start

Requires Node.js **22.18+** (TypeScript runs natively; storage uses the built-in `node:sqlite`).

```bash
npm install
npm run build        # builds the dashboard into web/dist
npm start            # API + dashboard on http://127.0.0.1:8787
```

Development (API with `--watch` plus the Vite dev server on http://127.0.0.1:5173):

```bash
npm run dev
```

Tests and type checks:

```bash
npm test
npm run typecheck
```

On first start the app seeds the paper account (see below). State lives in
`data/paper-trading.sqlite` (override with `DATA_DIR`). Back up that file to keep your history.
Only one server process may use a data directory at a time (a lock file enforces this).

## Configuration

Secrets go in environment variables only (copy `.env.example` to `.env`, which is git-ignored).
They are read by the server and never sent to the browser; the Settings page only shows whether
each one is set.

| Variable | Purpose |
|---|---|
| `DATABENTO_API_KEY` | Databento historical API (CME Globex `GLBX.MDP3`) |
| `CUSTOM_QUOTE_API_KEY` | Key for the generic HTTP/JSON quote adapter |
| `EIA_API_KEY` | EIA Open Data API v2 (free registration) for weekly inventories |
| `FX_API_BASE` | Optional Frankfurter base URL (default `https://api.frankfurter.dev/v1`) |
| `HOST`, `PORT` | Bind address (default `127.0.0.1:8787`) |
| `APP_BASIC_AUTH` | Optional `user:password` HTTP Basic auth — set it if `HOST` is not loopback |
| `DATA_DIR` | Ledger directory (default `./data`) |
| `DISABLE_SCHEDULER=1` | Run the API without the in-process scheduler |

Everything else — provider choice, display time zone, schedule, stale tolerance, fill policy,
daily trade limit, margins, commissions, slippage, drawdown limit, expiry guard and EIA holiday
overrides — is edited in **Settings** and every change is logged in History.

## Market data

Every quote is stored against an exact contract (`HOX2026`, `BZZ2026`, …) with its price and
units, source, exchange/displayed timestamp, the local observation time, declared delay, and a
freshness status: **delayed**, **market closed · last**, **stale**, or **unavailable**. No
continuous or front-month quote is ever substituted for a specific contract; M1/M2 labels are
resolved explicitly from CME expiry rules and shown next to the contract code.

**TradingView.** TradingView does not offer a permitted programmatic quote API for this use, and
its internal endpoints must not be scraped, so the app does not read TradingView data. It embeds
TradingView's official widgets on the Market page as a *visual reference* (they are cross-origin
iframes the app cannot read). To use a value you see there, enter it on the Market page with the
“TradingView (transcribed)” source preset, its displayed timestamp and the ~10-minute delay.

Quote sources (Settings → Market data):

- **Manual entry** (default). Transcribe quotes with their displayed time. A dry-run preview
  shows the resulting crack, P/L and whether any exit or liquidation would trigger before saving.
  Entries are sanity-checked (e.g. a $/bbl number typed into a $/gal contract is rejected) and
  moves over 5% need confirmation.
- **Databento** (`DATABENTO_API_KEY`). Pulls the latest 1-minute bar close per exact contract
  (raw symbols such as `HOX6`, `BZZ6`) from the historical API, timestamped at bar end.
- **Custom HTTP/JSON**. Point it at any quote API you are licensed for: URL template with
  `{symbol}` (and optional `{apiKey}`), a symbol template (`{root}{month}{yy}` → `HOX26`), JSON
  paths for price/timestamp/symbol, and the source's declared delay. The response must echo the
  exact requested symbol or it is rejected; timestamps must carry a UTC offset.

**Freshness.** While NYMEX is open, a quote is stale once its exchange time is older than its
declared delay plus the stale tolerance (default 30 min). While closed, the last quote from the
most recent session is a valid mark. If any leg is stale or missing, P/L and equity are labeled
**provisional** and the missing inputs are named. The status bar shows market-data time (the
oldest position-leg exchange time) separately from the app-refresh time.

**Fundamentals.** EIA weekly stocks (distillate, crude ex-SPR, gasoline, Cushing) come from the
EIA API when `EIA_API_KEY` is set, or from manual entry. API survey numbers and analyst estimates
can be entered too; they are stored and labeled separately and never count as EIA data. The FX
basket uses ECB reference rates via Frankfurter (daily fixings, labeled as such) with manual
entry as a fallback.

## The seeded account

- $100,000 simulated equity.
- Position #1 — long NY Harbor ULSD vs Brent crack: long 5 `HOX2026` (5 × 42,000 gal = 5,000 bbl),
  short 5 `BZZ2026` (5 × 1,000 bbl = 5,000 bbl), simulated net-spread entry **$87.330/bbl**.
  The entry is fixed and never replaced by a mark. It is labeled as a simulated paper fill.
- Thesis exit: close both legs when EIA actuals confirm three consecutive weekly distillate
  builds (the confirming release must come after the position's entry).
- Margin status: **unknown until you enter verified figures** for `HOX2026` and `BZZ2026` (or a
  `SPREAD:BZZ2026+HOX2026` figure). Until then reserved margin and buying power are unknown and
  new orders are blocked.
- A watch-only crude options condor note, excluded from positions, margin, buying power and P/L.

```
net crack ($/bbl) = HO ($/gal) × 42 − Brent ($/bbl)
gross P/L ($)     = (net crack − 87.330) × 5,000 bbl
```

P/L is gross before costs unless commissions or slippage are configured. With a $100,000 peak,
the 15% limit is $15,000, i.e. **$3.00/bbl of adverse crack movement on 5,000 bbl: the first
valid mark with a net crack at or below $84.330 liquidates the position** (the level moves with
the peak and is shown on the Positions page).

## Trading and risk rules

- **Orders.** Crack spreads (HO/RB vs BZ/CL), calendar spreads, or outrights, sized in contracts
  or whole 1,000-bbl lots, with market or limit entry, day or GTC, a rationale, an exit rule in
  words and optional machine-enforced exits (stop/target level, max loss, EIA distillate builds,
  close-on-date). New trades are accepted Monday–Friday (ET), one per weekday by default.
- **Margin check.** Each order shows direction, contracts, entry method, exit rule, required
  initial margin with the source and date of each figure, and equity, reserved margin and
  buying power before and after. Orders are rejected (and logged) when margin is unknown, a figure
  is older than the max age, equity is provisional, or required margin exceeds buying power.
  Notional value is never used as margin. Margin is re-checked at fill.
- **Fills.** Default policy fills at the first valid mark whose exchange time is at or after
  submission, so delayed prices you have already seen cannot be traded. Fills only happen while
  NYMEX is open. Idempotency keys make retried submissions return the original order.
- **Drawdown.** Equity is marked against a high-water mark raised only by fully valid marks. When
  marked equity reaches 15% below peak, every open position is liquidated at the first available
  valid mark (with configured slippage), the timestamp, marks, realized P/L and reason are
  recorded, and trading halts. A breach seen only on provisional marks is flagged but waits for
  valid marks. If the exchange is closed, liquidation fills at the first valid mark of the next
  session.
- **Expiry guard** (on by default). Positions are not carried into expiry: they close at the first
  valid mark after 12:00 ET on the earliest leg's computed last trading day. `HOX2026` and
  `BZZ2026` both compute to **2026-10-30**.

## Schedule and updates

The scheduler runs inside the server process:

| Job | When |
|---|---|
| Hourly mark + ledger update | Top of each ET hour while NYMEX is open (Sun 18:00 – Fri 17:00 ET), skipping the 17:00–18:00 maintenance break, weekends and CME holidays |
| Briefing | Weekdays at 07:00 ET (generated late and labeled if the app starts after 07:00) |
| EIA | On release days (default Wednesday 10:30 ET; override holiday weeks in Settings): polls the EIA API until the week's data arrives, then computes the 0–15 minute reaction |
| Fill poll | Every 5 min while orders or exits are pending (API providers) |

Each hourly update records both leg prices with contract months, timestamps, source and delay
status, the net crack, unrealized/realized/total P/L, equity, drawdown, reserved margin, buying
power, distance to the drawdown limit, and any rejected orders, triggered exits or liquidations.

**Limitations.** Updates happen only while the server is running; slots missed while it was down
are recorded as *missed* and never backfilled, and the dashboard shows the last successful run.
No push, email or SMS notifications are sent — updates appear in the dashboard (History →
Hourly updates). With the manual source, hourly updates re-mark your last entered quotes, which
turn stale unless you enter new ones.

**EIA reaction.** After the data is recorded, the report compares the last quote at/before the
release time with the quote at the end of the 15-minute window, using exchange timestamps for
the exact contracts (plus the crack). With ~10-minute delayed data the +15 minute quote is
observable about 25 minutes after release. Missing quotes are reported as missing.

## Verification status

- The automated suite covers P/L arithmetic, barrel/gallon conversion and contract multipliers,
  margin rejection and buying power, drawdown measurement and liquidation (including slippage,
  closed-market deferral and idempotent retries), stale-quote handling and no contract
  substitution, the three-week inventory exit, the EIA reaction capture, hourly-update
  idempotency and missed-slot recording, recap neutrality, and the provider adapters.
- The dashboard was exercised end-to-end in a browser with manual quotes, margin entry, order
  submission/fill, EIA entry and a drawdown liquidation.
- The Databento, custom HTTP, EIA and Frankfurter adapters are implemented against the providers'
  documented formats and tested with fixtures and a local mock server, but have **not** yet been
  verified against the live services with real credentials.
- Exchange holidays and last trading days are computed from CME rules (full-day closures only;
  early-close sessions are treated as closed). Verify against the official calendars and add EIA
  overrides for holiday weeks.

## Layout

```
src/domain/     pure logic: contracts & expiry, calendar, P/L, risk, freshness, inventory, neutrality
src/server/     SQLite ledger, engine, orders, quotes, providers, EIA, FX, briefing, scheduler, HTTP
src/shared/     API types shared with the dashboard
web/            React + Vite dashboard
test/           node:test suites
```
