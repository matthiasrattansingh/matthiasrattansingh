# COACH SPEC

The coaching layer of REPLAY DESK (Training path mode). Section 1 is the spec as given by the
desk owner. Section 2 records how each ambiguous point is implemented.

## 1. Spec

Coach voice: a desk mentor. Short, direct, questions before statements, cites my actual trades,
times, and prices. Never praises P&L without checking process. No motivational filler. Cards max
40 words except briefing and debrief.

### a) Morning briefing

`data/coach.json`; must be scrolled through before trading unlocks: yesterday's settle and what
is priced in, overnight headlines, today's scheduled events with CT times, 2-3 scenarios and
what each looks like on the tape, the LESSON OF THE DAY, and my carried rule from the previous
session at the top. Seeds (as of that morning, no outcomes):

- 10-27: "Settles Mon: WTI 101.76, Brent 115.81. Weekend: first high-level Tehran meeting. No headline has restored a single barrel. API after the close." Lesson: TRADE THE SURPRISE, NOT THE HEADLINE.
- 10-28: "Unconfirmed Houthi claim of a Ras Tanura strike, no Saudi confirmation. EIA 09:30 CT (poll crude +0.5M, distillates -0.9M; API crude -2.03M). Fed 13:00 CT, hold expected, dissents are the tell." Lesson: SEPARATE CLAIM FROM CONFIRMATION.
- 10-29: "Reports that VP Vance wrote to Tehran's security chief about reviving talks knocked about 1% off crude in Asia. GDP and PCE 07:30 CT. Gas storage 09:30 CT." Lesson: THE REACTION IS THE NEWS.
- 10-30: "Yesterday's fade met a VERIFIED limpet-mine attack on a Hormuz tanker. December Brent expires today. ECI 07:30 CT. OPEC+ Sunday." Lesson: DO NOT FADE CONFIRMED RISK.
- 11-02: "Weekend Qatar-mediated draft headlines knocked crude about 4% pre-open. OPEC+ held December steady. Hormuz still effectively closed; distillate cracks near $90." Lesson: PREMIUM UNWIND IS NOT PHYSICAL LOOSENING.
- 11-03: "Election day. Monday was a 7% washout on diplomacy headlines, no deal signed. EIA tomorrow." Lesson: AFTER A WASHOUT, SIZE DOWN.
- 11-04: "Election results are repricing the war premium politically. EIA 09:30 CT after four straight crude draws; distillates near multi-year lows; JPMorgan says October ran a surplus." Lesson: KNOW THE THESIS HIERARCHY.
- 11-05: "Crude down about 12% on the week, deal odds cut to about 10%, more ship attacks reported, Brent has traded under $100. Gas storage 09:30 CT." Lesson: OVERSOLD IS A CONDITION, NOT A SIGNAL.
- 11-06: "Jobs report 07:30 CT. Brent spiked through $100 overnight on attack reports. Spec length near record lows. COT after the close." Lesson: DO NOT CHASE THE SPIKE.
- 11-09: "Weekend: a tanker hit exiting Hormuz, no Sunday transits reported, Qatar's PM at the White House today. Unverified reports will fly. CPI and the EIA outlook Tuesday." Lesson: TWO SOURCES OR IT IS A RUMOR.

Each day also gets a "driver_summary" (2-3 plain sentences on what actually moved the day) shown
ONLY in the debrief.

### b) Trade ticket

Gates every entry; stored with the trade: (1) "What is the market pricing right now?" one line;
(2) "My signal": Range break / Failed extreme / VWAP flip / Scheduled print reaction / Headline
reaction / None, discretionary; (3) "What proves me wrong?" a price, which pre-fills the bracket
stop; (4) "Size vs plan": Normal / Reduced / Too big. If signal is None, show "No signal. This is
the trade type that has cost you the most." and require a 5-second pause before allowing the
order. Add a PASS button on every headline card logging "passed" with an optional one-tap reason
(Already priced / Unconfirmed / Against my plan / No signal). Passing is scored.

### c) Coach interruptions

Timed, dismissible, logged: first headline of the day ("New information, or already in the
price? What would the other side say?"); at each scheduled print, pause and ask "Surprise or in
line? First move holding or fading after 3 bars?" with one-tap answers logged; at 1R against an
open position ("What has changed since entry: the story, or only the price?"); ON ANY STOP-OUT,
a 3-minute lockout on re-entering that product ("Same idea again needs a NEW signal, not the same
hope"), overridden only by a new ticket with a different signal; 11:30 CT ("If you were flat now,
would you put this on at this price?"); 13:30 CT ("What is this position still for: the original
thesis, or hope?").

### d) Process score

Report card and scoreboard, separate from P&L: start 100. Minus: entry with signal None (-10
each); entry with no stop defined (-10); re-entry in the same product within 30 minutes of a
stop-out (-15); entry within 3 minutes of a headline without the ticket pause (-5); holding
through an unplanned scheduled print (-5). Plus: passing on 3+ headlines (+5); exiting a loser at
or before the planned stop (+5); letting a winner reach 2R before exiting (+5). Show P&L grade
and Process grade (A-F). Scoreboard tracks both per session and my P&L split by signal type.

### e) Guided debrief

After the Tape Autopsy; required for a session to count as trained: five one-line questions with
my session data pre-filled: (1) "What was today's driver?" then reveal driver_summary and mark
whether I named it; (2) "When did the tape first tell you?"; (3) "Your first trade: signal or
impulse?"; (4) "Where did the day turn, and were you positioned for it or against it?"; (5) "One
rule you carry into the next session." Answers save to a journal in localStorage and export in
the CSV.

### f) Training path

The 10 days in chronological order with their lessons; a session counts as trained only when the
briefing was viewed, at least one ticket or pass was logged, and the debrief is complete. Free
play remains available and is labeled untrained.

### Tests

Orders are blocked on an incomplete ticket and allowed on a complete one; the stop-out lockout
blocks same-product re-entry for 3 minutes unless a new ticket carries a different signal;
process-score math on a scripted example session; coach.json briefings contain no outcome
language for their own day ("settled at", "fell to", "rallied to"); debrief answers persist and
the carried rule appears in the next briefing; coach trades size 10 in the report math.

## 2. Implementation notes

Where the spec leaves a choice, this is what the code does (`site/js/coach.js`, `session.js`,
`coach-ui.js`; constants in `COACH` in `site/js/config.js`).

- **Entry.** An order that opens or adds exposure, including a flip. Exits and flatten need no
  ticket. The ticket's wrong-price becomes the stop order unless "attach as my stop order" is
  unticked; unticked is "no stop defined".
- **Lockout.** 3 minutes of real time from the stop-out. A stop-out is any stop order fill that
  only reduces the position. The override needs a signal different from the stopped trade's.
- **Re-entry within 30 minutes** is measured in session (replay) minutes.
- **"Within 3 minutes of a headline"**: bars are 5 minutes, so this is an entry placed on the bar
  a headline printed. The ticket offers a 5-second pause when that is the case; skipping it is
  the deduction.
- **Unplanned scheduled print**: a position is open when a scheduled print lands and its ticket
  signal was not "Scheduled print reaction". Once per print.
- **Scheduled prints** are the exact-time items: EIA, gas storage, API and macro releases. The
  second question (held or faded) is asked three bars after the first.
- **1R**: the distance from the entry fill to the ticket's wrong-price. The card fires once per
  entry, on a bar close.
- **11:30 and 13:30 cards** appear only when a position is open.
- **Coach cards pause the replay** and resume it when dismissed. Each card opens with the
  position and prices it refers to.
- **Score**: deductions apply per occurrence; each addition counts once per session; the result
  is clamped to 0..100. Grades: A >= 90, B >= 80, C >= 70, D >= 60, else F. P&L grade by return on
  the $100,000 account: A >= +1.0%, B >= +0.25%, C >= -0.25%, D >= -1.0%, else F.
- **"Named it"** in the debrief is pre-marked from `driver_keywords` and can be flipped by hand.
- **Free play** switches the whole layer off: no briefing, ticket, cards or process score.
- **Briefing content.** The briefing text and lessons are the seeds above. The event lists,
  consensus notes, scenarios, lesson one-liners and driver summaries in `data/coach.json` were
  written at build time from the real items in `data/headlines.json`.
- **Coach size.** The coach / best realistic trade trades 10 contracts (`COACH_CONTRACTS`). Its
  result is always shown as dollars at size, dollars per unit, and R (net profit divided by the
  initial stop risk in dollars). Where 10 contracts would exceed the account's margin estimate
  (RB, HO), it takes the largest size that fits and says so.
