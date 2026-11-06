import { useMemo } from 'react';
import FORECAST from '../data/forecast.json'; // code-split with this component
import { AGENTS } from '../data/index.js';
import { AGENT_RULES, CLASS_NAMES, UNIT, agentSeason, classesFor, printStats, reactionStats } from './engine.js';

const LABEL = { petroleum: 'Crude print (MMbbl)', gas: 'Gas storage (Bcf)' };

/**
 * ME → FORECASTS. Two skills scored separately:
 *  PRINT: mean absolute error vs two dumb baselines on the same weeks (repeat-last-week, and
 *         consensus where it's stored), plus the desk on the same weeks.
 *  REACTION: did you call release-day direction right (vs the naive "draw = up" rule).
 * Then each agent's long-run record on the whole real dataset.
 */
export default function ForecastStats({ progress }) {
  const rows = useMemo(() => ['petroleum', 'gas'].map((kind) => {
    const records = FORECAST[kind];
    const classes = classesFor(FORECAST, kind);
    return {
      kind, classes,
      print: printStats(kind, records, classes, progress.forecast.prints[kind]),
      reaction: reactionStats(kind, records, progress.forecast.reactions[kind]),
      season: agentSeason(kind, records, classes),
    };
  }), [progress.forecast]);

  return (
    <div className="mt-3 rounded-2xl border border-line bg-panel p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Forecasts · real EIA weeks</div>
      {rows.map(({ kind, print, reaction, season }) => {
        const d = kind === 'gas' ? 0 : 2;
        const f = (v) => (v == null ? '—' : v.toFixed(d));
        const beatLast = print.n && print.mae < print.baselines.repeatLast;
        const cons = print.baselines.consensus;
        const beatCons = cons && cons.mine < cons.mae;
        return (
          <div key={kind} className="mt-3">
            <div className="text-[12px] font-bold">{LABEL[kind]}</div>
            {print.n === 0 ? (
              <p className="text-[11px] text-dim">No weeks yet. Open the EIA tab.</p>
            ) : (
              <>
                <div className="num mt-1 grid grid-cols-3 gap-1.5 text-center">
                  <div className="rounded-lg bg-black/40 p-1.5"><div className="text-[9px] uppercase text-dim">Print MAE · {print.n}wk</div><div className="text-sm font-bold">{f(print.mae)}</div></div>
                  <div className="rounded-lg bg-black/40 p-1.5"><div className="text-[9px] uppercase text-dim">Repeat last wk</div><div className={`text-sm font-bold ${beatLast ? 'text-up' : 'text-down'}`}>{f(print.baselines.repeatLast)}</div></div>
                  <div className="rounded-lg bg-black/40 p-1.5"><div className="text-[9px] uppercase text-dim">Consensus{cons ? ` · ${cons.n}wk` : ''}</div><div className={`text-sm font-bold ${cons ? (beatCons ? 'text-up' : 'text-down') : 'text-dim'}`}>{cons ? `${f(cons.mae)} vs ${f(cons.mine)}` : 'n/a'}</div></div>
                </div>
                <p className="num mt-1 text-[10.5px] text-white/70">
                  {beatLast ? 'You beat repeat-last-week.' : 'Repeat-last-week beats you.'}{' '}
                  {cons ? (beatCons ? 'You beat consensus on the weeks it is stored.' : 'Consensus beats you on the weeks it is stored.') : kind === 'petroleum' ? 'Consensus is stored only for cited weeks; none played yet.' : 'No consensus stored for gas.'}
                </p>
                <div className="num mt-1 grid grid-cols-4 gap-1 text-center text-[10px]">
                  {CLASS_NAMES.map((n) => <div key={n} className="whitespace-nowrap rounded bg-black/40 py-0.5"><div className="text-[9.5px] text-dim">{n} {print.byClass[n].n}</div><div className="font-bold">{print.byClass[n].n ? `±${f(print.byClass[n].mae)}` : '—'}</div></div>)}
                </div>
                <div className="num mt-1 text-[10px] uppercase tracking-wider text-dim">Desk MAE on the same weeks</div>
                <div className="num grid grid-cols-4 gap-1 text-center text-[11px]">
                  {AGENTS.map((a) => <span key={a.id} className="whitespace-nowrap" style={{ color: a.color }}>{a.emoji} {f(print.agents[a.id])}</span>)}
                </div>
              </>
            )}
            <div className="num mt-1.5 flex items-center justify-between rounded-lg bg-black/40 px-3 py-1.5 text-[11px]">
              <span className="uppercase tracking-wider text-dim">Reaction</span>
              <span>{reaction.n ? <><b className={reaction.right / reaction.n >= 0.5 ? 'text-up' : 'text-down'}>{reaction.right}/{reaction.n}</b> right · naive rule {reaction.naive}/{reaction.n}</> : <span className="text-dim">no calls yet</span>}</span>
            </div>
            <details className="mt-1.5">
              <summary className="num cursor-pointer text-[10.5px] text-dim">Desk, whole dataset ({season.quinn.n} weeks): error by size class</summary>
              <table className="num mt-1 w-full text-[10.5px]">
                <thead><tr className="text-dim"><th className="text-left font-normal">agent</th><th className="text-right font-normal">MAE</th>{CLASS_NAMES.map((n) => <th key={n} className="text-right font-normal">{n[0]}</th>)}<th className="text-right font-normal">avg size</th></tr></thead>
                <tbody>
                  {AGENTS.map((a) => {
                    const s = season[a.id];
                    return (
                      <tr key={a.id} title={AGENT_RULES[a.id]}>
                        <td style={{ color: a.color }}>{a.emoji} {a.name.split(' ').pop()}</td>
                        <td className="text-right font-bold">{f(s.mae)}</td>
                        {CLASS_NAMES.map((n) => <td key={n} className="text-right">{f(s.byClass[n])}</td>)}
                        <td className="text-right">{f(s.avgSize)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-1 text-[10.5px] text-white/70">
                Dan calls a tail every week: {f(season.dan.mae)} {UNIT[kind]} average error vs Quinn's {f(season.quinn.mae)}. On FLAT weeks he's off by {f(season.dan.byClass.FLAT)}; even on HUGE weeks he only gets to {f(season.dan.byClass.HUGE)}.
              </p>
            </details>
          </div>
        );
      })}
    </div>
  );
}
