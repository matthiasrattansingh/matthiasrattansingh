#!/usr/bin/env python3
"""Download real 5-minute bars for REPLAY DESK and bake them into /data.

Usage:  pip install yfinance  &&  python3 scripts/fetch_replay_data.py

* Pulls the last 60 days of 5-minute bars from Yahoo Finance (yfinance) for
  CL=F, BZ=F, NG=F, RB=F and HO=F.
* Keeps the last 10 *completed* trading days (Chicago dates whose 14:30 CT pit
  close has already passed and whose bars cover the session).
* Writes data/<SYMBOL>.json  (one file per product) and data/manifest.json.
* If a product fails to download it is reported and skipped. Nothing is ever
  synthesised: every bar in /data is exactly what Yahoo returned.

Note: Yahoo continuous futures (CL=F etc.) roll to the next contract month on
their own schedule, so a roll day can show a price gap. That is the real data.
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import yfinance as yf

CT = ZoneInfo("America/Chicago")
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data"
DAYS_TO_KEEP = 10
SESSION_OPEN = (7, 0)    # 07:00 CT
SESSION_CLOSE = (14, 30)  # 14:30 CT

PRODUCTS = {
    "CL": {"ticker": "CL=F", "name": "WTI Crude Oil", "decimals": 2},
    "BZ": {"ticker": "BZ=F", "name": "Brent Crude Oil", "decimals": 2},
    "NG": {"ticker": "NG=F", "name": "Henry Hub Natural Gas", "decimals": 3},
    "RB": {"ticker": "RB=F", "name": "RBOB Gasoline", "decimals": 4},
    "HO": {"ticker": "HO=F", "name": "NY Harbor ULSD (Heating Oil)", "decimals": 4},
}


def fetch(symbol: str, ticker: str) -> dict | None:
    df = yf.download(ticker, period="60d", interval="5m", auto_adjust=False,
                     progress=False, prepost=True, threads=False)
    if df is None or df.empty:
        print(f"[FAIL] {symbol} ({ticker}): no data returned", file=sys.stderr)
        return None
    if getattr(df.columns, "nlevels", 1) > 1:  # yfinance >=0.2.4x returns MultiIndex
        df.columns = df.columns.get_level_values(0)
    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    idx = df.index
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    df.index = idx.tz_convert(CT)

    dp = PRODUCTS[symbol]["decimals"]
    now_ct = datetime.now(CT)
    # a day is "completed" once its 14:30 CT pit close has passed
    last_done = now_ct.date() if (now_ct.hour, now_ct.minute) >= SESSION_CLOSE else None
    days: dict[str, list] = {}
    for ts, row in df.iterrows():
        d = ts.date()
        if d > now_ct.date() or (d == now_ct.date() and last_done is None):
            continue  # session not finished yet
        mins = ts.hour * 60 + ts.minute
        if not (SESSION_OPEN[0] * 60 + SESSION_OPEN[1] <= mins < SESSION_CLOSE[0] * 60 + SESSION_CLOSE[1]):
            continue
        days.setdefault(d.isoformat(), []).append({
            "t": int(ts.timestamp()),
            "time": ts.strftime("%H:%M"),
            # rounding to the product's tick precision only strips float32 noise
            # (e.g. 101.13999938964844 -> 101.14); real prices are tick multiples
            "o": round(float(row["Open"]), dp), "h": round(float(row["High"]), dp),
            "l": round(float(row["Low"]), dp), "c": round(float(row["Close"]), dp),
            "v": int(row["Volume"]) if row["Volume"] == row["Volume"] else 0,
        })
    # a completed pit session must reach the last bar (14:25 CT)
    complete = {d: b for d, b in days.items()
                if b and b[-1]["time"] >= "14:00" and len(b) >= 60}
    keep = sorted(complete)[-DAYS_TO_KEEP:]
    if not keep:
        print(f"[FAIL] {symbol}: no completed sessions in download", file=sys.stderr)
        return None
    return {
        "symbol": symbol,
        "ticker": ticker,
        "name": PRODUCTS[symbol]["name"],
        "source": "Yahoo Finance via yfinance, 5m bars, continuous front-month",
        "timezone": "America/Chicago",
        "session": "07:00-14:30 CT",
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "fields": "t=bar open (unix seconds UTC), time=bar open HH:MM CT, o/h/l/c, v=volume",
        "days": {d: complete[d] for d in keep},
    }


def main() -> int:
    OUT.mkdir(exist_ok=True)
    manifest = {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "products": {}, "failed": {}}
    for symbol, meta in PRODUCTS.items():
        try:
            data = fetch(symbol, meta["ticker"])
        except Exception as exc:  # report and continue
            print(f"[FAIL] {symbol} ({meta['ticker']}): {exc}", file=sys.stderr)
            data = None
        if data is None:
            manifest["failed"][symbol] = meta["ticker"]
            continue
        (OUT / f"{symbol}.json").write_text(json.dumps(data, separators=(",", ":")))
        manifest["products"][symbol] = {
            "file": f"{symbol}.json", "ticker": meta["ticker"], "name": meta["name"],
            "days": list(data["days"].keys()),
            "bars": sum(len(v) for v in data["days"].values()),
        }
        print(f"[OK]   {symbol}: {len(data['days'])} days, "
              f"{manifest['products'][symbol]['bars']} bars "
              f"({list(data['days'])[0]} .. {list(data['days'])[-1]})")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2))
    if manifest["failed"]:
        print(f"Failed products: {manifest['failed']}", file=sys.stderr)
    return 0 if manifest["products"] else 1


if __name__ == "__main__":
    sys.exit(main())
