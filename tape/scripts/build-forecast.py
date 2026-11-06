#!/usr/bin/env python3
"""Build the FORECAST library (src/data/forecast.json) from real EIA history.

Usage (from tape/):  python3 scripts/build-forecast.py

Petroleum (EIA Weekly Petroleum Status Report, weekly series, hist_xls downloads):
  WCESTUS1  commercial crude stocks ex-SPR (kbbl)      WGTSTUS1 total gasoline stocks (kbbl)
  WDISTUS1  distillate stocks (kbbl)                   WCSSTUS1 SPR stocks (kbbl)
  WPULEUS3  refinery utilization (%)                   WCRRIUS2 refiner net crude input (kb/d)
  WCRFPUS2  US field production of crude (kb/d)        WCRIMUS2 crude imports (kb/d)
  WCREXUS2  crude exports (kb/d)
Natural gas (EIA Weekly Natural Gas Storage Report):
  NW2_EPG0_SWO_R48_BCF  Lower-48 working gas in storage (Bcf)
Prices: NYMEX front-month WTI (CL=F) and Henry Hub (NG=F) daily settles via Yahoo Finance
(EIA stopped publishing its NYMEX futures series RCLC1/RNGC1 in April 2024); S&P 500 daily
close (Yahoo ^GSPC) for the macro tag.

Stock changes are week-on-week differences of the stock levels, as the WPSR reports them.
Release dates follow EIA's standard schedule (petroleum Wednesday, gas Thursday, 5 and 6 days
after the Friday week-end) shifted for federal holidays; they are computed, not scraped
(ir.eia.gov release archives are not reachable from the build environment).
API and analyst-consensus numbers are not EIA data and are not published as an open series:
they are stored only for the weeks listed in API_CONSENSUS below, each with its own citation,
and are null elsewhere.
"""
import datetime as dt
import json, os, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "src", "data")
CACHE = os.path.join(HERE, ".eia-cache")

PET = "https://www.eia.gov/dnav/pet/hist_xls/{}.xls"
SERIES = {
    "crude": PET.format("WCESTUS1w"), "gasoline": PET.format("WGTSTUS1w"),
    "distillate": PET.format("WDISTUS1w"), "spr": PET.format("WCSSTUS1w"),
    "util": PET.format("WPULEUS3w"), "runs": PET.format("WCRRIUS2w"),
    "prod": PET.format("WCRFPUS2w"), "imports": PET.format("WCRIMUS2w"),
    "exports": PET.format("WCREXUS2w"),
    "gas": "https://www.eia.gov/dnav/ng/hist_xls/NW2_EPG0_SWO_R48_BCFw.xls",
}
SERIES_ID = {
    "crude": "WCESTUS1", "gasoline": "WGTSTUS1", "distillate": "WDISTUS1", "spr": "WCSSTUS1",
    "util": "WPULEUS3", "runs": "WCRRIUS2", "prod": "WCRFPUS2", "imports": "WCRIMUS2",
    "exports": "WCREXUS2", "gas": "NW2_EPG0_SWO_R48_BCF",
}

START = "2022-01-07"  # first week-ending in the library (~4 years of weeks)

# Size classes on |change|. Petroleum in MMbbl (per the design brief); gas in Bcf,
# scaled so the classes mean the same thing (most weeks boring, tails rare).
PET_CLASSES = [("FLAT", 1.0), ("NORMAL", 3.0), ("BIG", 7.0), ("HUGE", None)]
GAS_CLASSES = [("FLAT", 20.0), ("NORMAL", 60.0), ("BIG", 100.0), ("HUGE", None)]

# Federal holidays (observed) 2021-2026, plus executive-order closures, which move EIA releases.
HOLIDAYS = {
    "2021-12-24", "2021-12-31",
    "2022-01-17", "2022-02-21", "2022-05-30", "2022-06-20", "2022-07-04", "2022-09-05",
    "2022-10-10", "2022-11-11", "2022-11-24", "2022-12-26",
    "2023-01-02", "2023-01-16", "2023-02-20", "2023-05-29", "2023-06-19", "2023-07-04",
    "2023-09-04", "2023-10-09", "2023-11-10", "2023-11-23", "2023-12-25",
    "2024-01-01", "2024-01-15", "2024-02-19", "2024-05-27", "2024-06-19", "2024-07-04",
    "2024-09-02", "2024-10-14", "2024-11-11", "2024-11-28", "2024-12-24", "2024-12-25",
    "2025-01-01", "2025-01-09", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19",
    "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-24",
    "2025-12-25", "2025-12-26",
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03",
    "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
}

# Regime tags revealed after the print. Weather events are tagged on the report week they hit
# (week ending Friday); each carries its source. SPR-release weeks are computed from WCSSTUS1.
REGIMES = [
    ("2022-09-30", "hurricane", "Hurricane Ian made landfall in SW Florida on 28 Sep 2022 (NHC TCR AL092022)."),
    ("2022-12-23", "freeze", "Winter Storm Elliott: Gulf Coast refineries and Permian output shut by the 22-25 Dec 2022 freeze (EIA Today in Energy, Jan 2023)."),
    ("2022-12-30", "freeze", "Elliott aftermath: refinery restarts and lost Permian output (EIA Today in Energy, Jan 2023)."),
    ("2023-09-01", "hurricane", "Hurricane Idalia made landfall in Florida's Big Bend on 30 Aug 2023 (NHC TCR AL102023)."),
    ("2024-01-19", "freeze", "January 2024 Arctic blast (Winter Storm Heather): North Dakota and Permian output fell sharply (EIA WPSR, 24 Jan 2024)."),
    ("2024-07-12", "hurricane", "Hurricane Beryl hit the Texas coast on 8 Jul 2024 and closed Corpus Christi and Houston ports (NHC TCR AL022024)."),
    ("2024-09-13", "hurricane", "Hurricane Francine landed in Louisiana on 11 Sep 2024; ~40% of Gulf of Mexico output shut (BSEE)."),
    ("2024-09-27", "hurricane", "Hurricane Helene crossed the Gulf, landfall 26 Sep 2024 in Florida (NHC TCR AL092024)."),
    ("2024-10-11", "hurricane", "Hurricane Milton made landfall in Florida on 9 Oct 2024 (NHC TCR AL142024)."),
    ("2025-01-24", "freeze", "Winter Storm Enzo brought record Gulf Coast snow on 21 Jan 2025 (NWS)."),
]

# API (American Petroleum Institute, Tuesday) and analyst consensus (Reuters/WSJ poll) for
# the crude print. Not EIA data, no open history: stored only where a published figure was
# checked, with its citation. week_ending -> {api, consensus, source}
API_CONSENSUS_PATH = os.path.join(HERE, "forecast-api-consensus.json")


def fetch(key):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"fc_{key}.xls")
    if not os.path.exists(path):
        req = urllib.request.Request(SERIES[key], headers={"User-Agent": "Mozilla/5.0 (TAPE build script)"})
        open(path, "wb").write(urllib.request.urlopen(req, timeout=60).read())
    import xlrd
    wb = xlrd.open_workbook(path)
    sh = wb.sheet_by_name("Data 1")
    out = {}
    for r in range(3, sh.nrows):
        v = sh.cell_value(r, 1)
        if v == "":
            continue
        out[xlrd.xldate_as_datetime(sh.cell_value(r, 0), wb.datemode).strftime("%Y-%m-%d")] = float(v)
    return dict(sorted(out.items()))


def yahoo(sym, name):
    path = os.path.join(CACHE, f"fc_{name}.json")
    if not os.path.exists(path):
        p1 = int(dt.datetime(2021, 11, 1).timestamp())
        p2 = int(dt.datetime.now().timestamp())
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?period1={p1}&period2={p2}&interval=1d"
        raw = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read())
        r = raw["chart"]["result"][0]
        closes = r["indicators"]["quote"][0]["close"]
        out = {}
        for t, c in zip(r["timestamp"], closes):
            if c is not None:
                # Yahoo stamps futures sessions at the exchange open (UTC-5 previous evening for
                # CME Globex), so convert in New York time to get the session date.
                ny = dt.datetime.fromtimestamp(t, dt.timezone(dt.timedelta(hours=-4)))
                out[ny.strftime("%Y-%m-%d")] = round(c, 3)
        json.dump(out, open(path, "w"))
    return json.load(open(path))


D = lambda s: dt.date.fromisoformat(s)
iso = lambda d: d.isoformat()


def shift_release(week_end, offset, gas=False):
    """Standard release day, moved by federal holidays. Returns (date, note)."""
    we = D(week_end)
    rel = we + dt.timedelta(days=offset)
    monday = we + dt.timedelta(days=3)
    if gas:
        # Gas report (Thursday): a Thursday holiday moves it to Wednesday; a Mon-Wed holiday to Friday.
        if iso(rel) in HOLIDAYS:
            rel -= dt.timedelta(days=1)
            while iso(rel) in HOLIDAYS:
                rel -= dt.timedelta(days=1)
            return rel, "released early: holiday"
        n = sum(1 for k in range(3) if iso(monday + dt.timedelta(days=k)) in HOLIDAYS)
        if n:
            rel += dt.timedelta(days=1)
            return rel, "delayed a day: holiday"
        return rel, None
    n = sum(1 for k in range(3) if iso(monday + dt.timedelta(days=k)) in HOLIDAYS)
    if not n:
        return rel, None
    rel += dt.timedelta(days=n)
    while iso(rel) in HOLIDAYS or rel.weekday() >= 5:
        rel += dt.timedelta(days=1)
    return rel, "delayed: holiday-shortened week"


def trading_after(px, day):
    """First trading day on or after `day` with a settle."""
    keys = list(px)
    for k in keys:
        if k >= day:
            return keys.index(k)
    return None


def price_ctx(px, rel_day):
    keys = list(px)
    i = trading_after(px, rel_day)
    if i is None or i < 6 or i + 1 >= len(keys):
        return None
    s = lambda j: px[keys[j]]
    return {
        "date": keys[i],
        "settle": round(s(i), 2),
        "chg": round(s(i) - s(i - 1), 2),
        "chg_pct": round((s(i) / s(i - 1) - 1) * 100, 2),
        "next_date": keys[i + 1],
        "next_chg": round(s(i + 1) - s(i), 2),
        "next_chg_pct": round((s(i + 1) / s(i) - 1) * 100, 2),
        # The run into the print: the 5 sessions before release day.
        "run5_pct": round((s(i - 1) / s(i - 6) - 1) * 100, 2),
    }


def classify(x, classes):
    a = abs(x)
    for name, hi in classes:
        if hi is None or a < hi:
            return name
    return classes[-1][0]


def base_rates(xs, classes):
    names = [c[0] for c in classes]
    cnt = {n: 0 for n in names}
    for x in xs:
        cnt[classify(x, classes)] += 1
    return {n: round(cnt[n] / len(xs), 4) for n in names}, cnt


def build():
    S = {k: fetch(k) for k in SERIES}
    S["wti"] = yahoo("CL=F", "cl")
    S["ng"] = yahoo("NG=F", "ng")
    sp = yahoo("^GSPC", "spx")
    extra = json.load(open(API_CONSENSUS_PATH)) if os.path.exists(API_CONSENSUS_PATH) else {}
    extra = {k: v for k, v in extra.items() if not k.startswith("_")}
    regimes = {}
    for week, tag, src in REGIMES:
        regimes.setdefault(week, []).append({"tag": tag, "source": src})

    weeks = [w for w in S["crude"] if w >= START]
    allw = list(S["crude"])
    pet = []
    for w in weeks:
        i = allw.index(w)
        prev = allw[i - 1]
        need = ["gasoline", "distillate", "spr", "util", "runs", "prod", "imports", "exports"]
        if any(w not in S[k] or prev not in S[k] for k in need):
            continue
        rel, note = shift_release(w, 5)
        wti = price_ctx(S["wti"], iso(rel))
        if wti is None:
            continue  # need release day and the next session
        chg = lambda k: round((S[k][w] - S[k][prev]) / 1000, 3)  # kbbl -> MMbbl
        flow = lambda k: round(S[k][w] / 1000, 3)  # kb/d -> MMb/d
        dflow = lambda k: round((S[k][w] - S[k][prev]) / 1000, 3)
        # Trailing 8-week averages of the flows (prior weeks only).
        prior = allw[max(0, i - 8):i]
        avg8 = lambda k: round(sum(S[k][x] for x in prior if x in S[k]) / max(1, sum(1 for x in prior if x in S[k])) / 1000, 3)
        prod4 = allw[i - 4]
        crude = chg("crude")
        spr = chg("spr")
        # Contributions to this week's crude change from week-on-week flow changes (MMbbl/week).
        contrib = {
            "exports": round(-dflow("exports") * 7, 2),
            "imports": round(dflow("imports") * 7, 2),
            "runs": round(-dflow("runs") * 7, 2),
            "production": round(dflow("prod") * 7, 2),
        }
        if spr <= -1.0:
            contrib["spr"] = round(-spr, 2)  # SPR barrels released into the commercial system
        # The balancing item: what the reported flows don't explain (EIA "adjustment").
        implied = 7 * (flow("prod") + flow("imports") - flow("exports") - flow("runs")) - spr
        adj = round(crude - implied, 2)
        tags = list(regimes.get(w, []))
        if note:
            tags.append({"tag": "holiday", "source": f"Report {note} (release {iso(rel)})."})
        if spr <= -2.0:
            tags.append({"tag": "spr_release", "source": f"SPR stocks fell {abs(spr):.1f} MMbbl this week (EIA WCSSTUS1)."})
        ex = extra.get(w, {})
        sp_chg = None
        if wti["date"] in sp:
            k = list(sp)
            j = k.index(wti["date"])
            sp_chg = round((sp[k[j]] / sp[k[j - 1]] - 1) * 100, 2) if j > 0 else None
        pet.append({
            "id": f"fc-{w}",
            "week_ending": w,
            "release_date": iso(rel),
            "crude": crude, "gasoline": chg("gasoline"), "distillate": chg("distillate"),
            "crude_level": round(S["crude"][w] / 1000, 1),
            "class": classify(crude, PET_CLASSES),
            "class_gasoline": classify(chg("gasoline"), PET_CLASSES),
            "class_distillate": classify(chg("distillate"), PET_CLASSES),
            "util": round(S["util"][w], 1), "util_chg": round(S["util"][w] - S["util"][prev], 1),
            "runs": flow("runs"), "runs_chg": dflow("runs"),
            "prod": flow("prod"), "prod_chg": dflow("prod"), "prod_4wk_chg": round((S["prod"][w] - S["prod"][prod4]) / 1000, 3),
            "imports": flow("imports"), "imports_chg": dflow("imports"), "imports_avg8": avg8("imports"),
            "exports": flow("exports"), "exports_chg": dflow("exports"), "exports_avg8": avg8("exports"),
            "spr_chg": spr,
            "adjustment": adj,
            "contrib": contrib,
            "api": ex.get("api"), "consensus": ex.get("consensus"), "api_source": ex.get("source"),
            "regime": tags,
            "wti": wti,
            "spx_chg_pct": sp_chg,
            "source": f"EIA WPSR, week ending {w} (see sources.petroleum); WTI CL=F settle {wti['date']}",
        })

    # Gas: storage change, level, 5-year average change for the same week (prior 5 years only).
    G = S["gas"]
    gk = list(G)
    gas = []
    for w in gk:
        if w < START:
            continue
        i = gk.index(w)
        chg = round(G[w] - G[gk[i - 1]], 1)
        d = D(w)
        same = []
        lv = []
        for y in range(1, 6):
            target = d.replace(year=d.year - y)
            # nearest report week in that year
            best = min(gk[:i], key=lambda x: abs((D(x) - target).days))
            j = gk.index(best)
            if abs((D(best) - target).days) <= 4 and j > 0:
                same.append(G[best] - G[gk[j - 1]])
                lv.append(G[best])
        if len(same) < 5:
            continue
        rel, note = shift_release(w, 6, gas=True)
        ng = price_ctx(S["ng"], iso(rel))
        if ng is None:
            continue
        tags = []
        if note:
            tags.append({"tag": "holiday", "source": f"Report {note} (release {iso(rel)})."})
        for rw, tag, src in REGIMES:
            if rw == w and tag == "freeze":
                tags.append({"tag": tag, "source": src})
        gas.append({
            "id": f"fg-{w}",
            "week_ending": w,
            "release_date": iso(rel),
            "change": chg,
            "level": round(G[w], 0),
            "prev_change": round(G[gk[i - 1]] - G[gk[i - 2]], 1),
            "avg5_change": round(sum(same) / 5, 1),
            "avg5_level": round(sum(lv) / 5, 0),
            "class": classify(chg, GAS_CLASSES),
            "regime": tags,
            "ng": ng,
            "source": f"EIA WNGSR, week ending {w} (see sources.gas); Henry Hub NG=F settle {ng['date']}",
        })

    pr, pc = base_rates([x["crude"] for x in pet], PET_CLASSES)
    gr, gc = base_rates([x["change"] for x in gas], GAS_CLASSES)
    doc = {
        "_readme": "Built by scripts/build-forecast.py from EIA weekly data. Do not edit by hand. Base rates are computed from these records.",
        "sources": {
            "petroleum": "EIA Weekly Petroleum Status Report history (eia.gov/dnav/pet hist_xls): " + ", ".join(f"{k}={SERIES_ID[k]}" for k in ["crude", "gasoline", "distillate", "spr", "util", "runs", "prod", "imports", "exports"]) + ". Stock changes are week-on-week differences of the levels. WTI = NYMEX front-month daily settle via Yahoo Finance CL=F; S&P 500 via Yahoo ^GSPC. Release dates computed from EIA's schedule (Wednesday, moved for federal holidays). API/consensus: scripts/forecast-api-consensus.json, cited per week.",
            "gas": "EIA Weekly Natural Gas Storage Report history (eia.gov/dnav/ng hist_xls): Lower 48 working gas NW2_EPG0_SWO_R48_BCF. 5-year average = mean change for the same week over the prior five years, from the same series. Henry Hub = NYMEX front-month daily settle via Yahoo Finance NG=F. Release dates computed (Thursday, moved for federal holidays).",
        },
        "classes": {
            "petroleum_mmbbl": [{"name": n, "max": hi} for n, hi in PET_CLASSES],
            "gas_bcf": [{"name": n, "max": hi} for n, hi in GAS_CLASSES],
        },
        "base_rates": {"crude": pr, "crude_counts": pc, "gas": gr, "gas_counts": gc},
        "petroleum": pet,
        "gas": gas,
    }
    out = os.path.join(DATA, "forecast.json")
    json.dump(doc, open(out, "w"), separators=(",", ":"))
    open(out, "a").write("\n")
    print(f"petroleum weeks {len(pet)} ({pet[0]['week_ending']}..{pet[-1]['week_ending']}), gas weeks {len(gas)}")
    print("crude base rates", pr, pc)
    print("gas base rates", gr, gc)


if __name__ == "__main__":
    build()
