import { useEffect, useMemo, useRef, useState } from 'react';
import { TradeChart } from './chart.js';
import { act, botDecisions, buildSession, decisionPrice, emptyBook, equityOf, simulate } from './engine.js';
import { fmtMoney } from '../lib/book.js';
import { BOTS } from '../lib/rivals.js';
import { decimalsFor, fmtDate } from '../lib/format.js';
import { tick, thud, ping, unlock } from '../lib/sound.js';

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
 * equity curve), guard ({ peak, limit } trailing drawdown that ends the session: eval).
 */
export default function TradeSession({
  card, bankroll, salt = '', onFinish, maxCandles, sizes = SIZES, maxLots, ride = 0, ghost = null, guard = null, account = null,
}) {
  const [s] = useState(() => {
    const full = buildSession(card);
    const out = maxCandles ? regroup(full, maxCandles) : full;
    return maxLots ? { ...out, maxLots } : out;
  });
  const stats = useRef({ peak: 0, maxDD: 0, warned: false, traded: false, guardPeak: guard?.peak ?? 0 });
  const d = decimalsFor(s.unit);
  const bots = useMemo(
    () => BOTS.map((b) => ({ ...b, sim: simulate(s, botDecisions(b.id, s, salt)) })),
    [s, salt],
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
  const [lots, setLots] = useState(2);
  const sizeRow = sizes.length > 4;
  const [news, setNews] = useState(null);
  const [flash, setFlash] = useState(null);
  const [mine, setMine] = useState(0); // session P&L at the last candle close

  // Live numbers are written straight to the DOM every frame (no re-render).
  const paint = (pnl) => {
    if (pnlEl.current) {
      pnlEl.current.textContent = fmtMoney(Math.round(pnl));
      pnlEl.current.className = `num text-[32px] font-extrabold leading-none ${pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'text-white'}`;
    }
    if (eqEl.current) eqEl.current.textContent = fmtMoney(Math.round(bankroll + pnl), { sign: false });
    // Session stats for quests and the debrief.
    const st = stats.current;
    st.peak = Math.max(st.peak, pnl);
    st.maxDD = Math.max(st.maxDD, st.peak - pnl);
    st.guardPeak = Math.max(st.guardPeak, bankroll + pnl);
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
    const sim = simulate(s, decisions.current);
    setPhase('over');
    chartRef.current.setEntry(null);
    const pnl = extra.marginCall || extra.guardHit ? extra.pnl : sim.final;
    paint(pnl);
    const { maxDD, warned, traded } = stats.current;
    finishRef.current?.({
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
      const f = paint(pnl);
      if (overRef.current) return;
      if (bankroll + pnl <= 0) {
        chart.anim = null; // the market stops for you: margin call
        finish({ marginCall: true, pnl });
      } else if (guard && f >= 1) {
        chart.anim = null; // eval: trailing drawdown limit hit
        finish({ guardHit: true, pnl });
      }
    };
    chart.onDone = (ci) => {
      if (overRef.current) return;
      const close = s.candles[ci].c;
      const eq = equityOf(bookRef.current, close, ci + 1, s);
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
    const item = s.news.find((n) => n.at === i);
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

  // The market never waits: 8s, then HOLD.
  useEffect(() => {
    if (phase !== 'decide') return undefined;
    const id = setTimeout(() => decide({ type: 'HOLD' }), DECIDE_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, i]);

  function decide(action) {
    if (phase !== 'decide' || overRef.current) return;
    const price = decisionPrice(s, i);
    const nb = act(bookRef.current, action, price, i, s);
    bookRef.current = nb;
    decisions.current[i] = action;
    if (nb.pos) stats.current.traded = true;
    setBook(nb);
    chartRef.current.setEntry(nb.pos ? { price: nb.pos.entry, label: posLabel(s, nb.pos, d) } : null);
    const eq = equityOf(nb, price, i, s);
    startEq.current = eq;
    paint(eq);
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
        <span className="num shrink-0 text-[10px] text-dim">{phase === 'over' ? 'SESSION OVER' : `${candleLabel} · ${Math.min(i + 1, s.C)}/${s.C}`}</span>
      </div>
      <div className="truncate px-3 text-[12.5px] font-semibold text-amber">{s.open}</div>

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
        {s.simulated && <span className="num pointer-events-none absolute bottom-1 left-2 text-[9px] text-white/30">{s.label}</span>}
      </div>

      <BotStrip bots={bots} done={done} mine={mine} />

      <div className="border-t border-line px-3 pt-1.5">
        <div className="flex items-end justify-between">
          <div className="min-w-0">
            <div className="num truncate text-[13px] font-bold text-white/90">{posLabel(s, book.pos, d)}</div>
            <div ref={pnlEl} className="num text-[32px] font-extrabold leading-none">$0</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-dim">
              {account === 'eval' && <span className="mr-1 rounded bg-amber/25 px-1 font-bold text-amber">EVAL</span>}
              {ride > 0 && <span className="mr-1 rounded bg-up/20 px-1 font-bold text-up">RIDE {fmtMoney(ride)}</span>}
              Equity
            </div>
            <div ref={eqEl} className="num text-lg font-bold leading-tight" />
          </div>
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-dim">margin</span>
          <div className="h-1.5 flex-1 rounded bg-white/10"><div ref={marginEl} className="h-full rounded bg-white/40" style={{ width: '2%' }} /></div>
        </div>
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
            <Btn tone="up" off={!deciding} onClick={tap({ type: 'ADD' })}>ADD 1</Btn>
            <Btn tone="amber" off={!deciding} onClick={tap({ type: 'CUT' })}>CUT ½</Btn>
            <Btn tone="down" off={!deciding} onClick={tap({ type: 'CLOSE' })}>CLOSE</Btn>
          </div>
        )}
      </div>
    </div>
  );
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
