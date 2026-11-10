// REPLAY DESK configuration. Edit these values freely.
//
// tick         minimum price increment (exchange tick size)
// spreadTicks  simulated bid/ask width in ticks around the last trade
// multiplier   contract size (units per contract); $ P&L per 1.00 price move = multiplier
// marginPct    initial margin ESTIMATE as a fraction of notional. Real CME margins
//              are set in $/contract and change often; this is a rough stand-in.
export const PRODUCTS = {
  CL: { name: 'WTI Crude', tick: 0.01,   spreadTicks: 2, multiplier: 1000,  unit: 'bbl',   decimals: 2, marginPct: 0.08 },
  BZ: { name: 'Brent Crude', tick: 0.01, spreadTicks: 2, multiplier: 1000,  unit: 'bbl',   decimals: 2, marginPct: 0.08 },
  NG: { name: 'Henry Hub Nat Gas', tick: 0.001, spreadTicks: 3, multiplier: 10000, unit: 'MMBtu', decimals: 3, marginPct: 0.12 },
  RB: { name: 'RBOB Gasoline', tick: 0.0001, spreadTicks: 2, multiplier: 42000, unit: 'gal', decimals: 4, marginPct: 0.08 },
  HO: { name: 'ULSD / Heating Oil', tick: 0.0001, spreadTicks: 2, multiplier: 42000, unit: 'gal', decimals: 4, marginPct: 0.08 },
};

// Spread instruments: one position, matched contracts in each leg.
// spreadMarginFactor: fraction of the summed outright leg margins charged for the spread
// (exchanges give an inter-commodity spread credit; this is an estimate).
export const SPREADS = {
  'BZ-CL': { name: 'Brent − WTI', legs: [{ product: 'BZ', ratio: 1 }, { product: 'CL', ratio: -1 }], spreadMarginFactor: 0.35 },
};

export const ACCOUNT = {
  startingCash: 100000,
  feePerContractPerSide: 4.5, // charged on every leg of every fill
  slippageTicks: 1,           // applied against you on market and stop fills (per leg)
};

export const SESSION = {
  open: '07:00',  // CT
  close: '14:30', // CT
  barMinutes: 5,
};

// Replay speed mapping. 1x = one 5-minute bar every 5 real seconds (60x real time).
export const SPEEDS = [
  { label: '1x', msPerBar: 5000 },
  { label: '4x', msPerBar: 1250 },
  { label: '12x', msPerBar: 5000 / 12 },
  { label: '60x', msPerBar: 5000 / 60 },
];

// Headline types that auto-pause the replay when their timestamp is reached.
export const PAUSE_TYPES = ['EIA', 'EIA-NG', 'API'];

// TAPE AUTOPSY: an opening/adding fill counts as BAITED when it happens within this many
// minutes after a red herring printed, in the direction the herring implied.
export const BAIT_WINDOW_MINUTES = 15;

// COACH layer (Training path mode). Times are in milliseconds of REAL time unless noted.
export const COACH = {
  lockoutMs: 3 * 60 * 1000,     // re-entry lockout after a stop-out (real time)
  revengeMinutes: 30,           // session minutes after a stop-out in which a re-entry counts as revenge
  noSignalDelayMs: 5000,        // forced wait on a ticket with signal = None
  headlinePauseMs: 5000,        // the "ticket pause" offered when a headline printed on the current bar
  printFollowBars: 3,           // bars after a scheduled print before "held or faded?"
  reunderwriteAt: '11:30',
  lastHourAt: '13:30',
  maxCardWords: 40,
  // P&L grade thresholds, as % of starting equity: A >= a, B >= b, C >= c, D >= d, else F
  pnlGrade: { a: 1.0, b: 0.25, c: -0.25, d: -1.0 },
};
