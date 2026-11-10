// End-of-session scoring, trade-log CSV, and the localStorage scoreboard.
import { feesFor, pnlDollars, roundTo } from './instruments.js';

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
  return {
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
  'baited', 'baitHeadline', 'sessionHerringsSeen', 'sessionTimesBaited'];

/**
 * Trade log CSV. `score` = { finished, herringsSeen, timesBaited, product }. The BAITED tag and the
 * two herring stats are only written for a finished session (blank before, so a mid-session
 * download cannot reveal which headlines were herrings). A finished session with no trades
 * still gets one row carrying the stats.
 */
export function tradesToCsv(trades, day, decimals = 4, score = null) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const done = Boolean(score?.finished);
  const stats = done ? [score.herringsSeen, score.timesBaited] : ['', ''];
  const rows = [['date', ...CSV_COLS].join(',')];
  for (const t of trades) {
    rows.push([day, t.entryTime, t.exitTime, t.product, t.side, t.size,
      t.entry.toFixed(decimals), t.exit.toFixed(decimals), t.gross.toFixed(2), t.fees.toFixed(2), t.net.toFixed(2), t.exitReason,
      done ? (t.baited ? 'BAITED' : '') : '', done && t.baited ? t.baitHeadline : '', ...stats]
      .map(esc).join(','));
  }
  if (done && !trades.length) rows.push([day, '', '', score.product ?? '', 'NO TRADES', 0, '', '', '0.00', '0.00', '0.00', '', '', '', ...stats].map(esc).join(','));
  return rows.join('\n') + '\n';
}

// ---- scoreboard (localStorage, best effort) ----
const KEY = 'replaydesk.sessions.v1';

export function loadScores(storage = globalThis.localStorage) {
  try { return JSON.parse(storage.getItem(KEY) || '[]'); } catch { return []; }
}

export function saveScore(card, storage = globalThis.localStorage) {
  const list = loadScores(storage);
  list.push({ day: card.day, product: card.product, net: card.totalNet, trades: card.trades,
    fees: card.fees, passive: card.passiveLong.net, herrings: card.herringsSeen, baited: card.timesBaited,
    baitedNet: card.baitedNet, playedAt: new Date().toISOString() });
  try { storage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  return list;
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
