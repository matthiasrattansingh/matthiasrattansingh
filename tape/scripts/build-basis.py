#!/usr/bin/env python3
"""Build location/quality BASIS spread sessions (8 candles) into src/data/spreads.json.

Usage (from tape/):  python3 scripts/build-basis.py

There is no free daily settlement history for Midland, MEH, LLS or Mars, so each
basis path is MODELED: interpolated through approximate levels reported at the
time (anchors below, with sources), plus small seeded noise, on real WTI trading
days. Cards say so on screen. WTI (Cushing) prices in the legs are real settlements.
"""
import json, math, os, random

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "src", "data")
WTI = json.load(open(os.path.join(HERE, ".ohlc-cache", "CL.json")))
DATES = sorted(WTI)

BASIS = [
    dict(id="ss-midland-cushing-2018", title="Midland discount", formula="Cushing WTI minus WTI Midland", leg="WTI Midland",
         start="2018-04-16", decision="2018-06-01", end="2018-08-30", difficulty=2, concept="cb-basis",
         anchors={"2018-04-16": 3.0, "2018-05-01": 7.5, "2018-06-01": 10.0, "2018-07-02": 13.0, "2018-08-01": 12.0, "2018-08-30": 16.0},
         open="Permian pipes full; Midland barrels stranded",
         headline="Permian output is outrunning pipeline space to Cushing and the Gulf.",
         setup=["Midland crude trades about $10 under Cushing.", "New pipelines (Cactus II, Gray Oak) are a year away."],
         why=["With pipes full, Midland barrels could only clear at a discount big enough to pay for trucks and rail.",
              "The discount widened toward the mid-teens by late August before new capacity arrived in 2019."],
         news=[("2018-06-13", "Plains: Permian takeaway full into 2019", False), ("2018-08-20", "Midland discount hits widest in years", True)],
         source="Modeled path through approximate Midland-Cushing levels reported in Reuters/Argus coverage, Apr-Aug 2018 ($3 to ~$16/bbl)."),
    dict(id="ss-meh-cushing-2019", title="Houston (MEH) premium", formula="MEH WTI minus Cushing WTI", leg="WTI Houston (MEH)",
         start="2019-06-17", decision="2019-08-01", end="2019-11-01", difficulty=3, concept="cb-freight",
         anchors={"2019-06-17": 3.2, "2019-08-01": 2.6, "2019-09-03": 1.9, "2019-10-01": 1.5, "2019-11-01": 1.2},
         open="New Permian pipes about to reach the Gulf",
         headline="Cactus II and EPIC start moving Permian crude straight to Corpus Christi.",
         setup=["Houston crude trades about $2.60 over Cushing.", "More barrels reaching the coast means more competition for dock space."],
         why=["New pipes flooded the Gulf Coast with Permian barrels, so coastal crude lost its scarcity premium.",
              "The MEH premium narrowed toward ~$1, roughly the cost of moving crude from Cushing to the coast."],
         news=[("2019-08-12", "Cactus II starts flows to Corpus Christi", True), ("2019-09-16", "Abqaiq attack: Gulf export bids jump", False)],
         source="Modeled path through approximate MEH-Cushing premiums reported in 2019 (Argus/Reuters; ~$3 narrowing to ~$1/bbl)."),
    dict(id="ss-lls-wti-2013", title="LLS premium", formula="Light Louisiana Sweet minus Cushing WTI", leg="LLS (St. James)",
         start="2013-01-16", decision="2013-03-01", end="2013-07-15", difficulty=2, concept="cb-brent-wti",
         anchors={"2013-01-16": 21.0, "2013-03-01": 18.0, "2013-04-15": 12.0, "2013-06-03": 7.0, "2013-07-15": 2.5},
         open="Gulf crude at an $18 premium; pipes coming",
         headline="Seaway is expanded and Longhorn is about to carry Permian crude to Houston.",
         setup=["LLS trades about $18 over Cushing WTI.", "Inland crude has been trapped since 2011."],
         why=["As pipelines reached the Gulf, inland barrels competed with LLS and the trapped-crude premium vanished.",
              "LLS-WTI collapsed from about $18 to under $3 in four months."],
         news=[("2013-04-02", "Longhorn pipeline starts Permian flows", True)],
         source="Modeled path through approximate LLS-WTI levels reported in early-mid 2013 (EIA Today in Energy, Reuters)."),
    dict(id="ss-sweet-sour-2019", title="Sweet-sour spread", formula="LLS (sweet) minus Mars (sour)", leg="Mars (sour)",
         start="2018-10-15", decision="2018-12-03", end="2019-03-01", difficulty=3, concept="cb-sweet-sour",
         anchors={"2018-10-15": 4.2, "2018-12-03": 3.5, "2019-01-02": 2.6, "2019-02-01": 1.4, "2019-03-01": 0.8},
         open="OPEC+ cuts start; sour barrels get scarce",
         headline="OPEC+ agrees new cuts from January, mostly medium-sour barrels.",
         setup=["Sweet LLS trades about $3.50 over sour Mars.", "Venezuela's heavy-sour exports are under pressure."],
         why=["OPEC+ cuts and US sanctions on Venezuela removed sour crude, so sour barrels got bid up toward sweet.",
              "The sweet-sour spread compressed toward $1 by March 2019."],
         news=[("2018-12-07", "OPEC+ agrees 1.2 mb/d cut from January", True), ("2019-01-28", "US sanctions Venezuela's PDVSA", True)],
         source="Modeled path through approximate LLS-Mars levels reported in late 2018-early 2019 (Argus, Reuters, EIA)."),
]


def interp(anchors, day):
    keys = sorted(anchors)
    if day <= keys[0]:
        return anchors[keys[0]]
    for a, b in zip(keys, keys[1:]):
        if a <= day <= b:
            ta, tb = DATES.index(nearest(a)), DATES.index(nearest(b))
            t = DATES.index(day)
            f = 0 if tb == ta else (t - ta) / (tb - ta)
            return anchors[a] + (anchors[b] - anchors[a]) * f
    return anchors[keys[-1]]


def nearest(d):
    return min((x for x in DATES if x >= d), default=DATES[-1])


def label(d):
    import datetime
    x = datetime.date.fromisoformat(d)
    return f"{x.day} {x.strftime('%b')}"


def build(spec):
    rng = random.Random(spec["id"])
    days = [d for d in DATES if spec["start"] <= d <= spec["end"]]
    vals = {d: round(interp(spec["anchors"], d) + rng.gauss(0, 0.25), 2) for d in days}
    dec = nearest(spec["decision"])
    hist = [d for d in days if d <= dec][-31:]
    after = [d for d in days if d > dec]
    now, end = vals[dec], vals[after[-1]]
    # 8 candles from the daily path after the decision day.
    k = 8
    groups, start = [], 0
    for g in range(k):
        stop = round((g + 1) * len(after) / k)
        groups.append(after[start:stop])
        start = stop
    candles, prev = [], now
    for part in groups:
        v = [vals[d] for d in part]
        candles.append([round(prev, 2), round(max([prev] + v), 2), round(min([prev] + v), 2), round(v[-1], 2),
                        f"{label(part[0])}–{label(part[-1])}"])
        prev = v[-1]
    candles[-1][3] = end
    news = []
    for day, text, major in spec["news"]:
        assert len(text) <= 40, text
        at = next((i for i, g in enumerate(groups) if g[-1] >= day), k - 1)
        news.append({"at": at, "text": text, "major": major, "day": day})
    wti_now = round(WTI[dec][3], 2)
    return {
        "id": spec["id"], "type": "spread", "category": "spreads", "difficulty": spec["difficulty"],
        "title": spec["title"], "formula": spec["formula"], "unit": "$/bbl", "basis": True,
        "headline": spec["headline"], "setup": spec["setup"],
        "legs": [{"name": "WTI Cushing", "price": wti_now, "unit": "$/bbl"},
                 {"name": spec["leg"], "price": round(wti_now + (now if spec["formula"].startswith(spec["leg"].split(' (')[0]) else -now), 2), "unit": "$/bbl"}],
        "spread": {"date": dec, "now": now, "series": [vals[d] for d in hist]},
        "horizon": f"{len(after)} trading days",
        "outcome": {"date": after[-1], "spread": end, "result": "WIDEN" if end > now else "NARROW", "after": [vals[d] for d in after]},
        "why": spec["why"],
        "source": spec["source"] + " WTI legs: NYMEX settlements (real).",
        "session": {"bars": "multi-day", "simulated": True, "label": "Basis path modeled from reported levels · WTI real",
                    "candles": candles, "days": [g[0] for g in groups], "open": spec["open"], "news": news, "concept": spec["concept"]},
    }


def main():
    path = os.path.join(DATA, "spreads.json")
    doc = json.load(open(path))
    ids = {s["id"] for s in BASIS}
    doc["cards"] = [c for c in doc["cards"] if c["id"] not in ids] + [build(s) for s in BASIS]
    json.dump(doc, open(path, "w"), indent=1, ensure_ascii=False)
    for s in BASIS:
        c = next(c for c in doc["cards"] if c["id"] == s["id"])
        print(f"{c['id']:26s} now {c['spread']['now']:6.2f} -> {c['outcome']['spread']:6.2f} {c['outcome']['result']}")


if __name__ == "__main__":
    main()
