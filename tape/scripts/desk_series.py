"""Series for the DESK scenarios: real EIA daily spot prices + modeled paths through cited anchors.

Real (EIA daily spot, eia.gov/dnav hist_xls): RWTC (WTI Cushing), RBRTE (Brent),
EER_EPMRU_PF4_Y35NY_DPG / _RGC_DPG (NYH / USGC conventional gasoline, $/gal),
EER_EPD2DXL0_PF4_Y35NY_DPG / _RGC_DPG (NYH / USGC ULSD, $/gal), RNGWHHD (Henry Hub, $/MMBtu),
WCSSTUS1 (SPR stocks, weekly). NYMEX natural gas front month (NG=F) via Yahoo Finance.
Modeled: piecewise-linear between dated anchors; every anchor carries its source, and
assumptions are labeled as such.
"""
import datetime as dt
import json, os, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".eia-cache")
PET = "https://www.eia.gov/dnav/pet/hist_xls/{}.xls"
EIA = {
    "wti": (PET.format("RWTCd"), "RWTC"), "brent": (PET.format("RBRTEd"), "RBRTE"),
    "gas_nyh": (PET.format("EER_EPMRU_PF4_Y35NY_DPGd"), "EER_EPMRU_PF4_Y35NY_DPG"),
    "gas_usgc": (PET.format("EER_EPMRU_PF4_RGC_DPGd"), "EER_EPMRU_PF4_RGC_DPG"),
    "ulsd_nyh": (PET.format("EER_EPD2DXL0_PF4_Y35NY_DPGd"), "EER_EPD2DXL0_PF4_Y35NY_DPG"),
    "ulsd_usgc": (PET.format("EER_EPD2DXL0_PF4_RGC_DPGd"), "EER_EPD2DXL0_PF4_RGC_DPG"),
    "hh": ("https://www.eia.gov/dnav/ng/hist_xls/RNGWHHDd.xls", "RNGWHHD"),
    "spr": (PET.format("WCSSTUS1w"), "WCSSTUS1"),
}


def eia(key):
    import xlrd
    url, _ = EIA[key]
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"spot_{key}.xls")
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (TAPE build script)"})
        open(path, "wb").write(urllib.request.urlopen(req, timeout=60).read())
    wb = xlrd.open_workbook(path)
    sh = wb.sheet_by_name("Data 1")
    out = {}
    for r in range(3, sh.nrows):
        v = sh.cell_value(r, 1)
        if v != "":
            out[xlrd.xldate_as_datetime(sh.cell_value(r, 0), wb.datemode).strftime("%Y-%m-%d")] = float(v)
    return dict(sorted(out.items()))


def yahoo(sym, name, start=dt.datetime(2020, 11, 1)):
    path = os.path.join(CACHE, f"desk_{name}.json")
    if not os.path.exists(path):
        p1, p2 = int(start.timestamp()), int(dt.datetime.now().timestamp())
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(sym)}?period1={p1}&period2={p2}&interval=1d"
        raw = json.loads(urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=60).read())
        r = raw["chart"]["result"][0]
        out = {}
        for t, c in zip(r["timestamp"], r["indicators"]["quote"][0]["close"]):
            if c is not None:
                out[dt.datetime.fromtimestamp(t, dt.timezone(dt.timedelta(hours=-4))).strftime("%Y-%m-%d")] = round(c, 3)
        json.dump(out, open(path, "w"))
    return json.load(open(path))


def on_or_before(series, d):
    best = None
    for k, v in series.items():
        if k <= d:
            best = v
        else:
            break
    return best


def trading_days(start, end):
    return [d for d in eia("wti") if start <= d <= end]


def real(key, days, scale=1.0, label=None, unit="$/bbl", source=None):
    s = eia(key) if key in EIA else None
    vals = [round(on_or_before(s, d) * scale, 3) for d in days]
    return {"label": label or key, "unit": unit, "kind": "real", "values": vals,
            "source": source or f"EIA daily spot {EIA[key][1]}" + (" ($/gal × 42)" if scale == 42 else "")}


def derived(a, b, label, source):
    return {"label": label, "unit": a["unit"], "kind": "real" if a["kind"] == b["kind"] == "real" else "modeled",
            "values": [round(x - y, 3) for x, y in zip(a["values"], b["values"])], "source": source}


def modeled(days, anchors, label, unit="$/bbl", note=""):
    """anchors: [(date, value, source)] → piecewise-linear by calendar day, clamped at the ends."""
    pts = [(dt.date.fromisoformat(a), v) for a, v, _ in anchors]
    vals = []
    for d in days:
        x = dt.date.fromisoformat(d)
        if x <= pts[0][0]:
            v = pts[0][1]
        elif x >= pts[-1][0]:
            v = pts[-1][1]
        else:
            for (x0, v0), (x1, v1) in zip(pts, pts[1:]):
                if x0 <= x <= x1:
                    v = v0 + (v1 - v0) * (x - x0).days / max(1, (x1 - x0).days)
                    break
        vals.append(round(v, 3))
    return {"label": label, "unit": unit, "kind": "modeled", "values": vals,
            "anchors": [{"date": a, "value": v, "source": s} for a, v, s in anchors],
            "source": "Modeled: straight lines between the dated anchors listed (each cited). " + note}
