import { useMemo, useState } from 'react';
import NextUp from '../trade/NextUp.jsx';
import { fmtMoney } from '../lib/book.js';
import { seeded } from '../lib/format.js';
import { gradeFor } from '../game/collection.js';

const GRADE_STYLE = { S: 'bg-amber text-black', A: 'bg-up text-black', B: 'bg-sky-400 text-black', C: 'bg-white/70 text-black', D: 'bg-down text-white' };
const tone = (v) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-white');

/**
 * Debrief for cargo / tank sessions: the P&L split line by line, a grade against the
 * best achievable path, what happened, why, one concept question, and (from the
 * agents add-on) the desk table. The bottom is the autoplay panel.
 */
export default function PhysDebrief({
  title, pnl, best, bestText, lines, log = [], why = [], source, concept, onConcept, extraTop = null, extraBottom = null, gradeOverride = null,
  next, onNext, onStop, extras,
}) {
  const grade = gradeOverride ?? gradeFor(pnl, Math.max(1, best));
  const [pick, setPick] = useState(null);
  const order = useMemo(() => {
    if (!concept) return [];
    const rand = seeded(`phys|${title}|${concept.id}`);
    const idx = concept.question.choices.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx;
  }, [concept, title]);
  const maxAbs = Math.max(1, ...lines.map((l) => Math.abs(l.value)));

  return (
    <div className="pop absolute inset-0 z-30 flex flex-col bg-black">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-[44px] pb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-dim">Debrief · {title}</div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className={`num text-4xl font-extrabold ${tone(pnl)}`}>{fmtMoney(Math.round(pnl))}</span>
          <span className={`num rounded px-2 py-0.5 text-lg font-extrabold ${GRADE_STYLE[grade]}`}>{grade}</span>
        </div>
        <div className="num text-[11px] text-dim">{gradeOverride ? bestText : `best achievable ${fmtMoney(Math.round(best))} · ${bestText}`}</div>

        <div className="mt-3 space-y-1.5 rounded-xl border border-line bg-panel p-3">
          {lines.map((l) => (
            <div key={l.label}>
              <div className="num flex justify-between text-[12.5px]">
                <span className="text-white/80">{l.label}</span>
                <span className={`shrink-0 whitespace-nowrap pl-2 font-bold ${tone(l.value)}`}>{fmtMoney(Math.round(l.value))}</span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-white/5">
                <div className={`h-full rounded ${l.value >= 0 ? 'bg-up' : 'bg-down'}`} style={{ width: `${(Math.abs(l.value) / maxAbs) * 100}%` }} />
              </div>
              {l.note && <div className="text-[10.5px] text-dim">{l.note}</div>}
            </div>
          ))}
        </div>

        {extraTop}

        {log.length > 0 && (
          <>
            <h3 className="mt-4 text-[10px] uppercase tracking-[0.2em] text-dim">What happened</h3>
            <ul className="num mt-1 space-y-0.5 text-[11.5px] text-white/75">
              {log.map((l, i) => <li key={i}><span className="text-dim">d{l.day + 1}</span> {l.text}</li>)}
            </ul>
          </>
        )}

        <h3 className="mt-4 text-[10px] uppercase tracking-[0.2em] text-amber">Why it moved</h3>
        <ul className="mt-1 space-y-1 text-[13.5px] leading-snug text-white/90">{why.map((w) => <li key={w}>{w}</li>)}</ul>

        {concept && (
          <div className="mt-4 rounded-xl border border-white/15 bg-panel p-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-dim">Concept · {concept.title} · +$2,500 if right</div>
            <p className="mt-2 text-[14px] font-semibold leading-snug">{concept.question.prompt}</p>
            <div className="mt-2 space-y-1.5">
              {order.map((i) => {
                const right = i === concept.question.answer;
                const look = pick === null ? 'border-line bg-black' : right ? 'border-up/60 bg-up/15 text-up' : pick === i ? 'border-down/60 bg-down/15 text-down' : 'hidden';
                return (
                  <button key={i} onClick={() => { if (pick === null) { setPick(i); onConcept?.(concept, right); } }}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left text-[13px] leading-snug ${look}`}>{concept.question.choices[i]}</button>
                );
              })}
            </div>
            {pick !== null && <p className="mt-2 text-[12.5px] leading-snug text-white/80">{concept.question.explain}</p>}
          </div>
        )}
        {extraBottom}
        {source && <p className="num mt-3 text-[9.5px] leading-snug text-white/35">{source}</p>}
      </div>
      {next && (
        <div className="pb-[env(safe-area-inset-bottom)]">
          <NextUp card={next.card} label={next.label} hold={Boolean(concept) && pick === null} onGo={onNext} onStop={onStop}>{extras}</NextUp>
        </div>
      )}
    </div>
  );
}
