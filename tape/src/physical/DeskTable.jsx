import { fmtMoney } from '../lib/book.js';

const k = (v) => fmtMoney(Math.round(v), { compact: true });
const tone = (v) => (v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-white/70');

/**
 * Cargo / tank debrief: you and each agent, P&L split the same way, one line on what
 * they did, ranked. cols: [{ key, label }] picks which split parts to show.
 */
export default function DeskTable({ me, runs, cols }) {
  const rows = [
    { id: 'you', name: 'You', emoji: '🫵', pnl: me.pnl, split: me.split, summary: me.summary },
    ...runs.map((r) => ({ id: r.agent.id, name: r.agent.name, emoji: r.agent.emoji, pnl: r.pnl, split: r.split, summary: r.summary })),
  ].sort((a, b) => b.pnl - a.pnl);
  const rank = rows.findIndex((r) => r.id === 'you') + 1;
  return (
    <div className="mt-4 rounded-xl border border-line bg-panel p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-[0.2em] text-dim">The desk on this {me.kind}</span>
        <span className={`num text-sm font-extrabold ${rank === 1 ? 'text-amber' : 'text-white'}`}>{rank === 1 ? '👑 #1' : `#${rank} of ${rows.length}`}</span>
      </div>
      <ol className="num mt-1 space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.id} className={`rounded-lg px-2 py-1 ${r.id === 'you' ? 'bg-amber/10' : 'bg-black/30'}`}>
            <div className="flex justify-between text-[12px]">
              <span className={r.id === 'you' ? 'font-bold text-amber' : 'text-white/90'}>{i + 1}. {r.emoji} {r.id === 'you' ? 'You' : r.name}</span>
              <span className={`font-bold ${tone(r.pnl)}`}>{k(r.pnl)}</span>
            </div>
            <div className="flex flex-wrap gap-x-2.5 text-[10px]">
              {cols.map((c) => <span key={c.key} className="text-dim">{c.label} <span className={tone(r.split?.[c.key] ?? 0)}>{k(r.split?.[c.key] ?? 0)}</span></span>)}
            </div>
          </li>
        ))}
      </ol>
      <ul className="mt-2 space-y-0.5 text-[11.5px] text-white/75">
        {rows.filter((r) => r.summary).map((r) => <li key={r.id}>{r.emoji} {r.summary}</li>)}
      </ul>
    </div>
  );
}
