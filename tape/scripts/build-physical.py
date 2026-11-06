#!/usr/bin/env python3
"""Fill real settlement data into the physical-trading scenarios.

Usage (from tape/):  python3 scripts/build-physical.py

- cargo.json: 'days' = the next N trading days from 'start' with the benchmark's
  front-month settlement (products converted $/gal -> $/bbl). Uses the same Yahoo
  OHLC cache as build-sessions.py (scripts/.ohlc-cache/).
- tank.json: weekly steps (EIA release Wednesdays) with the real NYMEX WTI curve
  (contracts 1-4, EIA series RCLC1-4) and the real weekly EIA prints (Cushing and
  US commercial crude stocks). Downloads EIA files once into scripts/.eia-cache/.
"""
import json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "src", "data")
sys.path.insert(0, HERE)


def _ohlc(sym):
    path = os.path.join(HERE, ".ohlc-cache", f"{sym}.json")
    if not os.path.exists(path):
        raise SystemExit(f"missing {path}: run scripts/build-sessions.py first to download OHLC")
    return json.load(open(path))


def build_cargo():
    path = os.path.join(DATA, "cargo.json")
    doc = json.load(open(path))
    for card in doc["cards"]:
        sym = card["bench"]["symbol"]
        data = _ohlc(sym)
        dates = sorted(d for d in data if d >= card["start"])[: card["steps"]]
        mult = 42 if sym in ("HO", "RB") else 1
        card["days"] = [{"date": d, "flat": round(data[d][3] * mult, 2)} for d in dates]
        print(f"{card['id']:28s} {len(dates)} days {dates[0]} -> {dates[-1]}")
    json.dump(doc, open(path, "w"), indent=1, ensure_ascii=False)


# ---------------- EIA (tank sessions) ----------------
EIA = {
    "c1": "https://www.eia.gov/dnav/pet/hist_xls/RCLC1d.xls",
    "c2": "https://www.eia.gov/dnav/pet/hist_xls/RCLC2d.xls",
    "c3": "https://www.eia.gov/dnav/pet/hist_xls/RCLC3d.xls",
    "c4": "https://www.eia.gov/dnav/pet/hist_xls/RCLC4d.xls",
    "cushing": "https://www.eia.gov/dnav/pet/hist_xls/W_EPC0_SAX_YCUOK_MBBLw.xls",
    "us": "https://www.eia.gov/dnav/pet/hist_xls/WCESTUS1w.xls",
}


def eia(key):
    import xlrd  # pip install xlrd
    cache = os.path.join(HERE, ".eia-cache")
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"{key}.xls")
    if not os.path.exists(path):
        req = urllib.request.Request(EIA[key], headers={"User-Agent": "Mozilla/5.0 (TAPE build script)"})
        open(path, "wb").write(urllib.request.urlopen(req).read())
    wb = xlrd.open_workbook(path)
    sh = wb.sheet_by_name("Data 1")
    out = {}
    for r in range(3, sh.nrows):
        v = sh.cell_value(r, 1)
        if v == "":
            continue
        out[xlrd.xldate_as_datetime(sh.cell_value(r, 0), wb.datemode).strftime("%Y-%m-%d")] = float(v)
    return out


def cl_expiry(year, month):
    """Last trading day of the NYMEX WTI contract for delivery month (year, month):
    3 business days before the 25th of the prior month (4 if the 25th is not a business day).
    Exchange holidays are ignored (close enough for weekly steps)."""
    import datetime
    y, m = (year, month - 1) if month > 1 else (year - 1, 12)
    d = datetime.date(y, m, 25)
    back = 3 if d.weekday() < 5 else 4
    while back:
        d -= datetime.timedelta(days=1)
        if d.weekday() < 5:
            back -= 1
    return d


def front_month(date):
    """(year, month) of contract 1 trading on `date`."""
    import datetime
    d = datetime.date.fromisoformat(date)
    y, m = d.year, d.month
    for _ in range(3):
        if cl_expiry(y, m) >= d:
            return y, m
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    raise ValueError(date)


def months_from(date, n=4):
    y, m = front_month(date)
    out = []
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    return out


def on_or_before(series, date):
    keys = [d for d in series if d <= date]
    return series[max(keys)] if keys else None


def build_tank():
    path = os.path.join(DATA, "tank.json")
    if not os.path.exists(path):
        return
    import datetime
    doc = json.load(open(path))
    curve = {k: eia(k) for k in ("c1", "c2", "c3", "c4")}
    cush, us = eia("cushing"), eia("us")
    for card in doc["cards"]:
        d = datetime.date.fromisoformat(card["start"])
        while d.weekday() != 2:  # Wednesday: EIA release day
            d += datetime.timedelta(days=1)
        weeks = []
        for w in range(card["weeks"]):
            day = (d + datetime.timedelta(weeks=w)).isoformat()
            # EIA reports the week ending the previous Friday.
            wk_end = (d + datetime.timedelta(weeks=w) - datetime.timedelta(days=5)).isoformat()
            prev_end = (datetime.date.fromisoformat(wk_end) - datetime.timedelta(days=7)).isoformat()
            c = [round(on_or_before(curve[k], day), 2) for k in ("c1", "c2", "c3", "c4")]
            # Settlements are for the last trading day on or before `day`; label months as of that day.
            settle_day = max(x for x in curve["c1"] if x <= day)
            ch = round((cush[wk_end] - cush[prev_end]) / 1000, 2) if wk_end in cush and prev_end in cush else None
            uh = round((us[wk_end] - us[prev_end]) / 1000, 2) if wk_end in us and prev_end in us else None
            weeks.append({"date": day, "curve": c, "months": months_from(settle_day), "eia": {"week_ending": wk_end, "cushing_mmbbl": ch, "us_mmbbl": uh,
                                                             "cushing_level_mmbbl": round(cush.get(wk_end, 0) / 1000, 1)}})
        card["weekly"] = weeks
        print(f"{card['id']:28s} {len(weeks)} weeks {weeks[0]['date']} -> {weeks[-1]['date']}")
    json.dump(doc, open(path, "w"), indent=1, ensure_ascii=False)


if __name__ == "__main__":
    build_cargo()
    build_tank()
