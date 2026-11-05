import CardShell from '../components/CardShell.jsx';
import Sparkline from '../components/Sparkline.jsx';
import Choice from '../components/Choice.jsx';
import Reveal from '../components/Reveal.jsx';
import { scoreSpread } from '../lib/scoring.js';
import { fmtDate, fmtPrice, fmtSigned } from '../lib/format.js';

// SPREAD SNAP: two related prices, the spread's recent history, and one call:
// does it WIDEN or NARROW over the horizon?
export default function SpreadCard({ card, answer, onAnswer, badge }) {
  const done = Boolean(answer);
  const res = answer?.result;
  const pick = (call) => {
    const result = scoreSpread(card, call);
    onAnswer({ call, result }, result);
  };

  return (
    <CardShell kicker="SPREAD SNAP" badge={badge}>
      <div className="flex items-baseline justify-between">
        <span className="num text-xs text-dim">{fmtDate(card.spread.date)}</span>
        <span className="num text-[10px] uppercase tracking-wider text-dim">horizon {card.horizon}</span>
      </div>

      <div className="mt-1 text-xl font-extrabold leading-tight">{card.title}</div>
      <div className="text-[11px] text-dim">{card.formula}</div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {card.legs.map((l) => (
          <div key={l.name} className="rounded-xl border border-line bg-panel p-2">
            <div className="text-[10px] uppercase tracking-wider text-dim">{l.name}</div>
            <div className="num text-base font-bold">{fmtPrice(l.price, l.unit)}</div>
            <div className="num text-[10px] text-dim">{l.unit}</div>
          </div>
        ))}
        <div className="rounded-xl border border-amber/40 bg-amber/10 p-2">
          <div className="text-[10px] uppercase tracking-wider text-amber">Spread</div>
          <div className="num text-base font-bold text-amber">{fmtSigned(card.spread.now)}</div>
          <div className="num text-[10px] text-dim">{card.unit}</div>
        </div>
      </div>

      {!done && <p className="mt-3 text-[15px] font-semibold leading-snug">{card.headline}</p>}
      {!done && (
        <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-white/70">
          {card.setup.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}

      <div className="mt-3 rounded-xl border border-line bg-panel px-2 py-2">
        <Sparkline data={card.spread.series} after={card.outcome.after} showAfter={done} height={done ? 52 : 80}
          zeroLine={Math.min(...card.spread.series, ...(done ? card.outcome.after : [])) < 2} />
        <div className="num flex justify-between px-1 text-[10px] text-dim">
          <span>spread, last {card.spread.series.length - 1} sessions</span>
          {done && <span>{fmtDate(card.outcome.date)}</span>}
        </div>
      </div>

      <div className="mt-auto pt-3">
        {!done ? (
          <div className="grid grid-cols-2 gap-2">
            <Choice tone="up" onClick={() => pick('WIDEN')}>WIDEN ⟷</Choice>
            <Choice tone="down" onClick={() => pick('NARROW')}>NARROW →←</Choice>
          </div>
        ) : (
          <Reveal correct={res.correct} points={res.points} title={`${answer.call} · it ${res.actual === 'WIDEN' ? 'widened' : 'narrowed'}`}
            why={card.why} source={card.source}>
            <div className="num mt-1.5 flex items-baseline gap-3 text-sm">
              <span className="text-dim">{fmtSigned(card.spread.now)}</span>
              <span className="text-dim">→</span>
              <span className="text-xl font-bold text-amber">{fmtSigned(card.outcome.spread)}</span>
              <span className="text-dim">{card.unit}</span>
            </div>
          </Reveal>
        )}
      </div>
    </CardShell>
  );
}
