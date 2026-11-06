import { useEffect, useRef, useState } from 'react';
import { TradeChart } from './chart.js';
import { buildSession } from './engine.js';
import { decimalsFor, fmtDate } from '../lib/format.js';
import { PhysChart } from '../physical/PhysChart.js';
import { cardDate, cardTitle, isPhysical } from '../lib/cards.js';

export const AUTOPLAY_MS = 5000;

/** The next session's first candle, animating on a loop behind the countdown. */
function Preview({ card }) {
  const ref = useRef(null);
  useEffect(() => {
    if (isPhysical(card)) {
      // Physical sessions: the first few days (cargo) or weeks (tank) of the benchmark draw on a loop.
      const vals = card.type === 'cargo' ? card.days.map((d) => d.flat) : card.weekly.map((w) => w.curve[0]);
      const pc = new PhysChart(ref.current, { steps: vals.length, labelOf: () => '' });
      let n = 0;
      const id = setInterval(() => { n = (n + 1) % 5; pc.set([{ name: '', color: '#ffb000', values: vals }], n); }, 700);
      return () => { clearInterval(id); pc.destroy(); };
    }
    const s = buildSession(card);
    const chart = new TradeChart(ref.current, s, { decimals: decimalsFor(s.unit) });
    let t;
    const loop = () => {
      chart.setDrawn(0);
      chart.play(0, 1800);
    };
    chart.onDone = () => { t = setTimeout(loop, 500); };
    t = setTimeout(loop, 400);
    return () => { clearTimeout(t); chart.destroy(); };
  }, [card]);
  return <canvas ref={ref} className="block h-full w-full" />;
}

/**
 * Autoplay: the next session is already moving; it starts by itself when the
 * 5-second ring runs out (paused while `hold` is true). STOP leaves autoplay.
 */
export default function NextUp({ card, label, hold, onGo, onStop, children }) {
  const [left, setLeft] = useState(AUTOPLAY_MS);
  const goRef = useRef(onGo);
  goRef.current = onGo;

  useEffect(() => {
    if (hold) return undefined;
    const end = performance.now() + left;
    const id = setInterval(() => {
      const rest = Math.max(0, end - performance.now());
      setLeft(rest);
      if (rest <= 0) { clearInterval(id); goRef.current(); }
    }, 100);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold]);

  const r = 17;
  const len = 2 * Math.PI * r;
  const s = cardTitle(card);
  const date = cardDate(card);
  return (
    <div className="border-t border-line bg-panel/95 px-3 pt-2">
      {children}
      <div className="flex items-center gap-3">
        <div className="relative h-[64px] min-w-0 flex-1 overflow-hidden rounded-lg border border-line bg-black">
          <Preview card={card} />
          <div className="pointer-events-none absolute inset-x-0 top-0 truncate bg-gradient-to-b from-black/90 to-transparent px-2 py-0.5 text-[10.5px] font-bold">
            <span className="text-dim">{label ?? 'NEXT'} · </span>{s} · {fmtDate(date)}
          </div>
        </div>
        <button onClick={() => onGo()} className="relative h-14 w-14 shrink-0" aria-label="Start next session">
          <svg viewBox="0 0 40 40" className="h-14 w-14 -rotate-90">
            <circle cx="20" cy="20" r={r} fill="rgba(255,176,0,.12)" stroke="rgba(255,255,255,.15)" strokeWidth="3" />
            <circle cx="20" cy="20" r={r} fill="none" stroke="#ffb000" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={len} strokeDashoffset={len * (1 - left / AUTOPLAY_MS)} />
          </svg>
          <span className="num absolute inset-0 flex items-center justify-center text-[11px] font-extrabold text-amber">
            {hold ? 'NEXT' : Math.ceil(left / 1000)}
          </span>
        </button>
      </div>
      <div className="flex items-center justify-between py-1.5">
        <span className="text-[10px] text-dim">{hold ? 'Answer the concept to start the countdown' : 'Starting automatically…'}</span>
        <button onClick={onStop} className="num rounded-md border border-white/20 px-2.5 py-1 text-[10px] font-bold tracking-widest text-white/80">■ STOP</button>
      </div>
    </div>
  );
}
