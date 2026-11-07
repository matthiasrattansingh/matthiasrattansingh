import { AGENTS } from '../data/index.js';
import { fmtMoney } from '../lib/book.js';
import { TYPES, ideaEconomics } from './econ.js';

const agent = (id) => AGENTS.find((a) => a.id === id);

/** Format a series value in its own unit ($/bbl, $/day, $/MMBtu). */
export function fmtUnit(v, unit) {
  if (unit === '$/day') return `$${Math.round(v / 100) / 10}k/day`;
  const s = `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
  return unit === '$/MMBtu' ? `${s}/MMBtu` : s;
}
const qtyText = (idea, i) => {
  const own = idea.legs[i].qty; // a leg's own quantity (charter days) overrides the cargo size
  if (own) return `${own}d`;
  if (idea.unit === 'MMBtu') return `${(idea.bbl / 1e6).toFixed(1)} Bcf`;
  if (idea.unit === 'days') return `${idea.bbl}d`;
  return `${Math.round(idea.bbl / 1000)}k bbl`;
};

/**
 * A physical trade idea with its full economics up front: both legs priced, transport and
 * fees, break-even and what kills it. Thumb row: RUN IT / PASS. `by` = a rival's pitch.
 */
export default function IdeaCard({ sc, idea, entry, onRun, onPass, decided = null, compact = false }) {
  const ec = ideaEconomics(sc, idea, entry);
  const unitOf = (key) => sc.series[key].unit;
  const by = idea.by ? agent(idea.by) : null;
  const perUnit = idea.unit === 'MMBtu' ? '/MMBtu' : idea.unit === 'days' ? '/day' : '/bbl';
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden">
      <div className="flex items-center justify-between">
        <span className="num rounded bg-amber/20 px-1.5 py-0.5 text-[10px] font-extrabold tracking-wider text-amber">{TYPES[idea.type] ?? 'Idea'}</span>
        {by ? <span className="num text-[11px] font-bold" style={{ color: by.color }}>{by.emoji} {by.name} pitches</span>
          : <span className="num text-[10.5px] text-dim">{sc.days[entry]} · hold {idea.horizon}d</span>}
      </div>
      <div className="mt-1 text-[16px] font-extrabold leading-tight">{idea.title}</div>
      <p className={`mt-0.5 leading-snug text-white/75 ${compact ? 'line-clamp-2 text-[11.5px]' : 'text-[12.5px]'}`}>{by ? `“${idea.pitch}”` : idea.pitch}</p>

      <div className="num mt-1.5 rounded-lg border border-line bg-panel px-2.5 py-1 text-[11.5px]">
        {ec.legs.map((l, i) => (
          <div key={i} className="flex justify-between gap-2 py-px">
            <span className="min-w-0 truncate"><b className={l.side === 'buy' ? 'text-up' : 'text-down'}>{l.side === 'buy' ? 'BUY' : 'SELL'}</b> {l.label} <span className="text-dim">{l.at === 'exit' ? '@ exit' : 'now'} · {qtyText(idea, i)}</span></span>
            <span className="shrink-0 whitespace-nowrap font-bold">{fmtUnit(l.price, unitOf(l.series))}</span>
          </div>
        ))}
        <div className="my-0.5 border-t border-white/10" />
        {ec.costs.map((c, i) => (
          <div key={i} className="flex justify-between gap-2 py-px text-white/80">
            <span className="min-w-0 truncate">{c.label}{!compact && <span className="text-dim"> · {c.calc}</span>}</span>
            <span className="shrink-0 whitespace-nowrap text-down">−{fmtMoney(c.usd, { compact: true, sign: false })}</span>
          </div>
        ))}
      </div>

      <div className="num mt-1.5 grid grid-cols-2 gap-1.5 text-center">
        <div className="rounded-lg bg-black/40 px-1 py-1">
          <div className="text-[9px] uppercase tracking-wider text-dim">Break-even</div>
          <div className="text-[12.5px] font-bold">{ec.breakeven ? `${ec.breakeven.side === 'sell' ? '≥' : '≤'} ${fmtUnit(ec.breakeven.value, unitOf(ec.breakeven.series))}` : `${fmtUnit(ec.costPerBbl, '$')}${perUnit} costs`}</div>
          <div className="truncate text-[9.5px] text-dim">{ec.breakeven ? `${ec.breakeven.label} at exit` : 'locked at entry'}</div>
        </div>
        <div className="rounded-lg bg-black/40 px-1 py-1">
          <div className="text-[9px] uppercase tracking-wider text-dim">If nothing moves</div>
          <div className={`text-[12.5px] font-bold ${ec.edge >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(ec.edge, { compact: true })}</div>
          <div className="text-[9.5px] text-dim">{ec.edgePerBbl >= 0 ? '+' : '−'}${Math.abs(ec.edgePerBbl).toFixed(2)}{perUnit} all-in</div>
        </div>
      </div>

      <div className="mt-1.5 rounded-lg border border-down/30 bg-down/5 px-2.5 py-1">
        <div className="text-[9.5px] uppercase tracking-[0.18em] text-down">What kills this trade</div>
        {idea.killers.slice(0, compact ? 2 : 3).map((k, i) => <div key={i} className={`text-[11px] leading-snug text-white/80 ${compact ? 'truncate' : ''}`}>· {k}</div>)}
      </div>
      </div>

      <div className="shrink-0 pt-2">
        {decided ? (
          <div className={`num rounded-xl border px-3 py-2.5 text-center text-sm font-bold ${decided.ran ? 'border-amber/50 text-amber' : 'border-white/20 text-white/70'}`}>{decided.text}</div>
        ) : (
          <div className="grid grid-cols-[1.4fr_1fr] gap-2">
            <button onClick={onRun} className="num rounded-xl border border-up/60 bg-up/20 py-3.5 text-sm font-extrabold tracking-widest text-up active:scale-[.97]">RUN IT</button>
            <button onClick={onPass} className="num rounded-xl border border-white/30 bg-panel py-3.5 text-sm font-bold tracking-widest text-white/80 active:scale-[.97]">PASS</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A scheduler decision: the prompt and 2-3 choices. Only the cost you'd pay now is shown;
 * consequences arrive as dollars when they land.
 */
export function DecisionCard({ decision, chosen = null, onChoose, sheet = false }) {
  return (
    <div className={sheet ? '' : 'flex h-full flex-col'}>
      <div className="num text-[10px] font-extrabold tracking-[0.2em] text-sky-300">SCHEDULER</div>
      <div className="mt-0.5 text-[15.5px] font-extrabold leading-tight">{decision.title.replace(/^Scheduler: (.)/, (_, ch) => ch.toUpperCase())}</div>
      <p className="mt-1 text-[12.5px] leading-snug text-white/80">{decision.prompt}</p>
      <div className={`${sheet ? 'mt-2' : 'mt-auto'} space-y-1.5`}>
        {decision.options.map((o, i) => (
          <button key={i} disabled={chosen != null} onClick={() => onChoose(i)}
            className={`num flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left text-[13px] font-bold transition active:scale-[.98] ${
              chosen === i ? 'border-sky-300 bg-sky-400/20 text-sky-100' : chosen != null ? 'border-white/10 text-white/40' : 'border-sky-300/50 bg-panel text-white'}`}>
            <span>{o.label}</span>
            {o.now?.usd ? <span className={o.now.usd >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(o.now.usd, { compact: true })} now</span> : <span className="text-dim">—</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
