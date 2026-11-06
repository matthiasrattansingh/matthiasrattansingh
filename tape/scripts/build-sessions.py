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


def groups(items, k):
    """Split items into k consecutive, nearly equal groups."""
    k = min(k, len(items))
    out, start = [], 0
    for g in range(k):
        end = round((g + 1) * len(items) / k)
        out.append(items[start:end])
        start = end
    return out


def resolve_news(news, days):
    """News can be pinned to a calendar day ("day") instead of a candle index ("at")."""
    out = []
    for n in news:
        n = dict(n)
        if "day" in n:
            n["at"] = next((i for i, d in enumerate(days) if d >= n["day"]), len(days) - 1)
        out.append(n)
    return out


def keep(old, key, default):
    return (old or {}).get(key, default)


def callit_session(card, old):
    sym = SYMBOL[card["instrument"]]
    data = ohlc(sym)
    dates = sorted(d for d in data if card["decision"]["date"] < d <= card["outcome"]["date"])
    n = len(dates)
    rng = random.Random(card["id"])
    out, days = [], []
    if n <= 7:
        k = PER_DAY[n]
        for d in dates:
            for j, cdl in enumerate(synth_day(*data[d], k, rng)):
                out.append(cdl + [f"{label(d)} · {j + 1}/{k}"])
                days.append(d)
        kind, text = "intraday", "Intraday · path simulated, OHLC real"
    elif n < 12:
        # Too few days for 12-16 candles: split the busiest days (largest real range) in two.
        busiest = set(sorted(dates, key=lambda d: data[d][1] - data[d][2], reverse=True)[:14 - n])
        for d in dates:
            if d in busiest:
                for j, cdl in enumerate(synth_day(*data[d], 2, rng)):
                    out.append(cdl + [f"{label(d)} · {j + 1}/2"])
                    days.append(d)
            else:
                out.append(data[d] + [label(d)])
                days.append(d)
        kind, text = "intraday", "Daily, busiest days split · path simulated, OHLC real"
    elif n <= 16:
        out = [data[d] + [label(d)] for d in dates]
        days = list(dates)
        kind, text = "daily", "Daily candles · real OHLC"
    else:
        for part in groups(dates, 14):
            out.append(merge([data[d] for d in part]) + [f"{label(part[0])}–{label(part[-1])}"])
            days.append(part[0])
        kind, text = "multi-day", f"{min(len(g) for g in groups(dates, 14))}-{max(len(g) for g in groups(dates, 14))} day candles · real OHLC"
    r = nd(card["unit"])
    candles = [[round(v, r) for v in cdl[:4]] + [cdl[4]] for cdl in out]
    # The last close must equal the scenario's outcome price (same settlement series).
    candles[-1][3] = card["outcome"]["price"]
    candles[-1][1] = max(candles[-1][1], candles[-1][3]); candles[-1][2] = min(candles[-1][2], candles[-1][3])
    return {"bars": kind, "simulated": kind == "intraday", "label": text, "candles": candles, "days": days,
            "open": keep(old, "open", ""), "news": resolve_news(keep(old, "news", []), days), "concept": keep(old, "concept", None)}


# Spread definitions in $/bbl from the four futures (products × 42).
SPREADS = {
    "brent-wti": lambda q: q["BZ"] - q["CL"],
    "diesel-crack": lambda q: q["HO"] * 42 - q["BZ"],
    "gas-crack": lambda q: q["RB"] * 42 - q["BZ"],
    "321": lambda q: (2 * q["RB"] * 42 + q["HO"] * 42 - 3 * q["CL"]) / 3,
    "diesel-vs-gas": lambda q: (q["HO"] - q["RB"]) * 42,
}


def spread_kind(card_id):
    for k in SPREADS:
        if card_id.startswith(f"ss-{k}"):
            return k
    raise KeyError(card_id)


def spread_session(card, old, n_out=8):
    f = SPREADS[spread_kind(card["id"])]
    data = {s: ohlc(s) for s in ("CL", "BZ", "HO", "RB")}
    common = sorted(set.intersection(*(set(v) for v in data.values())))
    d0, d1 = card["spread"]["date"], card["outcome"]["date"]
    dates = [d for d in common if d0 < d <= d1]
    if len(dates) < n_out:
        return None  # too short for an 8-candle session from real daily closes
    close = lambda d: f({s: data[s][d][3] for s in data})
    prev = close(d0)
    candles, days = [], []
    for part in groups(dates, n_out):
        vals = [close(d) for d in part]
        candles.append([round(prev, 2), round(max([prev] + vals), 2), round(min([prev] + vals), 2), round(vals[-1], 2),
                        f"{label(part[0])}–{label(part[-1])}" if len(part) > 1 else label(part[0])])
        days.append(part[0])
        prev = vals[-1]
    candles[-1][3] = card["outcome"]["spread"]
    sizes = [len(g) for g in groups(dates, n_out)]
    return {"bars": "multi-day", "simulated": False, "label": f"{min(sizes)}-{max(sizes)} day candles · from real daily settlements",
            "candles": candles, "days": days, "open": keep(old, "open", ""),
            "news": resolve_news(keep(old, "news", []), days), "concept": keep(old, "concept", None)}


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
        sess = spread_session(card, card.get("session"))
        if sess:
            card["session"] = sess
            print(f"{card['id']:32s} spread    {len(sess['candles'])} candles")
    json.dump(sdoc, open(spath, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    main(set(sys.argv[1:]))

