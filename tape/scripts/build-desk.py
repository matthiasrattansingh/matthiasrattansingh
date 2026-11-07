#!/usr/bin/env python3
"""Build the DESK scenarios (src/data/desk.json): physical dislocations as 8-12 feed cards.

Usage (from tape/):  python3 scripts/build-desk.py

Each scenario has trading days, series (real EIA daily spot where it exists, modeled paths
through cited anchors where it doesn't), and steps: news, idea cards, scheduler decisions and
rival pitches (the pitches are generated in the app by each bot's rules, from data up to that
day only). Decision consequences are computed here from the series or from labeled assumptions,
and each carries its calculation.
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from desk_series import derived, modeled, on_or_before, real, trading_days, yahoo, eia  # noqa: E402

DATA = os.path.join(HERE, "..", "src", "data")
G = 42  # $/gal -> $/bbl


def money(x):
    return f"{'+' if x >= 0 else '−'}${abs(round(x)):,}"


def scen_colonial():
    days = trading_days("2021-05-03", "2021-05-18")
    nyh = real("gas_nyh", days, G, "NYH gasoline")
    usgc = real("gas_usgc", days, G, "USGC gasoline")
    S = {
        "gas_nyh": nyh, "gas_usgc": usgc,
        "nyh_usgc": derived(nyh, usgc, "NYH − USGC gasoline", "EIA daily spot: NYH minus USGC conventional gasoline, $/gal × 42"),
        "jones_mr": modeled(days, [
            ("2021-05-03", 30000, "Assumption: pre-shutdown Jones Act MR level (no public daily print)"),
            ("2021-05-07", 32000, "Assumption: Colonial shut late on May 7"),
            ("2021-05-12", 50000, "S&P Global, 13 May 2021: Jones Act MR TCE ~$50,000/day USGC-New York on May 12, per a Jones Act broker"),
            ("2021-05-18", 38000, "Assumption: brokers expected rates to ease once the line restarted (S&P Global, 13 May 2021)"),
        ], "Jones Act MR tanker", "$/day"),
    }
    d = {x: i for i, x in enumerate(days)}
    spread = S["nyh_usgc"]["values"]
    hold = round(150_000 * (spread[d["2021-05-13"]] - 1.90 - 0.25))
    steps = [
        {"kind": "news", "day": 0, "headline": "Gulf gasoline $2.23/bbl under New York", "text": "Colonial moves ~2.5 MMb/d of fuel from Houston to Linden. The spread is roughly its tariff.", "series": ["nyh_usgc"]},
        {"kind": "idea", "day": 1, "type": "location_arb", "title": "Ship Gulf gasoline to New York on a Jones Act MR",
         "pitch": "Buy 300k bbl at Houston, fix a US-flag MR for 8 days, sell NY Harbor on arrival. Spread $3.15 vs ~$1.40 to move it.",
         "bbl": 300000, "horizon": 8,
         "legs": [{"series": "gas_usgc", "side": "buy", "at": "entry", "label": "Buy USGC gasoline"},
                  {"series": "gas_nyh", "side": "sell", "at": "exit", "label": "Sell NYH on arrival"}],
         "costs": [{"label": "Jones Act MR, 8 days", "freight": {"rate": "jones_mr", "days": 8}},
                   {"label": "Terminal in/out (assumed)", "usd_bbl": 0.30},
                   {"label": "Financing", "financing": {"pct": 0.02, "on": "gas_usgc"}}],
         "killers": ["Flat price drops while you're on the water: this is unhedged", "Freight spikes before you fix the ship", "NYH premium collapses when the line restarts"]},
        {"kind": "pitch", "day": 2, "by": "mo"},
        {"kind": "news", "day": 4, "headline": "Colonial shuts all 5,500 miles after ransomware attack", "text": "The East Coast's main fuel artery is down. Every Jones Act product tanker on the Gulf gets booked.", "series": ["nyh_usgc", "jones_mr"]},
        {"kind": "decision", "day": 4, "title": "Scheduler: your Cycle 27 line space", "prompt": "150k bbl nominated Houston → Linden can't move. Hold the nomination for the restart, or release it and sell at Houston?",
         "options": [
             {"label": "Hold nomination, keep barrels in tank", "later": {"day": d["2021-05-13"], "usd": hold, "text": "Line restarted; your 150k bbl shipped and sold NYH", "calc": f"150k × (NYH−USGC ${spread[d['2021-05-13']]:.2f} − tariff $1.90 − tankage $0.25, both assumed)"}},
             {"label": "Release it, sell at Houston now", "now": {"usd": 0, "text": "Sold at Houston spot: no spread, no tankage"}, "later": {"day": d["2021-05-13"], "usd": 0, "text": "Line restarted without you: missed the cycle", "calc": "No exposure, no spread captured"}},
         ]},
        {"kind": "idea", "day": 5, "type": "freight", "title": "Charter a Jones Act MR for 30 days",
         "pitch": "The pipe is down; ships are the only way north. Take an MR on time charter now and relet it as rates climb.",
         "bbl": 300000, "horizon": 5,
         "legs": [{"series": "jones_mr", "side": "buy", "at": "entry", "qty": 30, "label": "Hire 30 days"},
                  {"series": "jones_mr", "side": "sell", "at": "exit", "qty": 30, "label": "Relet 30 days"}],
         "costs": [{"label": "Broker commission 1.25% (assumed)", "usd": 0.0125 * 30 * 32000}],
         "killers": ["The line restarts fast and every charterer cancels", "Jones Act waivers let foreign ships in", "You can't find a relet: you're stuck paying hire"]},
        {"kind": "news", "day": 7, "headline": "Colonial restarts; full service in days", "text": "Fuel starts moving again late May 12. Panic buying left gas stations dry across the Southeast.", "series": ["nyh_usgc", "jones_mr"]},
        {"kind": "pitch", "day": 8, "by": "dan"},
        {"kind": "decision", "day": 9, "title": "Scheduler: berth at Linden", "prompt": "Your MR arrives into a queue. Pay $40k to jump to an open berth, or wait out a 2-day line?",
         "options": [
             {"label": "Pay $40k priority berth", "now": {"usd": -40000, "text": "Priority berth fee"}, "later": {"day": 10, "usd": 0, "text": "Discharged on arrival: no demurrage"}},
             {"label": "Wait in the queue", "later": {"day": 11, "usd": -2 * 50000, "text": "2 days of demurrage", "calc": "2 days × $50k/day (Jones Act MR rate that week)"}},
         ]},
        {"kind": "news", "day": 11, "headline": "Spread ends at $4.28: the ships, not the pipe, set the price", "text": "Gulf to NY gasoline widened ~$2/bbl. Freight took most of it.", "series": ["nyh_usgc", "jones_mr"]},
    ]
    return {
        "id": "dsk-colonial-2021", "title": "Colonial Pipeline shutdown, May 2021", "date": days[0],
        "open": "The East Coast's fuel pipe just went dark.",
        "why": "Colonial carries ~45% of East Coast fuel. When it shut, the only way north was Jones Act tankers, so freight, not the barrel spread, captured the dislocation. EIA spot shows the NYH-Gulf gasoline spread widening only ~$2/bbl while MR earnings jumped to ~$50k/day.",
        "source": "EIA daily spot NYH and USGC conventional gasoline; S&P Global (13 May 2021) Jones Act MR ~$50k/day; Colonial Pipeline statements 7-15 May 2021.",
        "concept": "cb-freight", "days": days, "series": S, "chart": ["nyh_usgc", "jones_mr"], "steps": steps,
        "pitchable": {"nyh_usgc": {"qty": 300000, "fee": 0.15}, "jones_mr": {"qty": 30, "fee": 500}},
    }


def scen_uri():
    days = trading_days("2021-02-08", "2021-02-24")
    ng = yahoo("NG=F", "ng21")
    hh = real("hh", days, 1, "Henry Hub spot", "$/MMBtu")
    fut = {"label": "NYMEX gas front month", "unit": "$/MMBtu", "kind": "real", "values": [on_or_before(ng, x) for x in days], "source": "NYMEX natural gas front-month settle (Yahoo Finance NG=F)"}
    wti = real("wti", days, 1, "WTI Cushing")
    ulsd = real("ulsd_usgc", days, G, "USGC ULSD")
    S = {
        "hh": hh, "ng_fut": fut, "wti": wti, "ulsd_usgc": ulsd,
        "hh_fut": derived(hh, fut, "Henry Hub spot − futures", "EIA RNGWHHD minus NYMEX front month"),
        "crack": derived(ulsd, wti, "USGC diesel crack", "EIA daily spot: USGC ULSD ($/gal × 42) minus WTI Cushing"),
        "midland": modeled(days, [
            ("2021-02-08", 0.95, "Assumption: ~$1 premium to WTI in early Feb (no public daily Midland print)"),
            ("2021-02-17", 1.22, "Reuters/Argus: Midland hit an 11-month-high $1.22 premium in February 2021"),
            ("2021-02-24", 1.08, "Reuters/Argus: Midland averaged a $1.08 premium in March 2021"),
        ], "WTI Midland vs Cushing"),
    }
    d = {x: i for i, x in enumerate(days)}
    steps = [
        {"kind": "news", "day": 1, "headline": "Arctic blast heads for Texas", "text": "Forecasts show single digits in Midland and Houston. Gas demand for heat will spike.", "series": ["hh", "ng_fut"]},
        {"kind": "idea", "day": 3, "type": "storage", "title": "Pull your gas out of storage, sell it today",
         "pitch": "You hold 1 Bcf at a Gulf salt cavern. Spot pays more than March futures: sell spot, buy the futures back.",
         "bbl": 1000000, "unit": "MMBtu", "horizon": 1,
         "legs": [{"series": "hh", "side": "sell", "at": "entry", "label": "Sell Henry Hub spot"},
                  {"series": "ng_fut", "side": "buy", "at": "entry", "label": "Buy March futures back"}],
         "costs": [{"label": "Withdrawal fee (assumed $0.02/MMBtu)", "usd_bbl": 0.02}],
         "killers": ["Pipes freeze and you can't deliver what you sold", "Spot goes higher tomorrow: you sold too early", "Futures spike and your buyback costs more"]},
        {"kind": "news", "day": 5, "headline": "ERCOT blackouts; ~6 MMb/d of refining offline", "text": "IHS Markit: Storm Uri hit nearly 6 million b/d of US refining. Permian wells freeze.", "series": ["crack", "midland"]},
        {"kind": "decision", "day": 5, "title": "Scheduler: Midland → Cushing nomination", "prompt": "Nominations due 10am. You hold 50k b/d of line space, but frozen wells give you ~20k b/d.",
         "options": [
             {"label": "Nominate the full 50k b/d", "later": {"day": d["2021-02-22"], "usd": -round(30000 * 7 * 0.45), "text": "Ship-or-pay on 30k b/d you couldn't fill", "calc": "30k b/d × 7 days × $0.45 tariff (assumed) deficiency"}},
             {"label": "Cut to 20k b/d", "later": {"day": d["2021-02-23"], "usd": -round(50000 * 0.15 * 30 * 0.30), "text": "Line history cut 15%: less space next month", "calc": "7.5k b/d × 30 days × $0.30/bbl lost margin (assumed)"}},
         ]},
        {"kind": "idea", "day": 5, "type": "quality", "title": "Long the Gulf diesel crack",
         "pitch": "Refineries froze; diesel will be short when demand comes back. Buy USGC ULSD vs WTI.",
         "bbl": 200000, "horizon": 4,
         "legs": [{"series": "crack", "side": "buy", "at": "entry", "label": "Buy diesel crack"},
                  {"series": "crack", "side": "sell", "at": "exit", "label": "Sell it back"}],
         "costs": [{"label": "Execution, both legs", "usd_bbl": 0.10}],
         "killers": ["Refineries restart faster than expected", "Crude rallies faster than diesel", "Demand stays frozen with the roads"]},
        {"kind": "news", "day": 6, "headline": "Henry Hub cash prints $23.86", "text": "Spot gas at Henry Hub hits $23.86/MMBtu while March futures sit near $3.20.", "series": ["hh", "ng_fut"]},
        {"kind": "pitch", "day": 6, "by": "dan"},
        {"kind": "idea", "day": 6, "type": "location_arb", "title": "Buy Midland, ship to Cushing",
         "pitch": "Permian is frozen, Cushing looks cheap. Buy Midland, pay the tariff, sell Cushing in 3 days (hedged).",
         "bbl": 200000, "horizon": 3,
         "legs": [{"series": "midland", "side": "buy", "at": "entry", "label": "Buy Midland (diff to WTI)"},
                  {"series": "zero", "side": "sell", "at": "exit", "label": "Sell Cushing (WTI flat)"}],
         "costs": [{"label": "Midland→Cushing tariff (assumed)", "usd_bbl": 0.45}],
         "killers": ["Midland trades at a premium: the arb runs the wrong way", "Wells thaw and Midland sags", "Line space is prorated"]},
        {"kind": "pitch", "day": 8, "by": "quinn"},
        {"kind": "news", "day": 9, "headline": "Thaw: Henry Hub back at $3.16", "text": "Spot gas collapses back to the futures. Refineries restart over the next weeks.", "series": ["hh", "crack"]},
    ]
    S["zero"] = {"label": "Cushing (diff to WTI)", "unit": "$/bbl", "kind": "real", "values": [0.0] * len(days), "source": "WTI Cushing is the benchmark: its differential to itself is zero"}
    return {
        "id": "dsk-uri-freeze-2021", "title": "Winter Storm Uri, February 2021", "date": days[0],
        "open": "Texas is freezing. Gas cash is vertical.",
        "why": "Uri froze wells, pipes and refineries at once. Henry Hub spot went from $3.76 to $23.86 and back to $3.16 in eight sessions while NYMEX futures barely moved: storage you could actually withdraw was the asset. Diesel cracks widened as ~6 MMb/d of refining went offline.",
        "source": "EIA daily spot (Henry Hub RNGWHHD, WTI RWTC, USGC ULSD); NYMEX gas front month via Yahoo; IHS Markit (Feb 2021) ~6 MMb/d refining affected; Reuters/Argus Midland differentials.",
        "concept": "cb-shut-ins", "days": days, "series": S, "chart": ["hh", "ng_fut", "crack"], "steps": steps,
        "pitchable": {"hh_fut": {"qty": 100000, "fee": 0.01}, "crack": {"qty": 200000, "fee": 0.10}},
    }


def scen_keystone():
    days = trading_days("2022-12-05", "2022-12-20")
    wti = real("wti", days, 1, "WTI Cushing")
    wcs = modeled(days, [
        ("2022-12-05", -26.75, "Assumption: ~$27 under WTI before the spill (Reuters, 8 Dec 2022)"),
        ("2022-12-07", -27.50, "Reuters, 8 Dec 2022: Dec WCS at Hardisty $27.50 under WTI the previous day (CalRock)"),
        ("2022-12-08", -33.50, "Reuters, 8 Dec 2022: Dec WCS at Hardisty $33.50 under WTI (CalRock)"),
        ("2022-12-13", -29.25, "Reuters, 13 Dec 2022: WCS $29.25 under WTI (CalRock)"),
        ("2022-12-20", -28.50, "Assumption: back within its range (Argus: 'within a well-worn range')"),
    ], "WCS Hardisty vs WTI")
    wcs_hou = modeled(days, [
        ("2022-12-05", -11.00, "Assumption: WCS at Houston ~$11 under WTI in late 2022"),
        ("2022-12-20", -12.00, "Assumption"),
    ], "WCS Houston vs WTI")
    S = {"wti": wti, "wcs": wcs, "wcs_hou": wcs_hou}
    d = {x: i for i, x in enumerate(days)}
    steps = [
        {"kind": "news", "day": 0, "headline": "WCS steady around $27 under WTI", "text": "Heavy Canadian crude flows south on Keystone, 622k b/d to Cushing and the Gulf.", "series": ["wcs"]},
        {"kind": "news", "day": 3, "headline": "Keystone shut after ~14,000 bbl leak in Kansas", "text": "TC Energy halts the line. Heavy barrels back up at Hardisty.", "series": ["wcs"]},
        {"kind": "decision", "day": 3, "title": "Scheduler: 50k bbl stranded at Hardisty", "prompt": "Your December Keystone barrels can't move. Rent tank and wait, or dump them at today's panic discount?",
         "options": [
             {"label": "Sell spot now at −$33.50", "now": {"usd": -round(50000 * (33.50 - 27.50)), "text": "Sold into the panic", "calc": "50k × ($33.50 − $27.50 normal discount)"}},
             {"label": "Rent tank, sell next week", "later": {"day": d["2022-12-15"], "usd": -round(50000 * (29.25 - 27.50) + 50000 * 0.60 * 0.5), "text": "Sold at ~−$29.25 after two weeks of tank", "calc": "50k × ($29.25 − $27.50) + tank 50k × $0.60/month × ½ month (assumed rate)"}},
         ]},
        {"kind": "idea", "day": 3, "type": "basis", "title": "Buy WCS at −$33.50",
         "pitch": "The discount blew out $6 in a day on a leak, not on demand. Buy the differential, hedged on WTI, and wait for it to snap back.",
         "bbl": 100000, "horizon": 5,
         "legs": [{"series": "wcs", "side": "buy", "at": "entry", "label": "Buy WCS diff"},
                  {"series": "wcs", "side": "sell", "at": "exit", "label": "Sell it back"}],
         "costs": [{"label": "Execution + tank (assumed)", "usd_bbl": 0.35}],
         "killers": ["Keystone stays down for months (2017 outage pushed WCS past −$30 for months)", "Alberta storage fills and producers dump", "Refiners switch to Latin heavy grades"]},
        {"kind": "pitch", "day": 4, "by": "mo"},
        {"kind": "idea", "day": 4, "type": "location_arb", "title": "Rail heavy crude to the Gulf",
         "pitch": "Hardisty is $22 under Houston. Rail costs ~$17. Book cars and move 100k bbl to the coast.",
         "bbl": 100000, "horizon": 7,
         "legs": [{"series": "wcs", "side": "buy", "at": "entry", "label": "Buy WCS Hardisty"},
                  {"series": "wcs_hou", "side": "sell", "at": "exit", "label": "Sell WCS Houston"}],
         "costs": [{"label": "Rail Hardisty → USGC (assumed $17/bbl)", "usd_bbl": 17.0},
                   {"label": "Loading + terminal (assumed)", "usd_bbl": 0.75}],
         "killers": ["The spread narrows before your cars load", "No rail cars on short notice", "Keystone restarts and Hardisty snaps back"]},
        {"kind": "decision", "day": 7, "title": "Scheduler: Keystone restarts the Wood River leg", "prompt": "Line space offered on the unaffected segment. Pay $1.50/bbl to jump the queue for your 50k bbl?",
         "options": [
             {"label": "Pay $1.50/bbl to move now", "now": {"usd": -75000, "text": "Queue-jump premium"}, "later": {"day": 10, "usd": 60000, "text": "Moved before the January roll: saved tank and roll", "calc": "Saved 50k × ($0.60 tank + $0.60 roll), assumed"}},
             {"label": "Wait for your turn", "later": {"day": 11, "usd": -60000, "text": "Rolled into January: tank + roll", "calc": "50k × ($0.60 tank + $0.60 roll), assumed"}},
         ]},
        {"kind": "pitch", "day": 8, "by": "carla"},
        {"kind": "news", "day": 10, "headline": "WCS back near −$28.50", "text": "The panic premium fades even with Keystone still partly shut.", "series": ["wcs"]},
    ]
    return {
        "id": "dsk-keystone-2022", "title": "Keystone leak, December 2022", "date": days[0],
        "open": "Keystone just shut. Hardisty is backing up.",
        "why": "The December 2022 leak blew WCS out $6 in a day, but the move faded within a week while the line stayed shut: refiners and traders found other routes and the January discount barely moved. The panic discount was the trade, not the outage.",
        "source": "WTI: EIA daily spot RWTC. WCS: Reuters 8 and 13 Dec 2022 (CalRock), Argus/S&P Global Dec 2022; Houston WCS and rail costs are labeled assumptions.",
        "concept": "cb-basis", "days": days, "series": S, "chart": ["wcs"], "steps": steps,
        "pitchable": {"wcs": {"qty": 100000, "fee": 0.25}},
    }


def scen_spr():
    days = trading_days("2022-06-01", "2022-06-16")
    wti = real("wti", days, 1, "WTI Cushing")
    brent = real("brent", days, 1, "Brent")
    mars = modeled(days, [
        ("2022-06-01", -4.00, "Assumption: early-June Mars discount"),
        ("2022-06-10", -6.50, "Reuters, 10 Jun 2022: Mars $6.50 under WTI, widest since March 2020"),
        ("2022-06-13", -8.25, "S&P Global: Mars assessed $8.25 under cash WTI on 13 Jun 2022, weakest since Oct 2008"),
        ("2022-06-16", -7.00, "Assumption: Mars steadies after the low (Reuters, June 2022)"),
    ], "Mars vs WTI")
    S = {"wti": wti, "brent": brent, "mars": mars,
         "brent_wti": derived(brent, wti, "Brent − WTI", "EIA daily spot RBRTE minus RWTC")}
    d = {x: i for i, x in enumerate(days)}
    bw = S["brent_wti"]["values"]
    early, late, today = bw[d["2022-06-09"]], bw[d["2022-06-16"]], bw[d["2022-06-06"]]
    spr = eia("spr")
    steps = [
        {"kind": "news", "day": 0, "headline": "SPR is releasing 1 MMb/d for six months", "text": "The largest release in SPR history, ~180 MMbbl, mostly sour crude, into Gulf Coast refineries.", "series": ["mars"]},
        {"kind": "idea", "day": 2, "type": "quality", "title": "Short Mars vs WTI",
         "pitch": "Policy barrels are sour and they keep coming. Sell Mars vs WTI and buy it back once refiners are full.",
         "bbl": 300000, "horizon": 6,
         "legs": [{"series": "mars", "side": "sell", "at": "entry", "label": "Sell Mars diff"},
                  {"series": "mars", "side": "buy", "at": "exit", "label": "Buy it back"}],
         "costs": [{"label": "Execution, both legs", "usd_bbl": 0.10}],
         "killers": ["SPR sales slow or get cancelled", "A coker restart soaks up sour barrels", "OPEC cuts sour supply"]},
        {"kind": "news", "day": 3, "headline": f"SPR down {abs(spr['2022-06-03'] - spr['2022-05-27']) / 1000:.1f} MMbbl in a week", "text": "EIA's weekly data: commercial sour barrels pile up along the Gulf.", "series": ["mars", "brent_wti"]},
        {"kind": "decision", "day": 3, "title": "Scheduler: pick a load window", "prompt": "Your 500k bbl WTI export cargo to Rotterdam. Load June 8-10, or June 15-17 on a ship $150k cheaper?",
         "options": [
             {"label": "June 8-10, prompt ship", "later": {"day": d["2022-06-09"], "usd": round(500000 * (early - today)), "text": f"Loaded; Brent−WTI ${early:.2f} vs ${today:.2f} when you chose", "calc": f"500k × (${early:.2f} − ${today:.2f})"}},
             {"label": "June 15-17, cheaper ship", "now": {"usd": 150000, "text": "Cheaper vessel"}, "later": {"day": d["2022-06-16"], "usd": round(500000 * (late - today)), "text": f"Loaded; Brent−WTI ${late:.2f} vs ${today:.2f} when you chose", "calc": f"500k × (${late:.2f} − ${today:.2f})"}},
         ]},
        {"kind": "pitch", "day": 5, "by": "mo"},
        {"kind": "idea", "day": 4, "type": "location_arb", "title": "Export WTI to Europe",
         "pitch": "Brent−WTI is ~$7. Buy WTI at the Gulf, ship to Rotterdam on an Aframax, sell against Brent.",
         "bbl": 600000, "horizon": 7,
         "legs": [{"series": "wti", "side": "buy", "at": "entry", "label": "Buy WTI (USGC)"},
                  {"series": "brent", "side": "sell", "at": "exit", "label": "Sell vs Brent"}],
         "costs": [{"label": "Aframax USG→Rotterdam (assumed $5.50/bbl)", "usd_bbl": 5.50},
                   {"label": "Pipeline Cushing→Houston (assumed)", "usd_bbl": 0.60},
                   {"label": "Financing", "financing": {"pct": 0.03, "on": "wti"}}],
         "killers": ["Brent−WTI narrows before you discharge", "Freight rallies (2022 Aframax rates were extreme)", "Flat price falls: unhedged cargo"]},
        {"kind": "pitch", "day": 8, "by": "quinn"},
        {"kind": "news", "day": 8, "headline": "Mars hits −$8.25, weakest since 2008", "text": "S&P Global: sour grades from Mars to WCS are swamped by SPR barrels.", "series": ["mars"]},
        {"kind": "decision", "day": 8, "title": "Scheduler: blend to a refinery spec", "prompt": "A refiner pays $0.75/bbl over formula for 1.5% sulfur. Blend 200k Mars with 100k Midland at $0.20/bbl?",
         "options": [
             {"label": "Blend and sell to spec", "now": {"usd": -60000, "text": "Blending fee 300k × $0.20"}, "later": {"day": 11, "usd": 225000, "text": "Spec premium paid", "calc": "300k × $0.75 (assumed offer)"}},
             {"label": "Sell Mars straight", "later": {"day": 11, "usd": 0, "text": "Sold at formula"}},
         ]},
        {"kind": "news", "day": 11, "headline": "Mars steadies near −$7", "text": "Refiners load up on cheap sour. The policy discount starts to look like a bargain.", "series": ["mars", "brent_wti"]},
    ]
    return {
        "id": "dsk-spr-release-2022", "title": "SPR release weeks, June 2022", "date": days[0],
        "open": "Policy barrels are hitting the Gulf.",
        "why": "The 2022 SPR release was mostly sour crude, delivered into the Gulf. Commercial sour grades had to make room: Mars went from about −$4 to −$8.25 under WTI, its weakest since 2008, before refiners bought the discount.",
        "source": "EIA daily spot (RWTC, RBRTE) and weekly SPR stocks (WCSSTUS1); Reuters 10 Jun 2022 and S&P Global 13 Jun 2022 Mars assessments; DOE SPR release history. Freight and blending values are labeled assumptions.",
        "concept": "cb-spr", "days": days, "series": S, "chart": ["mars", "brent_wti"], "steps": steps,
        "pitchable": {"mars": {"qty": 300000, "fee": 0.10}, "brent_wti": {"qty": 300000, "fee": 0.10}},
    }


def scen_redsea():
    days = trading_days("2024-01-08", "2024-01-25")
    wti = real("wti", days, 1, "WTI Cushing")
    brent = real("brent", days, 1, "Brent")
    nyh = real("ulsd_nyh", days, G, "NYH ULSD")
    usgc = real("ulsd_usgc", days, G, "USGC ULSD")
    S = {
        "wti": wti, "brent": brent, "brent_wti": derived(brent, wti, "Brent − WTI", "EIA daily spot RBRTE minus RWTC"),
        "ulsd_nyh": nyh, "ulsd_usgc": usgc,
        "ulsd_spread": derived(nyh, usgc, "NYH − USGC diesel", "EIA daily spot NYH minus USGC ULSD, $/gal × 42"),
        "lr2": modeled(days, [
            ("2024-01-08", 40000, "Assumption: early-January LR2 earnings"),
            ("2024-01-11", 46000, "Derived: S&P Global, Europe-bound LR2 freight +25% in 4 days after the 11 Jan strikes"),
            ("2024-01-18", 57500, "Derived: S&P Global, LR2s +60% in the five trading days to 25 Jan (92k/1.6)"),
            ("2024-01-25", 92000, "Brokers via S&P Global / Clarksons: LR2 MEG-Europe ~$90-100k/day, late January 2024"),
        ], "LR2 earnings", "$/day"),
    }
    steps = [
        {"kind": "news", "day": 0, "headline": "Houthi attacks push tankers away from Bab el-Mandeb", "text": "Owners start routing Europe-bound cargoes around the Cape: up to two extra weeks a voyage.", "series": ["lr2"]},
        {"kind": "idea", "day": 1, "type": "freight", "title": "Take an LR2 on 60-day time charter",
         "pitch": "Longer voyages soak up ships. Hire an LR2 now at ~$43k/day and relet it once the diversions bite.",
         "bbl": 750000, "horizon": 11,
         "legs": [{"series": "lr2", "side": "buy", "at": "entry", "qty": 60, "label": "Hire 60 days"},
                  {"series": "lr2", "side": "sell", "at": "exit", "qty": 60, "label": "Relet 60 days"}],
         "costs": [{"label": "Broker commission 1.25%", "usd": 0.0125 * 60 * 43000}],
         "killers": ["A ceasefire reopens Suez", "Owners reposition ballast ships and add supply", "Refinery runs drop in Europe, fewer cargoes"]},
        {"kind": "news", "day": 3, "headline": "US and UK strike Houthi targets", "text": "Dozens of tankers divert overnight. Europe-bound LR2 freight jumps 25% in four days (S&P Global).", "series": ["lr2", "brent_wti"]},
        {"kind": "decision", "day": 4, "title": "Scheduler: Suez or the Cape?", "prompt": "Your chartered tanker is approaching the Red Sea. Pay war-risk cover and transit, or go round the Cape?",
         "options": [
             {"label": "Transit Suez, pay war risk", "now": {"usd": -100000, "text": "War-risk premium (Argus: up to ~$100k for an LR2)"}, "later": {"day": 9, "usd": 0, "text": "Transited; delivered on schedule"}},
             {"label": "Go round the Cape", "later": {"day": 12, "usd": -round(250000 + 12 * 46000), "text": "12 extra days of hire + fuel", "calc": "BRS: ~$250k extra fuel + 12 days × $46k/day hire"}},
         ]},
        {"kind": "pitch", "day": 5, "by": "mo"},
        {"kind": "idea", "day": 6, "type": "basis", "title": "Long NY Harbor diesel vs the Gulf",
         "pitch": "European diesel to New York gets pricier with every diversion. Buy NYH vs USGC ULSD.",
         "bbl": 300000, "horizon": 5,
         "legs": [{"series": "ulsd_spread", "side": "buy", "at": "entry", "label": "Buy NYH−USGC"},
                  {"series": "ulsd_spread", "side": "sell", "at": "exit", "label": "Sell it back"}],
         "costs": [{"label": "Execution", "usd_bbl": 0.10}],
         "killers": ["Gulf barrels just ship north on Colonial", "Mild weather caps heating oil demand", "Europe keeps its own diesel"]},
        {"kind": "pitch", "day": 8, "by": "dan"},
        {"kind": "idea", "day": 9, "type": "location_arb", "title": "WTI export arb to Europe",
         "pitch": "Brent−WTI widened toward $7. Sell WTI into Europe, but freight is up too.",
         "bbl": 600000, "horizon": 3,
         "legs": [{"series": "wti", "side": "buy", "at": "entry", "label": "Buy WTI (USGC)"},
                  {"series": "brent", "side": "sell", "at": "exit", "label": "Sell vs Brent"}],
         "costs": [{"label": "Aframax USG→Rotterdam (assumed $3.80/bbl)", "usd_bbl": 3.80},
                   {"label": "Pipeline Cushing→Houston (assumed)", "usd_bbl": 0.60}],
         "killers": ["Brent−WTI narrows", "Freight keeps climbing", "Flat price drops: unhedged"]},
        {"kind": "news", "day": 12, "headline": "LR2s earn ~$92k/day, near four-year highs", "text": "Tonne-miles, not barrels, are the shortage: the same oil now needs more ship-days.", "series": ["lr2"]},
    ]
    return {
        "id": "dsk-red-sea-2024", "title": "Red Sea diversions, January 2024", "date": days[0],
        "open": "Ships are going the long way round.",
        "why": "Diversions around the Cape add up to two weeks per Middle East-Europe voyage. That soaks up tanker capacity: LR2 earnings roughly doubled in a month while Brent-WTI barely moved. Owning ships (or charters) beat owning barrels.",
        "source": "EIA daily spot (RBRTE, RWTC, NYH and USGC ULSD); S&P Global Jan 2024 LR2 freight reports; FreightWaves/Clarksons; BRS Cape fuel estimate; Argus war-risk premiums.",
        "concept": "cb-freight", "days": days, "series": S, "chart": ["lr2", "brent_wti"], "steps": steps,
        "pitchable": {"lr2": {"qty": 60, "fee": 600}, "brent_wti": {"qty": 300000, "fee": 0.10}},
    }


def build():
    cards = []
    for fn in (scen_colonial, scen_uri, scen_keystone, scen_spr, scen_redsea):
        s = fn()
        s.update({"type": "desk", "category": "physical", "difficulty": 3})
        s["steps"] = sorted(s["steps"], key=lambda x: x["day"])
        cards.append(s)
    doc = {"_readme": "Built by scripts/build-desk.py. Real series come from EIA daily spot (and NYMEX gas via Yahoo); modeled series are straight lines between cited anchors and say so. Do not edit by hand.", "cards": cards}
    out = os.path.join(DATA, "desk.json")
    json.dump(doc, open(out, "w"), indent=1, ensure_ascii=False)
    open(out, "a").write("\n")
    for s in cards:
        kinds = {}
        for st in s["steps"]:
            kinds[st["kind"]] = kinds.get(st["kind"], 0) + 1
        print(s["id"], len(s["days"]), "days", len(s["steps"]), "steps", kinds)


if __name__ == "__main__":
    build()
