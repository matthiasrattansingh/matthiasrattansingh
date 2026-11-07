#!/usr/bin/env python3
"""Add SCHEDULER decisions to the cargo and tank cards (idempotent: replaces `scheduler`).

Usage (from tape/):  python3 scripts/add-scheduler.py

Values use economics.json (demurrage, quality penalty, cargo size) and each card's own
charter rate and capacity; anything else is a labeled assumption in the option's `calc`.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "src", "data")
E = json.load(open(os.path.join(DATA, "economics.json")))
BBL = E["cargo"]["default_bbl"]["value"]
DEM = E["cargo"]["demurrage_usd_day"]["value"]
QPEN = E["cargo"]["quality_penalty_usd_bbl"]["value"]
CAP = E["tank"]["capacity_bbl"]["value"]

CARGO = {
    "cg-floating-storage-2020": lambda c: [{
        "id": "roll", "day": 2, "title": "Scheduler: roll the cargo a month?",
        "prompt": "Your buyer offers $0.40/bbl to take delivery in July instead of June. Super-contango pays to wait.",
        "options": [
            {"label": "Roll to July for +$0.40/bbl", "later": {"day": 8, "usd": round(c["cargo"]["bbl"] * 0.40 - 5 * c["charter_usd_day"]), "text": "Roll paid, but you kept the ship 5 more days",
                                                               "calc": f"{c['cargo']['bbl'] // 1000}k × $0.40 − 5 days × ${c['charter_usd_day']:,} charter"}},
            {"label": "Keep June delivery", "later": {"day": 8, "usd": 0, "text": "Delivered on the June schedule"}},
        ]}],
    "cg-diesel-squeeze-2022": lambda c: [{
        "id": "blend", "day": 2, "title": "Scheduler: blend the slop tank in?",
        "prompt": "You have 50k bbl of high-sulfur diesel in tank. Blend it into the cargo and sell it at full value?",
        "options": [
            {"label": "Blend it in", "now": {"usd": 100000, "text": "Slop sold at cargo value (50k × $2 uplift)"},
             "later": {"day": 9, "usd": -round(c["cargo"]["bbl"] * QPEN), "text": "Inspector at discharge: cargo off-spec on sulfur",
                       "calc": f"{c['cargo']['bbl'] // 1000}k × ${QPEN} quality penalty (economics.json)"}},
            {"label": "Keep the cargo clean", "later": {"day": 9, "usd": 0, "text": "Cargo passed inspection"}},
        ]}],
    "cg-texas-freeze-2021": lambda c: [{
        "id": "tank", "day": 2, "title": "Scheduler: book shore tank at discharge?",
        "prompt": "Houston refineries are wobbling. Book 3 days of shore tank for $60k, or deliver straight into the refinery?",
        "options": [
            {"label": "Book shore tank ($60k)", "now": {"usd": -60000, "text": "Shore tank booked"}, "later": {"day": 6, "usd": 0, "text": "Discharged into tank while the refinery was frozen"}},
            {"label": "Deliver straight to the refinery", "later": {"day": 6, "usd": -3 * DEM, "text": "Refinery couldn't take barrels: 3 days waiting",
                                                                    "calc": f"3 days × ${DEM:,} demurrage (economics.json)"}},
        ]}],
}

TANK = {
    "tk-super-contango-2020": [{
        "id": "pumpover", "day": 1, "title": "Scheduler: Cushing pumpover nomination",
        "prompt": "Lock pumpover (in/out of tank) at $0.05/bbl for the next two months, or pay spot when you move barrels?",
        "options": [
            {"label": "Lock at $0.05/bbl", "now": {"usd": -round(CAP * 0.05), "text": "Pumpover locked"}},
            {"label": "Pay spot later", "later": {"day": 5, "usd": -round(CAP * 0.25), "text": "Spot pumpover as Cushing filled",
                                                  "calc": f"{CAP // 1000}k × $0.25 spot pumpover (assumed as tanks filled)"}},
        ]}],
    "tk-thin-carry-2015": [{
        "id": "lease", "day": 1, "title": "Scheduler: renew the tank lease",
        "prompt": "Renew six months at $0.40/bbl/month, or go month-to-month at $0.45?",
        "options": [
            {"label": "Six months at $0.40", "later": {"day": 9, "usd": -round(CAP * 0.40 * 4), "text": "Paid the term lease after the carry dried up",
                                                       "calc": f"{CAP // 1000}k × $0.40 × 4 months left on the term after you're done (assumed)"}},
            {"label": "Month-to-month at $0.45", "later": {"day": 9, "usd": -round(CAP * 0.05 * 2), "text": "Paid the month-to-month premium",
                                                           "calc": f"{CAP // 1000}k × $0.05 × 2 months"}},
        ]}],
    "tk-backwardation-2021": [{
        "id": "heels", "day": 2, "title": "Scheduler: sell your tank heels?",
        "prompt": "A refiner wants your 50k bbl tank bottoms at +$0.50 over spot. The tank then needs re-commissioning.",
        "options": [
            {"label": "Sell the heels", "now": {"usd": 25000, "text": "Heels sold at +$0.50"},
             "later": {"day": 6, "usd": -40000, "text": "Tank re-commissioning", "calc": "Cleaning + inspection, $40k (assumed)"}},
            {"label": "Keep them", "later": {"day": 6, "usd": 0, "text": "Tank stayed in service"}},
        ]}],
}


def main():
    for f, table, key in (("cargo.json", CARGO, "days"), ("tank.json", TANK, "weekly")):
        path = os.path.join(DATA, f)
        doc = json.load(open(path))
        for c in doc["cards"]:
            if c["id"] in table:
                v = table[c["id"]]
                c["scheduler"] = v(c) if callable(v) else v
        json.dump(doc, open(path, "w"), indent=1 if f == "tank.json" else 2, ensure_ascii=False)  # keep each file's style
        open(path, "a").write("\n")
        print(f, [(c["id"], [x["id"] for x in c.get("scheduler", [])]) for c in doc["cards"]])


if __name__ == "__main__":
    main()
