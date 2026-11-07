import { useEffect, useMemo, useRef, useState } from 'react';
import { TradeChart } from './chart.js';
import { LOT_BBL, act, botDecisions, buildSession, decisionPrice, emptyBook, equityOf, simulate } from './engine.js';
import { EXEC, execute, executeAll, hardenSession, livePrice } from './execution.js';
import { limitState, limitsFor, lockSim } from '../game/rules.js';
import { frontRunner } from '../game/adaptive.js';
import { toPerBbl } from '../lib/scoring.js';
import { fmtMoney } from '../lib/book.js';
import { BOTS } from '../lib/rivals.js';
import { decimalsFor, fmtDate } from '../lib/format.js';
import { tick, thud, ping, unlock } from '../lib/sound.js';
import { HEDGE_ADD, HEDGE_MAX_LOTS, HEDGE_SIZES, botTwoBook, hedgeGrade, hedgeRatio, physCurve, physPnl } from '../physical/twobook.js';

const SIZES = [1, 2, 5];
export const DECIDE_MS = 8000;
export const CANDLE_MS = 2000;

function posLabel(s, pos, d) {
  if (!pos) return 'FLAT';
  return `${s.sides[pos.side]} ${pos.lots} @ ${pos.entry < 0 ? '−' : ''}${Math.abs(pos.entry).toFixed(d)}`;
}

function buzz(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

/**
 * One trading session: the chart animates candle by candle and you manage a
 * live position between candles. Fixed full-screen layout, nothing scrolls.
 * After each candle an 8s timer runs; if it expires you HOLD and the market moves on.
 * Props: card, bankroll (equity at the start: account + any ride), salt (seeds the bots),
 * onFinish({ session, decisions, sim, bots, marginCall, pnl, stats }), and optionally:
 * sizes / maxLots (unlocks), ride (ride balance shown next to equity), ghost (best-run
 * equity curve), guard ({ peak, limit } trailing drawdown that ends the session: eval),
 * physical (two-book: an exposure you can't close, only hedge; bankroll is then the
 * paper margin line) with agents (the desk bots' physical rules).
 */
export default function TradeSession({
  card, bankroll, salt = '', onFinish, maxCandles, sizes: sizesIn = SIZES, maxLots, ride = 0, ghost = null, guard = null, account = null,
  physical = null, agents = null, seed = null, hard = false, habits = [],
}) {
  const runSeed = seed ?? salt;
  const [s] = useState(() => {
    const full = buildSession(card);
    const cut = maxCandles ? regroup(full, maxCandles) : full;
    // Hard mode: same session, meaner tape (seeded, final close real).
    const out = hard ? hardenSession(cut, runSeed) : cut;
    if (physical) return { ...out, maxLots: HEDGE_MAX_LOTS, addStep: HEDGE_ADD };
    return maxLots ? { ...out, maxLots } : out;
  });
  const sizes = physical ? HEDGE_SIZES : sizesIn;
  const ratios = useRef([]);
  const physEl = useRef(null);
  const physNow = (price, t) => (physical ? physPnl(physical, s, price, t) : 0);
  const stats = useRef({ peak: 0, maxDD: 0, warned: false, traded: false, guardPeak: guard?.peak ?? 0 });
  // Prop-firm limits for this session, scaled to the equity you start with.
  const limits = useMemo(() => limitsFor(bankroll), []); // eslint-disable-line react-hooks/exhaustive-deps
  const dailyEl = useRef(null);
  const trailEl = useRef(null);
  const liveEl = useRef(null);
  const costs = useRef({ slip: 0, partial: 0, frontRun: {} });
  const decideAt = useRef(0);
  const [fillNote, setFillNote] = useState(null);
  const d = decimalsFor(s.unit);
  const bots = useMemo(
    () => (physical && agents
      ? agents.map((a) => ({ ...BOTS.find((b) => b.id === a.id), sim: botTwoBook(a, physical, s, salt) }))
      // Bots pay the same spreads and partial fills you do (they tap instantly).
      : BOTS.map((b) => ({ ...b, sim: lockSim(simulate(s, executeAll(s, botDecisions(b.id, s, salt), { seed: runSeed })), limitsFor(bankroll)) }))),
    [s, salt, physical, agents],
  );

  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const bookRef = useRef(emptyBook());
  const decisions = useRef([]);
  const startEq = useRef(0); // equity when the current candle started
  const pnlEl = useRef(null);
  const eqEl = useRef(null);
  const marginEl = useRef(null);
  const overRef = useRef(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const [book, setBook] = useState(emptyBook());
  const [phase, setPhase] = useState('decide'); // decide | candle | over
  const [i, setI] = useState(0); // next candle to play
  const [lots, setLots] = useState(physical ? 100 : 2);
  const sizeRow = sizes.length > 4;
  const [news, setNews] = useState(null);
  const [flash, setFlash] = useState(null);
  const [mine, setMine] = useState(0); // session P&L at the last candle close

  // Live numbers are written straight to the DOM every frame (no re-render).
  const paint = (pnl, phys = 0) => {
    // pnl = paper; phys = physical leg (two-book only). The big number is the combined book.
    const total = pnl + phys;
    if (pnlEl.current) {
      pnlEl.current.textContent = fmtMoney(Math.round(total));
      pnlEl.current.className = `num text-[32px] font-extrabold leading-none ${total > 0 ? 'text-up' : total < 0 ? 'text-down' : 'text-white'}`;
    }
    if (physEl.current) physEl.current.textContent = `PHYS ${fmtMoney(Math.round(phys), { compact: true })} · PAPER ${fmtMoney(Math.round(pnl), { compact: true })}`;
    if (eqEl.current) eqEl.current.textContent = fmtMoney(Math.round(bankroll + pnl), { sign: false });
    // Session stats for quests and the debrief.
    const st = stats.current;
    st.peak = Math.max(st.peak, total);
    st.maxDD = Math.max(st.maxDD, st.peak - total);
    st.guardPeak = Math.max(st.guardPeak, bankroll + pnl);
    // The two prop-firm meters, always on screen.
    const ls = physical ? { daily: 0, trailing: 0, hit: null } : limitState({ pnl: total, peak: st.peak }, limits);
    const meter = (el, v) => {
      if (!el) return;
      el.style.width = `${Math.max(v * 100, 2)}%`;
      el.className = `h-full rounded ${v > 0.7 ? 'bg-down margin-pulse' : v > 0.4 ? 'bg-amber' : 'bg-white/40'}`;
    };
    meter(dailyEl.current, ls.daily);
    meter(trailEl.current, ls.trailing);
    st.limitHit = ls.hit;
    // Margin bar: how close you are to a margin call (or, in an eval, to the drawdown limit).
    const f = guard
      ? Math.min(1, Math.max(0, st.guardPeak - (bankroll + pnl)) / (st.guardPeak * guard.limit))
      : Math.min(1, Math.max(0, -pnl) / bankroll);
    if (f > 0.4) st.warned = true;
    if (marginEl.current) {
      marginEl.current.style.width = `${Math.max(f * 100, 2)}%`;
      marginEl.current.className = `h-full rounded ${f > 0.7 ? 'bg-down margin-pulse' : f > 0.4 ? 'bg-amber' : 'bg-white/40'}`;
    }
    return f;
  };

  function finish(extra = {}) {
    if (overRef.current) return;
    overRef.current = true;
    const full = simulate(s, decisions.current);
    // A session stopped by a limit or a margin call is the record: freeze it where it stopped.
    const stoppedAt = extra.marginCall || extra.guardHit || extra.limitHit ? Math.min(i, s.C) : null;
    const sim = stoppedAt === null ? full : truncateSim(full, stoppedAt, extra.pnl);
    setPhase('over');
    chartRef.current.setEntry(null);
    // A margin call, an eval guard or a prop-firm limit locks the score where it was hit.
    const pnl = extra.marginCall || extra.guardHit || extra.limitHit ? extra.pnl : sim.final;
    paint(pnl);
    const { maxDD, warned, traded } = stats.current;
    let twoBook = null;
    if (physical) {
      // Ratios per candle (carry the last decision forward), then the hedge grade.
      const r = [];
      for (let k = 0; k < s.C; k++) r[k] = ratios.current[k] ?? (k ? r[k - 1] : 0);
      const naked = physCurve(physical, s);
      const combined = sim.curve.map((v, k) => v + naked[k]);
      const physFinal = extra.marginCall ? physNow(s.candles[Math.min(i, s.C - 1)].c, i + 1) : naked[naked.length - 1];
      twoBook = { physical, ratios: r, naked, combined, physFinal, paperFinal: pnl, grade: hedgeGrade({ ratios: r, combined, naked, news: s.news }) };
    }
    finishRef.current?.({
      twoBook,
      seed: runSeed, hard: Boolean(s.hard), limits,
      costs: { ...costs.current },
      session: s, decisions: decisions.current, sim, pnl,
      bots: bots.map((b) => ({ id: b.id, pnl: Math.round(b.sim.final) })),
      stats: { maxDD, warned, traded, guardPeak: stats.current.guardPeak },
      ...extra,
    });
  }

  useEffect(() => {
    const chart = new TradeChart(canvasRef.current, s, { decimals: d });
    chartRef.current = chart;
    if (ghost && ghost.length === s.C) chart.setGhost(ghost);
    chart.onTick = (price, t) => {
      const pnl = equityOf(bookRef.current, price, t, s);
      const f = paint(pnl, physNow(price, t));
      if (overRef.current) return;
      if (bankroll + pnl <= 0) {
        chart.anim = null; // the market stops for you: margin call
        finish({ marginCall: true, pnl });
      } else if (guard && f >= 1) {
        chart.anim = null; // eval: trailing drawdown limit hit
        finish({ guardHit: true, pnl });
      } else if (stats.current.limitHit) {
        chart.anim = null; // prop-firm limit: the session ends on the spot, score locked
        finish({ limitHit: stats.current.limitHit, pnl });
      }
    };
    chart.onDone = (ci) => {
      if (overRef.current) return;
      const close = s.candles[ci].c;
      const eq = equityOf(bookRef.current, close, ci + 1, s) + physNow(close, ci + 1);
      const delta = eq - startEq.current;
      setMine(eq);
      chart.setLive(ci, eq);
      if (bookRef.current.pos || Math.abs(delta) >= 1) {
        const vsBest = ghost && ghost.length === s.C ? Math.round(eq - ghost[ci]) : null;
        setFlash({ v: Math.round(delta), k: ci, vsBest });
        if (delta < -2000) thud(); else tick();
      }
      const next = ci + 1;
      setI(next);
      if (next >= s.C) finish();
      else setPhase('decide');
    };
    paint(0);
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Breaking news arrives between candles.
  useEffect(() => {
    if (phase !== 'decide') return undefined;
    const item = s.news.find((n) => n.at === i) ?? physical?.events?.find((e) => e.at === i);
    if (!item) return undefined;
    setNews(item);
    if (item.major) buzz([60, 40, 60]);
    ping();
    return undefined;
  }, [phase, i, s.news]);

  // Each banner stays 4s, whatever you tap in the meantime.
  useEffect(() => {
    if (!news) return undefined;
    const id = setTimeout(() => setNews(null), 4000);
    return () => clearTimeout(id);
  }, [news]);

  // The price keeps ticking while you decide: you fill at the live tick when you tap.
  useEffect(() => {
    if (phase !== 'decide') return undefined;
    decideAt.current = performance.now();
    const id = setInterval(() => {
      if (overRef.current) return;
      const ms = performance.now() - decideAt.current;
      const live = livePrice(s, i, ms, runSeed);
      const pnl = equityOf(bookRef.current, live, i, s);
      paint(pnl, physNow(live, i));
      if (liveEl.current) {
        const ch = live - decisionPrice(s, i);
        liveEl.current.textContent = `LIVE ${live < 0 ? '−' : ''}${Math.abs(live).toFixed(d)} ${ch > 0 ? '▲' : ch < 0 ? '▼' : '·'}`;
        liveEl.current.className = `num shrink-0 text-[10px] font-bold ${ch > 0 ? 'text-up' : ch < 0 ? 'text-down' : 'text-dim'}`;
      }
      if (stats.current.limitHit) finish({ limitHit: stats.current.limitHit, pnl });
    }, EXEC.tickMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, i]);

  // The market never waits: 8s, then HOLD.
  useEffect(() => {
    if (phase !== 'decide') return undefined;
    const id = setTimeout(() => decide({ type: 'HOLD' }), DECIDE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, i]);

  function decide(intent) {
    if (phase !== 'decide' || overRef.current) return;
    // Execution: live tick at the moment you tap, half-spread (wider on news), partial fills
    // above 2 lots, and extra slippage if a bot has read this habit and front-runs it.
    const ms = performance.now() - decideAt.current;
    const pos = bookRef.current.pos;
    const bot = intent.type === 'HOLD' ? null : frontRunner(habits, s, i, intent, pos);
    const { action, cost } = execute(s, i, intent, { ms, seed: runSeed, pos, frontRun: Boolean(bot) });
    const price = action.fill ?? decisionPrice(s, i);
    const nb = act(bookRef.current, action, price, i, s);
    if (cost) {
      const lots = action.lots ?? pos?.lots ?? 1;
      const slip$ = Math.abs(toPerBbl(cost.fill - cost.mid, s.unit)) * LOT_BBL * lots;
      costs.current.slip += slip$;
      if (cost.partial) costs.current.partial += cost.partial.asked - cost.partial.filled;
      if (bot) costs.current.frontRun[bot] = (costs.current.frontRun[bot] ?? 0) + 1;
      setFillNote({ k: i, text: `${cost.partial ? `Filled ${cost.partial.filled}/${cost.partial.asked} lots · ` : ''}slip −$${Math.round(slip$).toLocaleString()}${cost.news ? ' · wide news spread' : ''}${bot ? ` · ${BOTS.find((b) => b.id === bot)?.emoji} front-ran you` : ''}` });
    }
    bookRef.current = nb;
    decisions.current[i] = action;
    if (nb.pos) stats.current.traded = true;
    if (physical) ratios.current[i] = hedgeRatio(physical, nb.pos);
    setBook(nb);
    chartRef.current.setEntry(nb.pos ? { price: nb.pos.entry, label: posLabel(s, nb.pos, d) } : null);
    const eq = equityOf(nb, price, i, s);
    startEq.current = eq + physNow(price, i);
    paint(eq, physNow(price, i));
    setPhase('candle');
    chartRef.current.play(i, CANDLE_MS);
  }

  const tap = (action) => () => { unlock(); decide(action); };

  // Swipe up = HOLD and go to the next candle.
  const touch = useRef(null);
  const onTouchStart = (e) => { touch.current = e.touches[0].clientY; };
  const onTouchEnd = (e) => {
    const dy = e.changedTouches[0].clientY - (touch.current ?? 0);
    if (dy < -50) { unlock(); decide({ type: 'HOLD' }); }
  };

  const flat = !book.pos;
  const candleLabel = s.candles[Math.min(i, s.C - 1)].t.split(' · ')[0];
  const done = Math.min(i, s.C);
  const deciding = phase === 'decide';

  return (
    <div className="flex h-[100dvh] select-none flex-col bg-black pt-[34px]" style={{ touchAction: 'none' }}
      onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
      <div className="flex items-baseline justify-between gap-2 px-3 py-1">
        <span className="num truncate text-[12px] font-bold text-white">{s.instrument} · {fmtDate(s.date)}</span>
        {deciding && <span ref={liveEl} className="num shrink-0 text-[10px] font-bold text-dim" />}
        <span className="num shrink-0 text-[10px] text-dim">{phase === 'over' ? 'SESSION OVER' : `${s.hard ? '🔥HARD · ' : ''}${candleLabel} · ${Math.min(i + 1, s.C)}/${s.C}`}</span>
      </div>
      <div className="truncate px-3 text-[12.5px] font-semibold text-amber">{s.open}</div>
      {physical && <div className="truncate px-3 text-[11.5px] font-bold text-sky-300">📦 {physical.who}: {physical.desc} · hedge it</div>}

      <div className="relative min-h-0 flex-1 px-1 pt-1">
        <canvas ref={canvasRef} className="block h-full w-full" />
        {news && (
          <div key={news.text} className="news-drop absolute inset-x-2 top-1 z-10 flex items-center gap-2 rounded-lg border border-down/60 bg-down/90 px-2.5 py-1.5 shadow-lg">
            <span className="margin-pulse h-2 w-2 shrink-0 rounded-full bg-white" />
            <span className="truncate text-[13px] font-bold text-white">{news.text}</span>
          </div>
        )}
        {flash && (
          <div key={flash.k} className={`flash-pnl num pointer-events-none absolute inset-x-0 top-[38%] text-center text-5xl font-extrabold ${flash.v > 0 ? 'text-up' : flash.v < 0 ? 'text-down' : 'text-white'}`}>
            {fmtMoney(flash.v)}
            {flash.vsBest !== null && flash.vsBest !== undefined && (
              <div className={`mt-1 text-[12px] font-bold ${flash.vsBest >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(flash.vsBest)} vs your best run</div>
            )}
          </div>
        )}
        {deciding && <TimerRing key={`t${i}`} />}
        {fillNote && <div key={`f${fillNote.k}`} className="news-drop num pointer-events-none absolute inset-x-2 bottom-12 z-10 truncate rounded-md bg-black/80 px-2 py-1 text-center text-[11px] font-bold text-amber">{fillNote.text}</div>}
        {s.simulated && <span className="num pointer-events-none absolute bottom-1 left-2 text-[9px] text-white/30">{s.label}</span>}
      </div>

      <BotStrip bots={bots} done={done} mine={mine} />

      <div className="border-t border-line px-3 pt-1.5">
        <div className="flex items-end justify-between">
          <div className="min-w-0">
            <div className="num truncate text-[13px] font-bold text-white/90">
              {physical ? `${posLabel(s, book.pos, d)} · ${Math.round(hedgeRatio(physical, book.pos) * 100)}% hedged` : posLabel(s, book.pos, d)}
            </div>
            <div ref={pnlEl} className="num text-[32px] font-extrabold leading-none">$0</div>
            {physical && <div ref={physEl} className="num truncate text-[11px] font-bold text-white/70" />}
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-dim">
              {account === 'eval' && <span className="mr-1 rounded bg-amber/25 px-1 font-bold text-amber">EVAL</span>}
              {ride > 0 && <span className="mr-1 rounded bg-up/20 px-1 font-bold text-up">RIDE {fmtMoney(ride)}</span>}
              {physical ? 'Paper margin line' : 'Equity'}
            </div>
            <div ref={eqEl} className="num text-lg font-bold leading-tight" />
          </div>
        </div>
        <div className="mt-1 grid grid-cols-2 gap-x-3">
          <div className="flex items-center gap-1.5">
            <span className="num shrink-0 text-[8.5px] uppercase tracking-wider text-dim">daily loss ${Math.round(limits.daily / 1000)}k</span>
            <div className="h-1.5 flex-1 rounded bg-white/10"><div ref={dailyEl} className="h-full rounded bg-white/40" style={{ width: '2%' }} /></div>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="num shrink-0 text-[8.5px] uppercase tracking-wider text-dim">trail dd ${Math.round(limits.trailing / 1000)}k</span>
            <div className="h-1.5 flex-1 rounded bg-white/10"><div ref={trailEl} className="h-full rounded bg-white/40" style={{ width: '2%' }} /></div>
          </div>
        </div>
        <div ref={marginEl} className="hidden" />
      </div>

      <div className="px-3 pt-2 pb-[max(10px,env(safe-area-inset-bottom))]">
        {phase === 'over' ? (
          <div className="h-[76px]" />
        ) : flat ? (
          <>
            <div className="mb-1.5 flex items-center justify-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-dim">size</span>
              {sizes.map((n) => (
                <button key={n} onClick={() => setLots(n)}
                  className={`num rounded-md ${sizeRow ? "px-1.5" : "px-2.5"} py-0.5 text-xs font-bold ${lots === n ? 'bg-amber text-black' : 'bg-white/10 text-white/70'}`}>
                  {n}
                </button>
              ))}
              <span className="num text-[10px] text-dim">lots</span>
            </div>
            <div className={`grid gap-2 ${s.spread ? 'grid-cols-3' : 'grid-cols-4'}`}>
              <Btn tone="up" off={!deciding} onClick={tap({ type: 'OPEN', side: 'LONG', lots })}>{s.sides.LONG} ▲</Btn>
              <Btn tone="down" off={!deciding} onClick={tap({ type: 'OPEN', side: 'SHORT', lots })}>{s.sides.SHORT} ▼</Btn>
              {!s.spread && <Btn tone="flat" off={!deciding} onClick={tap({ type: 'OPEN', side: 'VOL', lots })}>SELL VOL</Btn>}
              <Btn tone="dim" off={!deciding} onClick={tap({ type: 'HOLD' })}>WAIT</Btn>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-4 gap-2 pt-[22px]">
            <Btn tone="flat" off={!deciding} onClick={tap({ type: 'HOLD' })}>HOLD</Btn>
            <Btn tone="up" off={!deciding} onClick={tap({ type: 'ADD' })}>ADD {s.addStep ?? 1}</Btn>
            <Btn tone="amber" off={!deciding} onClick={tap({ type: 'CUT' })}>CUT ½</Btn>
            <Btn tone="down" off={!deciding} onClick={tap({ type: 'CLOSE' })}>CLOSE</Btn>
          </div>
        )}
      </div>
    </div>
  );
}

/** The session as played when it stopped at candle k with P&L locked: flat from there on. */
export function truncateSim(sim, k, locked) {
  const curve = sim.curve.map((v, j) => (j < k ? v : locked));
  const perCandle = curve.map((v, j) => v - (j ? curve[j - 1] : 0));
  return { ...sim, curve, perCandle, held: sim.held.map((h, j) => (j < k ? h : null)), final: locked, stoppedAt: k };
}

/** Merge a session's candles into `n` candles (OPEN BELL uses 5). */
export function regroup(s, n) {
  if (s.C <= n) return s;
  const size = s.C / n;
  const candles = [];
  for (let k = 0; k < n; k++) {
    const part = s.candles.slice(Math.round(k * size), Math.round((k + 1) * size));
    candles.push({ o: part[0].o, h: Math.max(...part.map((c) => c.h)), l: Math.min(...part.map((c) => c.l)), c: part[part.length - 1].c, t: part[0].t });
  }
  const news = s.news.map((x) => ({ ...x, at: Math.min(n - 1, Math.floor(x.at / size)) }));
  return { ...s, candles, C: n, news };
}

function TimerRing() {
  const r = 15;
  const len = 2 * Math.PI * r;
  return (
    <div className="pointer-events-none absolute right-12 bottom-2 h-10 w-10">
      <svg viewBox="0 0 40 40" className="h-10 w-10 -rotate-90">
        <circle cx="20" cy="20" r={r} fill="rgba(0,0,0,.6)" stroke="rgba(255,255,255,.15)" strokeWidth="3.5" />
        <circle cx="20" cy="20" r={r} fill="none" stroke="#ffb000" strokeWidth="3.5" strokeLinecap="round"
          strokeDasharray={len} className="timer-ring" style={{ '--len': len, animationDuration: `${DECIDE_MS}ms` }} />
      </svg>
      <Countdown />
    </div>
  );
}

function Countdown() {
  const [left, setLeft] = useState(DECIDE_MS / 1000);
  useEffect(() => {
    const start = performance.now();
    const id = setInterval(() => setLeft(Math.max(0, Math.ceil((DECIDE_MS - (performance.now() - start)) / 1000))), 200);
    return () => clearInterval(id);
  }, []);
  return <span className={`num absolute inset-0 flex items-center justify-center text-[12px] font-bold ${left <= 3 ? 'text-down' : 'text-white'}`}>{left}</span>;
}

/** Compact money for the strip: $850, $5.2k, $112k. */
function k(v) {
  const a = Math.abs(Math.round(v));
  const sgn = v > 0.5 ? '+' : v < -0.5 ? '−' : '';
  if (a < 1000) return `${sgn}$${a}`;
  return `${sgn}$${a < 10000 ? (a / 1000).toFixed(1) : Math.round(a / 1000)}k`;
}

/** You vs the desk, this session, updated every candle. */
function BotStrip({ bots, done, mine }) {
  return (
    <div className="num flex items-center justify-between gap-1 whitespace-nowrap border-t border-line px-3 py-1 text-[10.5px]">
      <span className={`font-bold ${mine > 0 ? 'text-up' : mine < 0 ? 'text-down' : 'text-white'}`}>YOU {k(mine)}</span>
      {bots.map((b) => {
        const v = done ? b.sim.curve[done - 1] : 0;
        const ahead = v > mine;
        return (
          <span key={b.id} className={ahead ? 'font-bold text-white' : 'text-white/40'} title={b.name}>
            {b.emoji}<span className={v > 0 ? 'text-up' : v < 0 ? 'text-down' : ''}>{k(v)}</span>
          </span>
        );
      })}
    </div>
  );
}

const TONE = {
  up: 'border-up/60 text-up', down: 'border-down/60 text-down', flat: 'border-white/40 text-white',
  amber: 'border-amber/60 text-amber', dim: 'border-white/15 text-white/50',
};

function Btn({ tone, off, onClick, children }) {
  return (
    <button onClick={onClick} disabled={off}
      className={`num h-14 rounded-xl border bg-panel text-[12px] font-extrabold tracking-wider transition active:scale-95 ${TONE[tone]} ${off ? 'opacity-35' : ''}`}>
      {children}
    </button>
  );
}
