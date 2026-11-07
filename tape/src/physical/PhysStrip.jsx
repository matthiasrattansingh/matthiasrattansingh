import { fmtMoney } from '../lib/book.js';

const k = (v) => fmtMoney(Math.round(v), { compact: true });

/**
 * You vs the desk in a physical session: each agent's live P&L at the current
 * day/week (from their own runs, which only ever read the past).
 */
export default function PhysStrip({ runs, step, mine, ghost = null }) {
  const g = ghost?.length ? ghost[Math.min(step, ghost.length - 1)] : null;
  return (
    <div className="num flex items-center justify-between gap-1 whitespace-nowrap border-t border-line px-3 py-1 text-[10.5px]">
      <span className={`font-bold ${mine > 0 ? 'text-up' : mine < 0 ? 'text-down' : 'text-white'}`}>YOU {k(mine)}</span>
      {g != null && <span className={`font-bold ${mine >= g ? 'text-up' : 'text-sky-300'}`} title="your best run at this point">👻{k(g)}</span>}
      {runs.map((r) => {
        const v = r.history[step] ?? (step >= r.history.length - 1 ? r.pnl : 0);
        const ahead = v > mine;
        return (
          <span key={r.agent.id} className={ahead ? 'font-bold text-white' : 'text-white/40'} title={r.summary}>
            {r.agent.emoji}<span className={v > 0 ? 'text-up' : v < 0 ? 'text-down' : ''}>{k(v)}</span>
          </span>
        );
      })}
    </div>
  );
}
