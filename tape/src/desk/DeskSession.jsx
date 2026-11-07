import { useEffect, useMemo, useRef, useState } from 'react';
import { AGENTS } from '../data/index.js';
import { fmtMoney } from '../lib/book.js';
import { PhysChart } from '../physical/PhysChart.js';
import PhysStrip from '../physical/PhysStrip.jsx';
import { ideaPnl } from './econ.js';
import IdeaCard, { DecisionCard, fmtUnit } from './IdeaCard.jsx';
import { actionable, advance, botPitch, buildDesk, decide, deskMark, finishDesk, ideaFor, newDeskState, pass, run } from './scenario.js';

const SERIES_COLORS = ['#ffb000', '#7dd3fc', '#f472b6'];
const longDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** The scenario's main series, drawn up to today. */
function DeskChart({ sc, day }) {
  const ref = useRef(null);
  const chart = useRef(null);
  const keys = sc.chart.filter((k) => sc.series[k].unit === sc.series[sc.chart[0]].unit).slice(0, 2);
  useEffect(() => {
    chart.current = new PhysChart(ref.current, { steps: sc.D, labelOf: (i) => sc.days[i]?.slice(5) ?? '', decimals: sc.series[keys[0]].unit === '$/day' ? 0 : 2 });
    return () => chart.current.destroy();
  }, [sc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    chart.current?.set(keys.map((k, i) => ({ name: sc.series[k].label, color: SERIES_COLORS[i], values: sc.series[k].values.slice(0, day + 1) })), day + 1);
  }, [day, sc]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="block h-full w-full" />;
}

/**
 * DESK session: a physical dislocation as a short feed. Cards render only up to the first
 * one you haven't answered, so you can't swipe past a decision. Each card moves the clock
 * to its day; the desk P&L and the rivals' strip stay on screen.
 */
export default function DeskSession({ card, onFinish, onPitch }) {
  const sc = useMemo(() => buildDesk(card), [card]);
  const [st, setSt] = useState(newDeskState);
  const [answers, setAnswers] = useState({}); // stepIdx -> { ran } | { option }
  const [view, setView] = useState(0);
  const ideas = useMemo(() => sc.steps.map((step) => ideaFor(sc, step)), [sc]);
  const pitched = useRef(new Set());
  const box = useRef(null);

  // Cards up to (and including) the first unanswered actionable one; then the close-out card.
  let upto = sc.steps.findIndex((s, i) => actionable(s) && answers[i] == null);
  const all = upto < 0;
  if (all) upto = sc.steps.length - 1;
  const shown = sc.steps.slice(0, upto + 1);
  const cards = all ? [...shown, { kind: 'close', day: sc.D - 1 }] : shown;
  const day = (cards[Math.min(view, cards.length - 1)] ?? cards[0]).day;

  useEffect(() => { setSt((s) => advance(s, day)); }, [day]);
  // Rivals pitch in desk chat when their card comes up.
  useEffect(() => {
    const step = sc.steps[view];
    if (step?.kind === 'pitch' && !pitched.current.has(view)) {
      pitched.current.add(view);
      onPitch?.(step.by, ideas[view]);
    }
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = () => {
    const el = box.current;
    if (el) setView(Math.round(el.scrollTop / el.clientHeight));
  };
  const nextCard = (i) => setTimeout(() => box.current?.scrollTo({ top: (i + 1) * box.current.clientHeight, behavior: 'smooth' }), 450);

  const answer = (i, a) => { setAnswers((x) => ({ ...x, [i]: a })); nextCard(i); };
  const onRun = (i) => { setSt((s) => run(sc, advance(s, sc.steps[i].day), i, ideas[i], AGENTS)); answer(i, { ran: true }); };
  const onPass = (i) => { setSt((s) => pass(sc, advance(s, sc.steps[i].day), i, ideas[i])); answer(i, { ran: false }); };
  const onChoose = (i, k) => { setSt((s) => decide(advance(s, sc.steps[i].day), i, sc.steps[i], k, sc.steps[i].day)); answer(i, { option: k }); };

  const mark = deskMark(sc, st, day);
  // Rivals' live books: their own pitches so far, plus the mirror of any deal they're on the other side of.
  const runs = useMemo(() => AGENTS.map((a) => {
    const history = Array.from({ length: sc.D }, (_, d) => {
      let v = 0;
      sc.steps.forEach((step) => { if (step.kind === 'pitch' && step.by === a.id && step.day <= d) v += ideaPnl(sc, botPitch(sc, a.id, step.day), step.day, d); });
      st.positions.forEach((p) => { if (p.counterparty === a.id && p.entry <= d) v -= ideaPnl(sc, p.idea, p.entry, d); });
      return v;
    });
    return { agent: a, history, pnl: history[sc.D - 1], summary: a.name };
  }), [sc, st.positions]);

  const close = () => onFinish({ sc, st, result: finishDesk(sc, advance(st, sc.D - 1), AGENTS) });

  return (
    <div className="flex h-[100dvh] flex-col bg-black pt-[38px]">
      <div className="px-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12.5px] font-extrabold">🛢️ {sc.title}</span>
          <span className="num shrink-0 text-[10.5px] text-dim">day {day + 1}/{sc.D} · {longDate(sc.days[day])}</span>
        </div>
        <div className="flex items-end justify-between">
          <span className={`num text-[22px] font-extrabold leading-tight ${mark.total > 0 ? 'text-up' : mark.total < 0 ? 'text-down' : 'text-white'}`}>{fmtMoney(Math.round(mark.total))}</span>
          <span className="num pb-1 text-right text-[10px] leading-tight text-dim">desk book · ideas {fmtMoney(Math.round(mark.ideas), { compact: true })}<br />scheduler {fmtMoney(Math.round(mark.sched), { compact: true })} · {st.positions.length} open</span>
        </div>
      </div>
      <div className="relative h-[64px] px-1">
        <DeskChart sc={sc} day={day} />
        <span className="num absolute top-0 right-3 text-[9.5px] text-dim">
          {sc.chart.slice(0, 2).map((k) => `${sc.series[k].label} ${fmtUnit(sc.series[k].values[day], sc.series[k].unit)}${sc.series[k].kind === 'modeled' ? ' (modeled)' : ''}`).join(' · ')}
        </span>
      </div>
      <PhysStrip runs={runs} step={day} mine={mark.total} />

      <div ref={box} onScroll={onScroll} className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-scroll">
        {cards.map((step, i) => (
          <section key={i} className="h-full snap-start snap-always px-3 pt-2 pb-[max(10px,env(safe-area-inset-bottom))]">
            {step.kind === 'news' && (
              <div className="flex h-full flex-col">
                <div className="num text-[10px] font-extrabold tracking-[0.2em] text-down">NEWS · {longDate(sc.days[step.day])}</div>
                <div className="mt-1 text-[19px] font-extrabold leading-tight">{step.headline}</div>
                <p className="mt-1.5 text-[13px] leading-snug text-white/80">{step.text}</p>
                <div className="num mt-2 space-y-1">
                  {step.series.map((k) => (
                    <div key={k} className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5 text-[12.5px]">
                      <span className="text-dim">{sc.series[k].label}{sc.series[k].kind === 'modeled' ? ' · modeled' : ''}</span>
                      <b>{fmtUnit(sc.series[k].values[step.day], sc.series[k].unit)}</b>
                    </div>
                  ))}
                </div>
                <div className="num mt-auto text-center text-[11px] text-white/50">↓ swipe</div>
              </div>
            )}
            {(step.kind === 'idea' || step.kind === 'pitch') && (
              <IdeaCard sc={sc} idea={ideas[i]} entry={step.day} compact
                decided={answers[i] ? { ran: answers[i].ran, text: answers[i].ran ? `▶ RUNNING · settles day ${Math.min(step.day + ideas[i].horizon, sc.D - 1) + 1}` : 'PASSED · we will see at the close' } : null}
                onRun={() => onRun(i)} onPass={() => onPass(i)} />
            )}
            {step.kind === 'decision' && <DecisionCard decision={step} chosen={answers[i]?.option ?? null} onChoose={(k) => onChoose(i, k)} />}
            {step.kind === 'close' && (
              <div className="flex h-full flex-col">
                <div className="num text-[10px] font-extrabold tracking-[0.2em] text-amber">CLOSE OF BOOK · {longDate(sc.days[sc.D - 1])}</div>
                <div className="mt-1 text-[19px] font-extrabold leading-tight">Every position settles at its horizon.</div>
                <p className="mt-1.5 text-[13px] text-white/80">Scheduler bills still in the post land now. Then the desk table: you vs the four rivals, and every call you made.</p>
                <div className="num mt-3 space-y-1 text-[12px]">
                  {st.positions.map((p, k) => (
                    <div key={k} className="flex justify-between rounded-lg border border-line bg-panel px-3 py-1.5"><span className="truncate">{p.idea.title}</span><span>{p.counterparty ? `vs ${AGENTS.find((a) => a.id === p.counterparty)?.emoji}` : ''}</span></div>
                  ))}
                </div>
                <button onClick={close} className="num mt-auto w-full rounded-xl border border-amber/60 bg-amber/20 py-3.5 text-sm font-extrabold tracking-widest text-amber">CLOSE THE BOOK ▶</button>
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
