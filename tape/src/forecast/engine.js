// FORECAST engine: real EIA weekly prints (src/data/forecast.json). Pure functions only.
//
// Two kinds of record:
//   petroleum: crude/gasoline/distillate stock change (MMbbl), flows, WTI on release day
//   gas:       Lower-48 storage change (Bcf), 5-year average for the week, Henry Hub on release day
// Each card trains two skills: PRINT (forecast the number from its drivers) and REACTION
// (did the price finish release day UP or DOWN, given the print and the run into it).
import { seeded } from '../lib/format.js';

export const KINDS = ['petroleum', 'gas'];
export const UNIT = { petroleum: 'MMbbl', gas: 'Bcf' };
export const CLASS_NAMES = ['FLAT', 'NORMAL', 'BIG', 'HUGE'];

/** Value the player forecasts for a record. */
export const actualOf = (kind, r) => (kind === 'gas' ? r.change : r.crude);
const priceOf = (kind, r) => (kind === 'gas' ? r.ng : r.wti);
export const priceName = (kind) => (kind === 'gas' ? 'Henry Hub' : 'WTI');

export function classOf(x, classes) {
  const a = Math.abs(x);
  for (const c of classes) if (c.max == null || a < c.max) return c.name;
  return classes[classes.length - 1].name;
}
export const classesFor = (data, kind) => (kind === 'gas' ? data.classes.gas_bcf : data.classes.petroleum_mmbbl);

/** Real base rates of each size class, computed from the records. */
export function baseRates(records, kind, classes) {
  const cnt = Object.fromEntries(CLASS_NAMES.map((n) => [n, 0]));
  for (const r of records) cnt[classOf(actualOf(kind, r), classes)] += 1;
  return Object.fromEntries(CLASS_NAMES.map((n) => [n, cnt[n] / records.length]));
}

const sign = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}`;
const arrow = (x) => (x > 0 ? '▲' : x < 0 ? '▼' : '■');

/**
 * Driver clues shown BEFORE the lock (the date stays hidden). Everything comes from the
 * stored week; regime tags show only as a locked chip until the reveal.
 */
export function driverClues(kind, r) {
  if (kind === 'gas') {
    const vs5 = r.level - r.avg5_level;
    return [
      { key: 'season', label: 'Season', text: seasonOf(r.week_ending), tone: 0 },
      { key: 'avg5', label: '5-yr avg', text: `${sign(r.avg5_change, 0)} Bcf`, tone: -Math.sign(r.avg5_change) },
      { key: 'prev', label: 'Last week', text: `${sign(r.prev_change, 0)} Bcf`, tone: -Math.sign(r.prev_change) },
      { key: 'level', label: 'Stocks vs 5-yr', text: `${sign(vs5, 0)} Bcf`, tone: -Math.sign(vs5) },
    ];
  }
  const impDev = r.imports - r.imports_avg8;
  const expDev = r.exports - r.exports_avg8;
  const clues = [
    { key: 'util', label: 'Utilization', text: `${arrow(r.util_chg)} ${sign(r.util_chg)}pp → ${r.util.toFixed(1)}%`, tone: Math.sign(r.util_chg) },
    { key: 'imports', label: 'Imports vs 8wk', text: `${r.imports.toFixed(2)} MMb/d (${sign(impDev, 2)})`, tone: -Math.sign(impDev) },
    { key: 'exports', label: 'Exports vs 8wk', text: `${r.exports.toFixed(2)} MMb/d (${sign(expDev, 2)})`, tone: Math.sign(expDev) },
    { key: 'prod', label: 'Output, 4wk', text: `${r.prod.toFixed(1)} MMb/d (${sign(r.prod_4wk_chg, 1)})`, tone: -Math.sign(r.prod_4wk_chg) },
  ];
  if (r.api != null) clues.push({ key: 'api', label: 'API Tue', text: `${sign(r.api, 1)} MMbbl`, tone: -Math.sign(r.api) });
  return clues; // tone > 0 = points to a draw (bullish), < 0 = a build
}

function seasonOf(iso) {
  const m = Number(iso.slice(5, 7));
  return m <= 2 || m === 12 ? 'Winter (withdrawals)' : m <= 4 ? 'Spring shoulder' : m <= 9 ? 'Summer (injections)' : 'Autumn shoulder';
}

/** The driver that actually dominated the week, from the stored fields: cause, not just error. */
export function dominantDriver(kind, r) {
  const x = actualOf(kind, r);
  if (kind === 'gas') {
    const dev = r.change - r.avg5_change;
    const freeze = r.regime.some((t) => t.tag === 'freeze');
    if (Math.abs(dev) < 15) return { key: 'season', text: `Seasonal norm: ${sign(r.change, 0)} vs the 5-yr average ${sign(r.avg5_change, 0)} Bcf. The calendar did the work.` };
    const what = dev < 0 ? (r.change < 0 ? 'a bigger draw' : 'a smaller injection') : (r.change < 0 ? 'a smaller draw' : 'a bigger injection');
    return { key: 'weather', text: `${freeze ? 'The freeze' : 'Weather'}: ${what} than normal, ${sign(dev, 0)} Bcf vs the 5-yr average (${sign(r.avg5_change, 0)}).` };
  }
  const word = x < 0 ? 'draw' : 'build';
  const cands = Object.entries(r.contrib).map(([k, v]) => ({ key: k, v }));
  cands.push({ key: 'adjustment', v: r.adjustment });
  const same = cands.filter((c) => Math.sign(c.v) === Math.sign(x) && Math.abs(c.v) >= 0.3);
  const top = (same.length ? same : cands).sort((a, b) => Math.abs(b.v) - Math.abs(a.v))[0];
  const flow = (v) => `${sign(v, 2)} MMb/d w/w`;
  const texts = {
    exports: `The ${word} was exports, not demand: exports ${flow(r.exports_chg)} (${sign(top.v, 1)} MMbbl).`,
    imports: `The ${word} was imports: imports ${flow(r.imports_chg)} (${sign(top.v, 1)} MMbbl).`,
    runs: `The ${word} was refinery demand: crude runs ${flow(r.runs_chg)}, utilization ${r.util.toFixed(1)}% (${sign(top.v, 1)} MMbbl).`,
    production: `The ${word} was production: output ${flow(r.prod_chg)} (${sign(top.v, 1)} MMbbl).`,
    spr: `The ${word} was the SPR: ${Math.abs(r.spr_chg).toFixed(1)} MMbbl released into commercial supply.`,
    adjustment: `The ${word} was EIA's "adjustment": ${sign(r.adjustment, 1)} MMbbl the reported flows don't explain. Weekly noise, not a signal.`,
  };
  return { key: top.key, value: top.v, text: texts[top.key] };
}

/**
 * Release-day reaction. Naive read: a bullish print (crude draw; gas storage below the
 * seasonal norm) should send the price UP. Reasons it didn't, all from stored context.
 */
export function reaction(kind, r) {
  const p = priceOf(kind, r);
  const actual = p.chg > 0 ? 'UP' : 'DOWN';
  const bullish = kind === 'gas' ? r.change < r.avg5_change : r.crude < 0;
  const naive = bullish ? 'UP' : 'DOWN';
  const x = actualOf(kind, r);
  const cls = kind === 'gas' ? null : r.class;
  const reasons = [];
  if (kind === 'petroleum' && r.api != null && Math.sign(r.api) === Math.sign(x) && Math.abs(r.api) >= 3) {
    reasons.push({ key: 'api', text: `API telegraphed it: Tuesday's API showed ${sign(r.api, 1)}M, so the surprise was gone by Wednesday.` });
  }
  if (kind === 'petroleum' && r.consensus != null && Math.abs(x - r.consensus) < 1.5) {
    reasons.push({ key: 'consensus', text: `It matched consensus (${sign(r.consensus, 1)}M expected).` });
  }
  const ranWithPrint = (bullish && p.run5_pct >= 3) || (!bullish && p.run5_pct <= -3);
  if (ranWithPrint) reasons.push({ key: 'run', text: `Price ran ${sign(p.run5_pct, 1)}% in the 5 sessions into the print: it was priced in.` });
  if (kind === 'petroleum' && r.spx_chg_pct != null && Math.abs(r.spx_chg_pct) >= 1 && Math.sign(r.spx_chg_pct) === Math.sign(p.chg)) {
    reasons.push({ key: 'macro', text: `Macro ${r.spx_chg_pct < 0 ? 'risk-off' : 'risk-on'} day: S&P 500 ${sign(r.spx_chg_pct, 1)}%. Oil traded with stocks, not the print.` });
  }
  if (actual === naive) {
    reasons.unshift({ key: 'print', text: cls === 'FLAT' || cls === 'NORMAL' ? 'Direction matched the print, but a small print rarely drives the day: probably other news.' : 'The print drove it: the price moved the way the barrels said.' });
  } else if (!reasons.length) {
    reasons.push({ key: 'other', text: cls === 'FLAT' || cls === 'NORMAL' ? 'A small print: other news (OPEC, macro, positioning) set the day.' : 'Nothing in the stored context explains it: other news outweighed the print.' });
  }
  return { actual, naive, matched: actual === naive, price: p, reasons };
}

// ---------------------------------------------------------------- agents
//
// Each agent forecasts a week from that week's driver fields and earlier weeks only (never a
// later record: the functions take the list and an index and read records[0..i]).
const rnd = (seed) => seeded(seed)();

function solve(A, b) {
  // Gaussian elimination with partial pivoting.
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Quinn's features: the driver clues the card shows, in MMbbl/week. */
const quinnX = (r) => [
  1,
  -(r.exports - r.exports_avg8) * 7,
  (r.imports - r.imports_avg8) * 7,
  -r.runs_chg * 7,
  r.prod_chg * 7,
];

/** Quinn fits a ridge regression on the prior 104 weeks only, then shrinks toward it. */
function quinnPetroleum(records, i) {
  const r = records[i];
  const past = records.slice(Math.max(0, i - 104), i);
  let model = null;
  if (past.length >= 26) {
    const k = 5;
    const A = Array.from({ length: k }, () => Array(k).fill(0));
    const b = Array(k).fill(0);
    for (const q of past) {
      const x = quinnX(q);
      for (let a = 0; a < k; a++) {
        b[a] += x[a] * q.crude;
        for (let c = 0; c < k; c++) A[a][c] += x[a] * x[c];
      }
    }
    for (let a = 1; a < k; a++) A[a][a] += 5; // ridge
    const beta = solve(A, b);
    if (beta) model = quinnX(r).reduce((s, x, j) => s + x * beta[j], 0);
  }
  let f = model ?? 0;
  if (r.api != null) f = 0.5 * f + 0.5 * r.api;
  return Math.max(-20, Math.min(20, f));
}

export const AGENT_RULES = {
  quinn: 'Driver-weighted model: ridge regression on the prior two years of driver fields, blended with API when it exists. Tight.',
  mo: "Extrapolates: forecasts last week's actual print again.",
  carla: "Fades the API: bets against Tuesday's API number (or against last week's print when there's no API).",
  dan: 'Ignores the base rate: calls a tail every single week.',
};

/** All four agents' forecasts for record i (reads records[0..i] only). */
export function agentForecasts(kind, records, i) {
  const r = records[i];
  const prev = i > 0 ? records[i - 1] : null;
  const s = (k) => rnd(`${kind}|${r.week_ending}|${k}`);
  if (kind === 'gas') {
    const prevDev = prev ? prev.change - prev.avg5_change : 0;
    const flip = s('dan') < 0.5 ? -1 : 1;
    return {
      quinn: Math.round(r.avg5_change + 0.5 * prevDev),
      mo: Math.round(prev ? prev.change : r.avg5_change),
      carla: Math.round(r.avg5_change - 0.5 * prevDev),
      dan: Math.round(r.avg5_change + flip * (90 + s('mag') * 60)),
    };
  }
  const danSign = r.util_chg > 0 ? -1 : r.util_chg < 0 ? 1 : (s('dan') < 0.5 ? -1 : 1);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    quinn: r1(quinnPetroleum(records, i)),
    mo: r1(prev ? prev.crude : 0),
    carla: r1(r.api != null ? -0.5 * r.api : prev ? -0.5 * prev.crude : 0),
    dan: r1(danSign * (9 + s('mag') * 5)),
  };
}

// ---------------------------------------------------------------- the feed deck

/** Largest-remainder quotas so every block of `size` cards mirrors the base rates. */
export function quotas(rates, size) {
  const raw = CLASS_NAMES.map((n) => ({ n, q: rates[n] * size }));
  const out = Object.fromEntries(raw.map((x) => [x.n, Math.floor(x.q)]));
  let left = size - Object.values(out).reduce((a, b) => a + b, 0);
  for (const x of [...raw].sort((a, b) => (b.q % 1) - (a.q % 1))) {
    if (left-- <= 0) break;
    out[x.n] += 1;
  }
  return out;
}

/**
 * Quota for block k: the difference of cumulative largest-remainder targets, so after any
 * number of blocks every class is within one card of its real share (no rounding drift).
 */
export function blockQuota(rates, k, size = BLOCK) {
  const a = quotas(rates, (k + 1) * size);
  const b = k ? quotas(rates, k * size) : Object.fromEntries(CLASS_NAMES.map((n) => [n, 0]));
  return Object.fromEntries(CLASS_NAMES.map((n) => [n, a[n] - b[n]]));
}

/**
 * The forecast deck: unplayed weeks, drawn so each block of BLOCK cards has the dataset's
 * real class mix (no hand-picked drama). Played weeks come back only after every week is done.
 */
export const BLOCK = 20;
export function buildDeck(kind, records, classes, { seed = '', played = {}, rates = null } = {}) {
  const R = rates ?? baseRates(records, kind, classes);
  const rand = seeded(`deck|${kind}|${seed}`);
  const pools = Object.fromEntries(CLASS_NAMES.map((n) => [n, []]));
  const fresh = records.filter((r) => !played[r.id]);
  const src = fresh.length ? fresh : records;
  for (const r of src) pools[classOf(actualOf(kind, r), classes)].push(r.id);
  for (const n of CLASS_NAMES) {
    const a = pools[n];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  }
  const out = [];
  let k = 0;
  while (CLASS_NAMES.some((n) => pools[n].length)) {
    const q = blockQuota(R, k++);
    const block = [];
    for (const n of CLASS_NAMES) for (let k = 0; k < q[n] && pools[n].length; k++) block.push(pools[n].pop());
    if (!block.length) for (const n of CLASS_NAMES) while (pools[n].length) block.push(pools[n].pop());
    for (let i = block.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [block[i], block[j]] = [block[j], block[i]]; }
    out.push(...block);
  }
  return out;
}

// ---------------------------------------------------------------- scoring

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * PRINT accuracy for one kind. entries: { [recordId]: guess }.
 * Returns MAE, the two dumb baselines on the same weeks (repeat-last-week everywhere;
 * consensus only on weeks where it is stored), calibration and the error split by class,
 * plus each agent's MAE on exactly the same weeks.
 */
export function printStats(kind, records, classes, entries) {
  const idx = new Map(records.map((r, i) => [r.id, i]));
  const rows = Object.entries(entries ?? {}).filter(([id]) => idx.has(id)).map(([id, guess]) => {
    const i = idx.get(id);
    const r = records[i];
    const x = actualOf(kind, r);
    const last = i > 0 ? actualOf(kind, records[i - 1]) : 0;
    return { id, i, guess, x, cls: classOf(x, classes), err: Math.abs(guess - x), lastErr: Math.abs(last - x),
      consErr: kind === 'petroleum' && r.consensus != null ? Math.abs(r.consensus - x) : null,
      myConsErr: kind === 'petroleum' && r.consensus != null ? Math.abs(guess - x) : null,
      agents: agentForecasts(kind, records, i) };
  });
  const byClass = Object.fromEntries(CLASS_NAMES.map((n) => {
    const rs = rows.filter((x) => x.cls === n);
    return [n, { n: rs.length, mae: mean(rs.map((x) => x.err)), bias: mean(rs.map((x) => Math.abs(x.guess) - Math.abs(x.x))) }];
  }));
  const cons = rows.filter((x) => x.consErr != null);
  const agents = Object.fromEntries(Object.keys(AGENT_RULES).map((a) => [a, mean(rows.map((x) => Math.abs(x.agents[a] - x.x)))]));
  return {
    n: rows.length,
    mae: mean(rows.map((x) => x.err)),
    avgGuessSize: mean(rows.map((x) => Math.abs(x.guess))),
    avgActualSize: mean(rows.map((x) => Math.abs(x.x))),
    byClass,
    baselines: {
      repeatLast: mean(rows.map((x) => x.lastErr)),
      consensus: cons.length ? { n: cons.length, mae: mean(cons.map((x) => x.consErr)), mine: mean(cons.map((x) => x.myConsErr)) } : null,
    },
    agents,
  };
}

/** REACTION accuracy: entries { [recordId]: 'UP'|'DOWN' }. */
export function reactionStats(kind, records, entries) {
  const byId = new Map(records.map((r) => [r.id, r]));
  const rows = Object.entries(entries ?? {}).filter(([id]) => byId.has(id)).map(([id, call]) => {
    const rx = reaction(kind, byId.get(id));
    return { right: call === rx.actual, naiveRight: rx.matched };
  });
  return { n: rows.length, right: rows.filter((x) => x.right).length, naive: rows.filter((x) => x.naiveRight).length };
}

/** Each agent's long-run record over the whole dataset (the honest season leaderboard). */
export function agentSeason(kind, records, classes) {
  const out = {};
  for (const a of Object.keys(AGENT_RULES)) out[a] = { errs: [], byClass: Object.fromEntries(CLASS_NAMES.map((n) => [n, []])), sizes: [] };
  records.forEach((r, i) => {
    const f = agentForecasts(kind, records, i);
    const x = actualOf(kind, r);
    const cls = classOf(x, classes);
    for (const a of Object.keys(f)) {
      out[a].errs.push(Math.abs(f[a] - x));
      out[a].byClass[cls].push(Math.abs(f[a] - x));
      out[a].sizes.push(Math.abs(f[a]));
    }
  });
  return Object.fromEntries(Object.entries(out).map(([a, v]) => [a, {
    n: v.errs.length,
    mae: mean(v.errs),
    avgSize: mean(v.sizes),
    byClass: Object.fromEntries(CLASS_NAMES.map((n) => [n, mean(v.byClass[n])])),
  }]));
}

/** XP for a locked forecast: closer is better, scaled by the kind's unit. */
export function printXp(kind, err) {
  const unit = kind === 'gas' ? 10 : 1;
  return err <= unit ? 15 : err <= 3 * unit ? 8 : 3;
}
