import { useEffect, useRef, useState } from 'react';
import { TradeChart } from './chart.js';
import { act, buildSession, decisionPrice, emptyBook, equityOf, simulate } from './engine.js';
import { fmtMoney } from '../lib/book.js';
import { decimalsFor, fmtDate } from '../lib/format.js';

const SIZES = [1, 2, 5];

function posLabel(s, pos, d) {
  if (!pos) return 'FLAT';
  return `${s.sides[pos.side]} ${pos.lots} @ ${pos.entry < 0 ? '−' : ''}${Math.abs(pos.entry).toFixed(d)}`;
}

// One trading session: the chart animates candle by candle and you manage a
// live position between candles. Fixed full-screen layout, nothing scrolls.
export default function TradeSession({ card, bankroll, onFinish }) {
  const [s] = useState(() => buildSession(card));
  const d = decimalsFor(s.unit);
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const bookRef = useRef(emptyBook());
  const decisions = useRef([]);
  const pnlEl = useRef(null);
  const eqEl = useRef(null);
  const [book, setBook] = useState(emptyBook());
  const [phase, setPhase] = useState('decide'); // decide | candle | over
  const [i, setI] = useState(0); // next candle to play
  const [lots, setLots] = useState(2);

  // Live numbers are written straight to the DOM every frame (no re-render).
  const paint = (pnl) => {
    if (pnlEl.current) {
      pnlEl.current.textContent = fmtMoney(Math.round(pnl));
      pnlEl.current.className = `num text-[34px] font-extrabold leading-none ${pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'text-white'}`;
    }
    if (eqEl.current) eqEl.current.textContent = fmtMoney(Math.round(bankroll + pnl), { sign: false });
  };

  useEffect(() => {
    const chart = new TradeChart(canvasRef.current, s, { decimals: d });
    chartRef.current = chart;
    chart.onTick = (price, t) => paint(equityOf(bookRef.current, price, t, s));
    chart.onDone = (ci) => {
      const next = ci + 1;
      setI(next);
      if (next >= s.C) finish();
      else setPhase('decide');
    };
    paint(0);
    return () => chart.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish() {
    const sim = simulate(s, decisions.current);
    setPhase('over');
    chartRef.current.setEntry(null);
    paint(sim.final);
    onFinish?.({ session: s, decisions: decisions.current, sim });
  }

  function decide(action) {
    if (phase !== 'decide') return;
    const price = decisionPrice(s, i);
    const nb = act(bookRef.current, action, price, i, s);
    bookRef.current = nb;
    decisions.current[i] = action;
    setBook(nb);
    chartRef.current.setEntry(nb.pos ? { price: nb.pos.entry, label: posLabel(s, nb.pos, d) } : null);
    paint(equityOf(nb, price, i, s));
    setPhase('candle');
    chartRef.current.play(i);
  }

  const flat = !book.pos;
  const candleLabel = s.candles[Math.min(i, s.C - 1)].t.split(' · ')[0];

  return (
    <div className="flex h-[100dvh] flex-col bg-black pt-[34px]" style={{ touchAction: 'none' }}>
      <div className="flex items-baseline justify-between gap-2 px-3 py-1">
        <span className="num truncate text-[12px] font-bold text-white">{s.instrument} · {fmtDate(s.date)}</span>
        <span className="num shrink-0 text-[10px] text-dim">{phase === 'over' ? 'SESSION OVER' : `${candleLabel} · ${Math.min(i + 1, s.C)}/${s.C}`}</span>
      </div>
      <div className="truncate px-3 text-[12.5px] font-semibold text-amber">{s.open}</div>

      <div className="relative min-h-0 flex-1 px-1 pt-1">
        <canvas ref={canvasRef} className="block h-full w-full" />
        {s.simulated && <span className="num pointer-events-none absolute bottom-1 left-2 text-[9px] text-white/30">{s.label}</span>}
      </div>

      <div className="border-t border-line px-3 pt-2">
        <div className="flex items-end justify-between">
          <div className="min-w-0">
            <div className="num truncate text-[13px] font-bold text-white/90">{posLabel(s, book.pos, d)}</div>
            <div ref={pnlEl} className="num text-[34px] font-extrabold leading-none">$0</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-dim">Equity</div>
            <div ref={eqEl} className="num text-lg font-bold" />
          </div>
        </div>
      </div>

      <div className="px-3 pt-2 pb-[max(12px,env(safe-area-inset-bottom))]">
        {phase === 'over' ? (
          <div className="num py-4 text-center text-sm text-dim">Session over</div>
        ) : flat ? (
          <>
            <div className="mb-1.5 flex items-center justify-center gap-1.5">
              <span className="text-[10px] uppercase tracking-wider text-dim">size</span>
              {SIZES.map((n) => (
                <button key={n} onClick={() => setLots(n)}
                  className={`num rounded-md px-2.5 py-0.5 text-xs font-bold ${lots === n ? 'bg-amber text-black' : 'bg-white/10 text-white/70'}`}>
                  {n}
                </button>
              ))}
              <span className="num text-[10px] text-dim">lots</span>
            </div>
            <div className={`grid gap-2 ${s.spread ? 'grid-cols-3' : 'grid-cols-4'}`}>
              <Btn tone="up" off={phase !== 'decide'} onClick={() => decide({ type: 'OPEN', side: 'LONG', lots })}>{s.sides.LONG} ▲</Btn>
              <Btn tone="down" off={phase !== 'decide'} onClick={() => decide({ type: 'OPEN', side: 'SHORT', lots })}>{s.sides.SHORT} ▼</Btn>
              {!s.spread && <Btn tone="flat" off={phase !== 'decide'} onClick={() => decide({ type: 'OPEN', side: 'VOL', lots })}>SELL VOL</Btn>}
              <Btn tone="dim" off={phase !== 'decide'} onClick={() => decide({ type: 'HOLD' })}>WAIT</Btn>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            <Btn tone="flat" off={phase !== 'decide'} onClick={() => decide({ type: 'HOLD' })}>HOLD</Btn>
            <Btn tone="up" off={phase !== 'decide'} onClick={() => decide({ type: 'ADD' })}>ADD 1</Btn>
            <Btn tone="amber" off={phase !== 'decide'} onClick={() => decide({ type: 'CUT' })}>CUT ½</Btn>
            <Btn tone="down" off={phase !== 'decide'} onClick={() => decide({ type: 'CLOSE' })}>CLOSE</Btn>
          </div>
        )}
      </div>
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
