import { useState } from 'react';
import CardShell from '../components/CardShell.jsx';
import Sparkline from '../components/Sparkline.jsx';
import Choice from '../components/Choice.jsx';
import SizePicker from '../components/SizePicker.jsx';
import TradeReveal from '../components/TradeReveal.jsx';
import { scoreCallIt } from '../lib/scoring.js';
import { fmtDate, fmtPrice, fmtSigned, fmtPct, toneFor } from '../lib/format.js';

const CALLS = [
  { id: 'LONG', tone: 'up', label: 'LONG ▲' },
  { id: 'FLAT', tone: 'flat', label: 'FLAT ↔' },
  { id: 'SHORT', tone: 'down', label: 'SHORT ▼' },
];
const CONVICTION = { 1: 1, 2: 2, 5: 3 }; // lots -> conviction for XP scoring

// CALL IT: a real historical moment, chart drawn only up to the decision.
// Pick a direction, then a size: that places the trade in play money.
export default function CallItCard({ card, answer, onAnswer, badge }) {
  const [call, setCall] = useState(null);
  const done = Boolean(answer?.trade);
  const perGal = card.unit === '$/gal';
  const move = card.outcome.price - card.decision.price;
  const pct = (move / Math.abs(card.decision.price)) * 100;

  const place = (lots) => onAnswer({ call, lots }, scoreCallIt(card, call, CONVICTION[lots]));

  return (
    <CardShell kicker={`CALL IT · ${card.category}`} badge={badge}>
      <div className="flex items-baseline justify-between">
        <span className="num text-xs text-dim">{fmtDate(card.decision.date)}</span>
        <span className="num text-[10px] uppercase tracking-wider text-dim">horizon {card.horizon}</span>
      </div>

      <div className="mt-1 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xl font-extrabold leading-tight">{card.instrument}</div>
          <div className="truncate text-[11px] text-dim">{card.contract}</div>
        </div>
        <div className="text-right">
          <div className="num text-3xl font-bold leading-none">{fmtPrice(card.decision.price, card.unit)}</div>
          <div className="num mt-1 text-[11px] text-dim">{card.unit}</div>
        </div>
      </div>

      {!done && <p className="mt-2.5 text-[15px] font-semibold leading-snug">{card.headline}</p>}
      {!done && !call && (
        <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-white/70">
          {card.setup.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}

      <div className={`rounded-xl border border-line bg-panel px-2 py-1.5 ${done ? 'mt-2' : 'mt-3'}`}>
        <Sparkline data={card.series} after={card.after} showAfter={done} height={done ? 56 : 68}
          zeroLine={done && card.outcome.price < 0} />
        <div className="num flex justify-between px-1 text-[10px] text-dim">
          <span>{card.series.length - 1}d before</span>
          <span className="text-amber">● you are here</span>
          {done && <span>{fmtDate(card.outcome.date)}</span>}
        </div>
      </div>

      <div className="mt-auto pt-2.5">
        {!done ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {CALLS.map((c) => (
                <Choice key={c.id} tone={c.tone} selected={call === c.id} dim={call && call !== c.id} onClick={() => setCall(c.id)}>
                  {c.label}
                </Choice>
              ))}
            </div>
            {call && <SizePicker enabled onPick={place} />}
          </>
        ) : (
          <TradeReveal
            trade={answer.trade}
            fresh={Date.now() - answer.at < 4000}
            title={`${answer.call} ${answer.lots} lot${answer.lots > 1 ? 's' : ''}${answer.call === 'FLAT' ? ' (short vol)' : ''}`}
            detail={
              <span className={`num text-right text-[12px] leading-tight ${toneFor(move)}`}>
                {fmtSigned(move, perGal ? 4 : 2)}{perGal ? '/gal' : ''}<br />{fmtPct(pct)} → {fmtPrice(card.outcome.price, card.unit)}
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
