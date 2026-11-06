import { useState } from 'react';
import CardShell from '../components/CardShell.jsx';
import Sparkline from '../components/Sparkline.jsx';
import Choice from '../components/Choice.jsx';
import SizePicker from '../components/SizePicker.jsx';
import TradeReveal from '../components/TradeReveal.jsx';
import { scoreSpread } from '../lib/scoring.js';
import { fmtDate, fmtPrice, fmtSigned } from '../lib/format.js';

// SPREAD SNAP: two related prices, the spread's recent history, and one trade:
// WIDEN (buy the spread) or NARROW (sell it), then size it.
export default function SpreadCard({ card, answer, onAnswer, badge }) {
  const [call, setCall] = useState(null);
  const done = Boolean(answer?.trade);
  const place = (lots) => onAnswer({ call, lots }, scoreSpread(card, call));

  return (
    <CardShell kicker="SPREAD SNAP" badge={badge}>
      <div className="flex items-baseline justify-between">
        <span className="num text-xs text-dim">{fmtDate(card.spread.date)}</span>
        <span className="num text-[10px] uppercase tracking-wider text-dim">horizon {card.horizon}</span>
      </div>

      <div className="mt-1 text-xl font-extrabold leading-tight">{card.title}</div>
      <div className="text-[11px] text-dim">{card.formula}</div>

      {!done && <div className="mt-2.5 grid grid-cols-3 gap-2">
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
      </div>}

      {!done && <p className="mt-2.5 text-[15px] font-semibold leading-snug">{card.headline}</p>}
      {!done && !call && (
        <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-white/70">
          {card.setup.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}

      <div className={`rounded-xl border border-line bg-panel px-2 py-1.5 ${done ? 'mt-2' : 'mt-3'}`}>
        <Sparkline data={card.spread.series} after={card.outcome.after} showAfter={done} height={done ? 50 : 60}
          zeroLine={Math.min(...card.spread.series, ...(done ? card.outcome.after : [])) < 2} />
        <div className="num flex justify-between px-1 text-[10px] text-dim">
          <span>spread, last {card.spread.series.length - 1} sessions</span>
          {done && <span>{fmtDate(card.outcome.date)}</span>}
        </div>
      </div>

      <div className="mt-auto pt-2.5">
        {!done ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Choice tone="up" selected={call === 'WIDEN'} dim={call && call !== 'WIDEN'} onClick={() => setCall('WIDEN')}>WIDEN ⟷</Choice>
              <Choice tone="down" selected={call === 'NARROW'} dim={call && call !== 'NARROW'} onClick={() => setCall('NARROW')}>NARROW →←</Choice>
            </div>
            {call && <SizePicker enabled onPick={place} />}
          </>
        ) : (
          <TradeReveal
            trade={answer.trade}
            fresh={Date.now() - answer.at < 4000}
            title={`${answer.call} ${answer.lots} lot${answer.lots > 1 ? 's' : ''} · it ${card.outcome.result === 'WIDEN' ? 'widened' : 'narrowed'}`}
            detail={
              <span className="num text-right text-[12px] leading-tight text-dim">
                {fmtSigned(card.spread.now)} → <span className="font-bold text-amber">{fmtSigned(card.outcome.spread)}</span><br />{card.unit}
              </span>
            }
            why={card.why}
            source={card.source}
          />
        )}
      </div>
    </CardShell>
  );
}
