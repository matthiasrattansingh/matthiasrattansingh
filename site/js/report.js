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
  return {
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

const CSV_COLS = ['entryTime', 'exitTime', 'product', 'side', 'size', 'entry', 'exit', 'gross', 'fees', 'net', 'exitReason'];

export function tradesToCsv(trades, day, decimals = 4) {
  const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [['date', ...CSV_COLS].join(',')];
  for (const t of trades) {
    rows.push([day, t.entryTime, t.exitTime, t.product, t.side, t.size,
      t.entry.toFixed(decimals), t.exit.toFixed(decimals), t.gross.toFixed(2), t.fees.toFixed(2), t.net.toFixed(2), t.exitReason]
      .map(esc).join(','));
  }
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
    fees: card.fees, passive: card.passiveLong.net, playedAt: new Date().toISOString() });
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
    const r = m.get(k) || { key: k, sessions: 0, net: 0, trades: 0, beatPassive: 0 };
    r.sessions += 1; r.net += s.net; r.trades += s.trades; if (s.net > s.passive) r.beatPassive += 1;
    m.set(k, r);
  }
  return [...m.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
