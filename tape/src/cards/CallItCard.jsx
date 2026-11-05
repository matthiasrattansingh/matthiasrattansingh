import { useState } from 'react';
import CardShell from '../components/CardShell.jsx';
import Sparkline from '../components/Sparkline.jsx';
import Choice from '../components/Choice.jsx';
import Reveal from '../components/Reveal.jsx';
import { scoreCallIt } from '../lib/scoring.js';
import { fmtDate, fmtPrice, fmtSigned, fmtPct, toneFor } from '../lib/format.js';

const CALLS = [
  { id: 'LONG', tone: 'up', label: 'LONG ▲' },
  { id: 'FLAT', tone: 'flat', label: 'FLAT' },
  { id: 'SHORT', tone: 'down', label: 'SHORT ▼' },
];

// CALL IT: a real historical moment, chart drawn only up to the decision.
// Pick a direction, then size it (conviction 1-3) to lock the call in.
export default function CallItCard({ card, answer, onAnswer, badge }) {
  const [call, setCall] = useState(null);
  const done = Boolean(answer);
  const res = answer?.result;
  const perBbl = card.unit === '$/gal';

  const lock = (conviction) => {
    const result = scoreCallIt(card, call, conviction);
    onAnswer({ call, conviction, result }, result);
  };

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

      <p className={`mt-3 font-semibold leading-snug ${done ? 'text-[13px] text-white/80' : 'text-[15px]'}`}>{card.headline}</p>
      {!done && (
        <ul className="mt-1.5 space-y-1 text-[13px] leading-snug text-white/70">
          {card.setup.map((s) => <li key={s}>{s}</li>)}
        </ul>
      )}

      <div className={`rounded-xl border border-line bg-panel px-2 py-2 ${done ? 'mt-2' : 'mt-3'}`}>
        <Sparkline data={card.series} after={card.after} showAfter={done} height={done ? 52 : 88} zeroLine={done && res.move < 0 && card.outcome.price < 0} />
        <div className="num flex justify-between px-1 text-[10px] text-dim">
          <span>{card.series.length - 1}d before</span>
          <span className="text-amber">● decision</span>
          {done && <span>{fmtDate(card.outcome.date)}</span>}
        </div>
      </div>

      <div className="mt-auto pt-3">
        {!done ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              {CALLS.map((c) => (
                <Choice key={c.id} tone={c.tone} selected={call === c.id} dim={call && call !== c.id} onClick={() => setCall(c.id)}>
                  {c.label}
                </Choice>
              ))}
            </div>
            <div className={`mt-2 transition-opacity ${call ? 'opacity-100' : 'pointer-events-none opacity-30'}`}>
              <div className="mb-1 text-center text-[10px] uppercase tracking-[0.2em] text-dim">size it · conviction locks your call</div>
              <div className="grid grid-cols-3 gap-2">
                {[1, 2, 3].map((n) => (
                  <Choice key={n} tone="amber" onClick={() => lock(n)}>{'●'.repeat(n)}{'○'.repeat(3 - n)}</Choice>
                ))}
              </div>
            </div>
          </>
        ) : (
          <Reveal
            correct={res.correct}
            points={res.points}
            title={`${answer.call} ×${answer.conviction} · went ${res.actual}`}
            why={card.why}
            source={card.source}
          >
            <div className="num mt-1.5 flex flex-wrap items-baseline gap-x-3 text-sm">
              <span className={`text-xl font-bold ${toneFor(res.move)}`}>
                {fmtSigned(res.move, perBbl ? 4 : 2)}{perBbl ? '/gal' : ''}
              </span>
              <span className={toneFor(res.move)}>{fmtPct(res.pct)}</span>
              {perBbl && <span className="text-dim">≈ {fmtSigned(res.moveBbl)}/bbl</span>}
              <span className="text-dim">→ {fmtPrice(card.outcome.price, card.unit)}</span>
            </div>
          </Reveal>
        )}
      </div>
    </CardShell>
  );
}
