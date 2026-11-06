import { useMemo, useState } from 'react';
import { benchmarks, decisionValues, gradeGrid } from './engine.js';
import { fmtMoney } from '../lib/book.js';
import { BOTS, botById } from '../lib/rivals.js';
import { fmtDate, seeded } from '../lib/format.js';
import NextUp from './NextUp.jsx';

const ACTION = { OPEN: 'Open', ADD: 'Add 1', CUT: 'Cut ½', CLOSE: 'Close', FLIP: 'Flip', HOLD: 'Hold' };

function describe(s, d) {
  if (d.type === 'OPEN') return `${s.sides[d.side]} ${d.lots}`;
  return ACTION[d.type];
}

/** Session equity curve with your best/worst decisions marked. */
function EquityCurve({ curve, best, worst }) {
  const pts = [0, ...curve];
  const W = 300;
  const H = 96;
  const lo = Math.min(...pts, 0);
  const hi = Math.max(...pts, 0);
  const span = hi - lo || 1;
  const x = (i) => 6 + (i / (pts.length - 1)) * (W - 12);
  const y = (v) => 6 + (1 - (v - lo) / span) * (H - 12);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const end = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height: H }} preserveAspectRatio="none">
      <line x1="0" x2={W} y1={y(0)} y2={y(0)} stroke="rgba(255,255,255,.25)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      <polyline points={line} fill="none" strokeWidth="2.5" vectorEffect="non-scaling-stroke" className={`draw-on ${end >= 0 ? 'stroke-up' : 'stroke-down'}`} pathLength="1" />
      {best && <circle cx={x(best.i)} cy={y(pts[best.i])} r="5" className="fill-up" />}
      {worst && <circle cx={x(worst.i)} cy={y(pts[worst.i])} r="5" className="fill-down" />}
    </svg>
  );
}

// Session end: what happened, how you traded it, the lesson, and one concept question.
// The bottom panel is autoplay: the next session is already moving behind a countdown.
// RIDE carries a winning session's profit into the next session as bonus margin.
export default function Debrief({
  result, concept, onConcept, onNext, onShare, next, onStop, onRide, ride = 0, canRide = false, rode = false, rideLost = 0, banner = null, extra = null,
}) {
  const { session: s, sim, trade, decisions, marginCall } = result;
  const values = useMemo(() => decisionValues(s, decisions), [s, decisions]);
  const best = values.length ? values.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  const worst = values.length ? values.reduce((a, b) => (b.value < a.value ? b : a)) : null;
  const bench = useMemo(() => benchmarks(s), [s]);
  const grid = gradeGrid(sim);
  const dd = useMemo(() => {
    let peak = 0;
    let max = 0;
    for (const v of [0, ...sim.curve]) { peak = Math.max(peak, v); max = Math.max(max, peak - v); }
    return max;
  }, [sim]);
  const beat = trade.bots.filter((b) => trade.pnl > b.pnl).length;
  const board = [{ id: 'you', name: 'You', emoji: '🫵', pnl: trade.pnl }, ...trade.bots.map((b) => ({ ...botById[b.id], pnl: b.pnl }))]
    .sort((a, b) => b.pnl - a.pnl);

  const [pick, setPick] = useState(null);
  const order = useMemo(() => {
    if (!concept) return [];
    const rand = seeded(`${s.id}|${concept.id}`);
    const idx = concept.question.choices.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx;
  }, [concept, s.id]);
  const answer = (i) => {
    if (pick !== null) return;
    setPick(i);
    onConcept?.(concept, i === concept.question.answer);
  };

  const tone = (v) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-white');
  return (
    <div className="pop absolute inset-0 z-30 flex flex-col bg-black">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[44px] pb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-dim">
          {marginCall ? '💀 Margin call · ' : ''}Debrief · {s.instrument} · {fmtDate(s.date)}
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`num text-4xl font-extrabold ${tone(trade.pnl)}`}>{fmtMoney(trade.pnl)}</span>
          {trade.mult > 1 && <span className="num rounded bg-amber/20 px-1.5 text-sm font-bold text-amber">🔥 ×{trade.mult}</span>}
        </div>
        <div className="num mt-1 text-[15px] tracking-wide">{grid}</div>
        <div className={`num text-[12px] font-bold ${beat === 4 ? 'text-amber' : beat >= 2 ? 'text-up' : 'text-down'}`}>
          {beat === 4 ? '👑 You beat the whole desk' : `Beat ${beat}/4 of the desk`}
        </div>

        <div className="mt-3 rounded-xl border border-line bg-panel px-2 pt-2 pb-1">
          <EquityCurve curve={sim.curve} best={best?.value > 0 ? best : null} worst={worst?.value < 0 ? worst : null} />
          <div className="num flex flex-wrap justify-between gap-x-3 px-1 pt-1 text-[11px]">
            {best?.value > 0 && <span className="text-up">● best: {describe(s, best.action)} ({fmtMoney(best.value, { compact: true })})</span>}
            {worst?.value < 0 && <span className="text-down">● worst: {describe(s, worst.action)} ({fmtMoney(worst.value, { compact: true })})</span>}
          </div>
        </div>

        <div className="num mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg border border-line bg-panel p-2">
            <div className="text-[9px] uppercase tracking-wider text-dim">Max drawdown</div>
            <div className="text-sm font-bold text-down">{dd > 0 ? fmtMoney(-dd, { compact: true }) : '$0'}</div>
          </div>
          <div className="rounded-lg border border-line bg-panel p-2">
            <div className="text-[9px] uppercase tracking-wider text-dim">Hold {s.sides.LONG} 2</div>
            <div className={`text-sm font-bold ${tone(bench.long)}`}>{fmtMoney(bench.long, { compact: true })}</div>
          </div>
          <div className="rounded-lg border border-line bg-panel p-2">
            <div className="text-[9px] uppercase tracking-wider text-dim">Hold {s.sides.SHORT} 2</div>
            <div className={`text-sm font-bold ${tone(bench.short)}`}>{fmtMoney(bench.short, { compact: true })}</div>
          </div>
        </div>

        <ol className="num mt-2 grid grid-cols-5 gap-1 text-center text-[10px]">
          {board.map((r, i) => (
            <li key={r.id} className={`rounded-md border px-0.5 py-1 ${r.id === 'you' ? 'border-amber/60 bg-amber/10' : 'border-line bg-panel'}`}>
              <div>{i === 0 ? '👑' : `#${i + 1}`} {r.emoji}</div>
              <div className={tone(r.pnl)}>{fmtMoney(r.pnl, { compact: true })}</div>
            </li>
          ))}
        </ol>

        <h3 className="mt-4 text-[10px] uppercase tracking-[0.2em] text-amber">Why it moved</h3>
        <ul className="mt-1 space-y-1 text-[13.5px] leading-snug text-white/90">
          {s.card.why.map((w) => <li key={w}>{w}</li>)}
        </ul>

        {concept && (
          <div className="mt-4 rounded-xl border border-white/15 bg-panel p-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-dim">Concept · {concept.title} · +$2,500 if right</div>
            <p className="mt-1 text-[12.5px] leading-snug text-white/70">{concept.lines.slice(0, 2).join(' ')}</p>
            <p className="mt-2 text-[14px] font-semibold leading-snug">{concept.question.prompt}</p>
            <div className="mt-2 space-y-1.5">
              {order.map((i) => {
                const right = i === concept.question.answer;
                const look = pick === null ? 'border-line bg-black active:bg-white/10'
                  : right ? 'border-up/60 bg-up/15 text-up' : pick === i ? 'border-down/60 bg-down/15 text-down' : 'hidden';
                return (
                  <button key={i} onClick={() => answer(i)} className={`w-full rounded-lg border px-3 py-2.5 text-left text-[13px] leading-snug ${look}`}>
                    {concept.question.choices[i]}
                  </button>
                );
              })}
            </div>
            {pick !== null && (
              <p className={`mt-2 text-[12.5px] leading-snug ${pick === concept.question.answer ? 'text-up' : 'text-white/80'}`}>
                {pick === concept.question.answer ? '✓ +$2,500 research bonus. ' : '✗ Streak reset. '}{concept.question.explain}
              </p>
            )}
          </div>
        )}
        <p className="num mt-3 text-[9.5px] leading-snug text-white/35">{s.label}. {s.card.source}</p>
      </div>

      <div className="pb-[env(safe-area-inset-bottom)]">
        <NextUp card={next.card} label={next.label} hold={Boolean(concept) && pick === null} onGo={onNext} onStop={onStop}>
          {banner && <div className="pop mb-1.5 truncate rounded-md bg-white/10 px-2 py-1 text-[11.5px] font-semibold">{banner}</div>}
          {extra}
          <div className="mb-2 flex gap-2">
            <button onClick={() => onShare(grid)} className="num h-10 flex-1 rounded-lg border border-white/25 bg-black text-[11px] font-bold tracking-widest">SHARE</button>
            {canRide && (
              <button onClick={onRide} disabled={rode}
                className={`num h-10 flex-[2] rounded-lg border text-[11px] font-extrabold tracking-wider ${rode ? 'border-up/30 text-up/60' : 'border-up/70 bg-up/15 text-up'}`}>
                {rode ? `RIDING ${fmtMoney(ride)}` : `RIDE ${fmtMoney(trade.pnl)} ▶`}
              </button>
            )}
            {!canRide && ride > 0 && <span className="num flex flex-[2] items-center justify-center text-[11px] font-bold text-up">RIDE {fmtMoney(ride)}</span>}
            {rideLost > 0 && <span className="num flex flex-[2] items-center justify-center text-[11px] font-bold text-down">RIDE LOST −{fmtMoney(rideLost, { sign: false })}</span>}
          </div>
        </NextUp>
      </div>
    </div>
  );
}
