// End-of-session scoring, trade-log CSV, and the localStorage scoreboard.
import { feesFor, pnlDollars, roundTo } from './instruments.js';
import { processScore, pnlGrade, signalStats } from './coach.js';

export function maxDrawdown(curve) {
  let peak = -Infinity, dd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    dd = Math.max(dd, peak - p.equity);
  }
  return dd;
}

/** Passive long: buy at the first tradable ask (+slippage) and sell at the final bid (−slippage), fees both sides. */
export function passiveLong(inst, qty, firstQuote, finalQuote, slip, fee) {
  const entry = roundTo(firstQuote.ask + slip, inst.tick);
  const exit = roundTo(finalQuote.bid - slip, inst.tick);
  const gross = pnlDollars(inst, qty, entry, exit);
  const fees = feesFor(inst, qty, fee) * 2;
  return { qty, entry, exit, gross, fees, net: gross - fees };
}

/**
 * TAPE AUTOPSY: every headline that printed, in time order, with its class revealed.
 * Only available once the session is finished, so the class can never leak mid-session.
 */
export function tapeAutopsy(session) {
  if (!session.finished) throw new Error('The tape autopsy is only available after the session ends');
  return session.tape.filter((t) => t.kind === 'headline').map((t) => {
    const h = t.item;
    const herring = h.class === 'noise';
    return {
      clock: t.clock, date: h.date, time: h.time, prior: Boolean(t.prior), type: h.type, headline: h.headline,
      label: herring ? 'RED HERRING' : 'REAL', herring,
      implies: herring ? h.implies ?? '' : '', herringType: herring ? h.herring_type ?? '' : '',
      note: h.autopsy_note ?? '', source: herring ? '' : h.source ?? '', url: herring ? '' : h.url ?? '',
      passed: t.passed ? (t.passed.reason || 'no reason given') : '',
      baits: herring ? session.baitEvents.filter((b) => b.herringClock === t.clock && b.headline === h.headline) : [],
    };
  });
}

export function reportCard(session) {
  const acct = session.account;
  const trades = acct.trades;
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sum = (a) => a.reduce((s, t) => s + t.net, 0);
  const totalNet = acct.realizedNet + (acct.position ? acct.unrealized(session.mark()) : 0);
  const best = trades.reduce((b, t) => (!b || t.net > b.net ? t : b), null);
  const worst = trades.reduce((w, t) => (!w || t.net < w.net ? t : w), null);
  const benchQty = Math.max(1, acct.maxAbsPosition);
  const finalQ = session.finalQuote || session.quote();
  const autopsy = session.finished ? tapeAutopsy(session) : [];
  const baitedTrades = trades.filter((t) => t.baited);
  const proc = session.coach ? processScore(session) : null;
  // risk per trade = contracts x stop distance x contract multiplier, measured at entry (needs a ticket)
  const risks = session.entries.map((e) => e.qty * e.R * session.inst.multiplier);
  const avgRisk = risks.length ? risks.reduce((a, b) => a + b, 0) / risks.length : null;
  return {
    avgRisk, avgRiskPct: avgRisk == null ? null : (avgRisk / acct.startingCash) * 100,
    process: proc,
    pnlGrade: pnlGrade(totalNet, acct.startingCash),
    bySignal: signalStats(trades),
    passes: session.passes.length,
    mode: session.coach ? 'train' : 'free',
    autopsy,
    herringsSeen: autopsy.filter((a) => a.herring).length,
    timesBaited: session.finished ? session.baitEvents.length : 0,
    baitedTrades: baitedTrades.length,
    baitedNet: sum(baitedTrades),
    cleanNet: sum(trades.filter((t) => !t.baited)),
    day: session.day,
    product: session.inst.id,
    totalNet,
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    expectancy: trades.length ? sum(trades) / trades.length : 0,
    maxDrawdown: maxDrawdown(session.equityCurve),
    fees: acct.feesPaid,
    best, worst,
    doNothing: 0,
    passiveLong: passiveLong(session.inst, benchQty, session.firstQuote, finalQ, session.slip, acct.fee),
  };
}

const CSV_COLS = ['entryTime', 'exitTime', 'product', 'side', 'size', 'entry', 'exit', 'gross', 'fees', 'net', 'exitReason',
  'baited', 'baitHeadline', 'sessionHerringsSeen', 'sessionTimesBaited',
  'signal', 'pricedIn', 'provesMeWrong', 'sizeVsPlan',
  'sessionMode', 'sessionTrained', 'sessionPasses', 'sessionProcessScore', 'sessionProcessGrade', 'sessionPnlGrade',
  'debrief1Driver', 'debriefNamedDriver', 'debrief2TapeToldYou', 'debrief3FirstTrade', 'debrief4Turn', 'debrief5Rule'];

/**
 * Trade log CSV. `score` = { finished, herringsSeen, timesBaited, product, mode, trained, passes,
 * processScore, processGrade, pnlGrade, debrief: { answers[5], named } }. The BAITED tag and every
 * session-level column are only written for a finished session (blank before, so a mid-session
 * download cannot reveal which headlines were herrings). Ticket columns are the trader's own
 * inputs and are always written. A finished session with no trades still gets one row.
 */
export function tradesToCsv(trades, day, decimals = 4, score = null) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const done = Boolean(score?.finished);
  const d = score?.debrief;
  const a = d?.answers || [];
  const sess = done
    ? [score.mode ?? '', score.trained ? 'TRAINED' : 'untrained', score.passes ?? 0, score.processScore ?? '', score.processGrade ?? '', score.pnlGrade ?? '',
      a[0] ?? '', d ? (d.named ? 'YES' : 'NO') : '', a[1] ?? '', a[2] ?? '', a[3] ?? '', a[4] ?? '']
    : Array(12).fill('');
  const stats = done ? [score.herringsSeen, score.timesBaited] : ['', ''];
  const rows = [['date', ...CSV_COLS].join(',')];
  for (const t of trades) {
    const k = t.meta?.ticket;
    rows.push([day, t.entryTime, t.exitTime, t.product, t.side, t.size,
      t.entry.toFixed(decimals), t.exit.toFixed(decimals), t.gross.toFixed(2), t.fees.toFixed(2), t.net.toFixed(2), t.exitReason,
      done ? (t.baited ? 'BAITED' : '') : '', done && t.baited ? t.baitHeadline : '', ...stats,
      k?.signal ?? '', k?.pricing ?? '', k ? k.wrong.toFixed(decimals) : '', k?.size ?? '', ...sess]
      .map(esc).join(','));
  }
  if (done && !trades.length) rows.push([day, '', '', score.product ?? '', 'NO TRADES', 0, '', '', '0.00', '0.00', '0.00', '', '', '', ...stats, '', '', '', '', ...sess].map(esc).join(','));
  return rows.join('\n') + '\n';
}

// ---- scoreboard (localStorage, best effort) ----
const KEY = 'replaydesk.sessions.v1';

export function loadScores(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(KEY) || '[]'); } catch { return []; }
}

export function saveScore(card, storage = globalThis.localStorage) {
  const list = loadScores(storage);
  list.push({ mode: card.mode, trained: false, passes: card.passes, pnlGrade: card.pnlGrade,
    process: card.process ? card.process.score : null, processGrade: card.process ? card.process.grade : null,
    bySignal: card.bySignal, day: card.day, product: card.product, net: card.totalNet, trades: card.trades,
    fees: card.fees, passive: card.passiveLong.net, herrings: card.herringsSeen, baited: card.timesBaited,
    baitedNet: card.baitedNet, playedAt: new Date().toISOString() });
  try { storage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  return list;
}

/** Patch the saved session whose playedAt matches (used when the debrief completes). */
export function updateScore(playedAt, patch, storage = globalThis.localStorage) {
  const list = loadScores(storage);
  const row = list.find((x) => x.playedAt === playedAt);
  if (!row) return false;
  Object.assign(row, patch);
  try { storage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  return true;
}

export function clearScores(storage = globalThis.localStorage) {
  try { storage.removeItem(KEY); } catch { /* ignore */ }
}

export function aggregate(list, key) {
  const m = new Map();
  for (const s of list) {
    const k = s[key];
    const r = m.get(k) || { key: k, sessions: 0, net: 0, trades: 0, beatPassive: 0, herrings: 0, baited: 0 };
    r.sessions += 1; r.herrings += s.herrings || 0; r.baited += s.baited || 0; r.net += s.net; r.trades += s.trades; if (s.net > s.passive) r.beatPassive += 1;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
