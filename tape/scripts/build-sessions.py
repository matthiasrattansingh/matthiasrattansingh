#!/usr/bin/env python3
"""Build TRADE-mode candles for every CALL IT scenario and the spread sessions.

Usage (from tape/):  python3 scripts/build-sessions.py [scenario-id ...]

Downloads real daily OHLC for the front-month futures (NYMEX CL/HO/RB, ICE BZ)
from Yahoo Finance's chart API once (cached in scripts/.ohlc-cache/), then
writes a `session` block into each card in src/data/callit.json and
src/data/spreads.json. Hand-written fields (news, concept) are kept.

How candles are made, by trading days in the scenario's horizon (N):
  N = 1..7  -> each real day is split into intraday candles. Open, high, low
               and close of every day are the real settlement-series values;
               the path between them is synthesized (seeded, deterministic)
               and labelled "path simulated, OHLC real".
  N = 8..16 -> one real daily candle per day.
  N > 16    -> consecutive days merged into 12-16 real multi-day candles.
Spread sessions use the spread's real daily closes merged into 8 candles.
"""
import json, math, os, random, sys, time, urllib.request, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "src", "data")
CACHE = os.path.join(HERE, ".ohlc-cache")
SYMBOL = {"WTI": "CL", "Brent": "BZ", "ULSD": "HO", "RBOB": "RB"}
PER_DAY = {1: 14, 2: 7, 3: 5, 4: 4, 5: 3, 6: 2, 7: 2}


def ohlc(sym):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{sym}.json")
    if not os.path.exists(path):
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}=F?period1=946684800&period2={int(time.time())}&interval=1d"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (TAPE build script)"})
        r = json.load(urllib.request.urlopen(req))["chart"]["result"][0]
        q = r["indicators"]["quote"][0]
        rows = {}
        for i, ts in enumerate(r["timestamp"]):
            vals = [q[k][i] for k in ("open", "high", "low", "close")]
            if None in vals:
                continue
            rows[datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime("%Y-%m-%d")] = vals
        json.dump(rows, open(path, "w"))
    return json.load(open(path))


def nd(unit):
    return 4 if unit == "$/gal" else 2


def label(date):
    d = datetime.date.fromisoformat(date)
    return f"{d.day} {d.strftime('%b')}"


def synth_day(o, h, l, c, k, rng):
    """k candles whose path starts at o, ends at c and touches exactly h and l."""
    h, l = max(h, o, c), min(l, o, c)
    up = c >= o
    first, second = (l, h) if (up if rng.random() < 0.75 else not up) else (h, l)
    # The extreme against the day's move usually comes early; the other one late.
    t1 = rng.randint(1, max(1, k // 3))
    t2 = rng.randint(max(t1 + 1, k // 2), k - 1) if k > 2 else min(t1 + 1, k)
    # If an extreme is basically the open or close, put it there.
    if abs(first - o) < 1e-9: t1 = 0
    if abs(second - c) < 1e-9: t2 = k
    knots = sorted({0: o, t1: first, t2: second, k: c}.items())
    R = (h - l) or abs(o) * 0.001 or 0.01
    inner_lo, inner_hi = l + 0.03 * R, h - 0.03 * R  # only the knots touch the real extremes
    knot_t = {t for t, _ in knots}
    pts = []
    for j in range(k + 1):
        for (ta, va), (tb, vb) in zip(knots, knots[1:]):
            if ta <= j <= tb:
                f = 0 if tb == ta else (j - ta) / (tb - ta)
                base = va + (vb - va) * f
                if j in knot_t:
                    pts.append(base)
                else:
                    bridge = 2 * math.sqrt(f * (1 - f))  # zero at the knots, widest in between
                    pts.append(min(inner_hi, max(inner_lo, base + rng.gauss(0, R * 0.035) * bridge)))
                break
    candles = []
    for j in range(k):
        a, b = pts[j], pts[j + 1]
        top = h if (j in knot_t or j + 1 in knot_t) and max(a, b) >= inner_hi else inner_hi
        bot = l if (j in knot_t or j + 1 in knot_t) and min(a, b) <= inner_lo else inner_lo
        hi = max(a, b, min(top, max(a, b) + abs(rng.gauss(0, R * 0.02))))
        lo = min(a, b, max(bot, min(a, b) - abs(rng.gauss(0, R * 0.02))))
        candles.append([a, hi, lo, b])
    return candles


def merge(rows):
    """rows: list of [o,h,l,c] -> one candle."""
    return [rows[0][0], max(r[1] for r in rows), min(r[2] for r in rows), rows[-1][3]]


def chunks(n, target_lo=12, target_hi=16):
    for size in range(1, n + 1):
        if math.ceil(n / size) <= target_hi:
            return size
    return n


def callit_session(card, old):
    sym = SYMBOL[card["instrument"]]
    data = ohlc(sym)
    dates = sorted(d for d in data if card["decision"]["date"] < d <= card["outcome"]["date"])
    n = len(dates)
    rng = random.Random(card["id"])
    out, kind = [], ""
    if n <= 7:
        k = PER_DAY[n]
        for d in dates:
            for j, cdl in enumerate(synth_day(*data[d], k, rng)):
                out.append(cdl + [f"{label(d)} · {j + 1}/{k}"])
        kind = "intraday"
    elif n <= 16:
        out = [data[d] + [label(d)] for d in dates]
        kind = "daily"
    else:
        size = chunks(n)
        for i in range(0, n, size):
            part = dates[i:i + size]
            out.append(merge([data[d] for d in part]) + [f"{label(part[0])}–{label(part[-1])}"])
        kind = "multi-day"
    r = nd(card["unit"])
    candles = [[round(v, r) for v in cdl[:4]] + [cdl[4]] for cdl in out]
    # The last close must equal the scenario's outcome price (same settlement series).
    candles[-1][3] = card["outcome"]["price"]
    candles[-1][1] = max(candles[-1][1], candles[-1][3]); candles[-1][2] = min(candles[-1][2], candles[-1][3])
    return {
        "bars": kind,
        "simulated": kind == "intraday",
        "label": {"intraday": "Intraday · path simulated, OHLC real", "daily": "Daily candles · real OHLC",
                  "multi-day": f"{size if kind == 'multi-day' else 1}-day candles · real OHLC"}[kind],
        "candles": candles,
        "open": (old or {}).get("open", ""),
        "news": (old or {}).get("news", []),
    }


def spread_session(card, old, n_out=8):
    # Spread closes across the horizon, from the card's own series (built from real settlements).
    series = [card["spread"]["now"]] + card["outcome"]["full"]
    n = len(series) - 1
    size = max(1, math.ceil(n / n_out))
    candles = []
    for i in range(1, n + 1, size):
        part = series[i:i + size]
        o = series[i - 1]
        candles.append([round(o, 2), round(max([o] + part), 2), round(min([o] + part), 2), round(part[-1], 2), f"session {len(candles) + 1}"])
    candles[-1][3] = card["outcome"]["spread"]
    return {"bars": "multi-day", "simulated": False, "label": f"{size}-day candles · from real daily closes",
            "candles": candles, "open": (old or {}).get("open", ""), "news": (old or {}).get("news", [])}


def main(only):
    path = os.path.join(DATA, "callit.json")
    doc = json.load(open(path))
    for card in doc["cards"]:
        if only and card["id"] not in only:
            continue
        card["session"] = callit_session(card, card.get("session"))
        print(f"{card['id']:32s} {card['session']['bars']:9s} {len(card['session']['candles'])} candles")
    json.dump(doc, open(path, "w"), indent=1, ensure_ascii=False)

    spath = os.path.join(DATA, "spreads.json")
    sdoc = json.load(open(spath))
    for card in sdoc["cards"]:
        if only and card["id"] not in only:
            continue
        if not card["outcome"].get("full") or len(card["outcome"]["full"]) < 8:
            continue  # too short for an 8-candle session
        card["session"] = spread_session(card, card.get("session"))
        print(f"{card['id']:32s} spread    {len(card['session']['candles'])} candles")
    json.dump(sdoc, open(spath, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main(set(sys.argv[1:]))
