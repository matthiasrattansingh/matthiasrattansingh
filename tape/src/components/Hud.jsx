import { levelFor } from '../lib/levels.js';
import { comboMultiplier, fmtMoney, START_BANKROLL } from '../lib/book.js';
import { DESK_CARDS } from '../data/index.js';
import { ideaMarks } from '../desk/feed.js';

/** Open physical ideas stay on screen across swipes: total mark and the nearest settle. */
function IdeaPill({ progress }) {
  const open = progress.phys?.ideas?.open ?? [];
  if (!open.length) return null;
  const marks = ideaMarks(progress, DESK_CARDS);
  const total = marks.reduce((s, m) => s + m.mtm, 0);
  const soon = Math.min(...marks.map((m) => m.left));
  return (
    <div className="mt-0.5 flex justify-end px-1">
      <span className="num rounded-full border border-amber/40 bg-black/80 px-2 py-px text-[10px] font-bold text-amber">
        📦 {open.length} <span className={total >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(Math.round(total), { compact: true })}</span> · {soon} swipe{soon === 1 ? '' : 's'}
      </span>
    </div>
  );
}

const TABS = [
  { id: 'trade', label: 'TRADE' },
  { id: 'bell', label: 'BELL' },
  { id: 'desk', label: 'DESK' },
  { id: 'eia', label: 'EIA' },
  { id: 'live', label: 'LIVE' },
  { id: 'me', label: 'ME' },
];

// Top bar: tabs, then bankroll, win-streak multiplier and level/XP.
export default function Hud({ progress, tab, onTab, liveStatus, bellDone, compact }) {
  const lvl = levelFor(progress.xp);
  const up = progress.bankroll - START_BANKROLL;
  const mult = comboMultiplier(progress.combo);
  return (
    <div className="px-3 pt-1.5">
      <nav className="pointer-events-auto flex justify-between">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => onTab(t.id)}
            className={`num relative rounded-md px-2 py-1 text-[11px] font-bold tracking-[0.15em] ${
              tab === t.id ? 'bg-white/15 text-white' : 'text-dim'}`}>
            {t.label}
            {t.id === 'live' && liveStatus === 'live' && <span className="ml-0.5 text-up">●</span>}
            {t.id === 'bell' && !bellDone && <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-down" />}
          </button>
        ))}
      </nav>
      <IdeaPill progress={progress} />
      {!compact && <div className="mt-1 flex items-center gap-2 px-1">
        <span className={`num text-sm font-bold ${up > 0 ? 'text-up' : up < 0 ? 'text-down' : 'text-white'}`}>
          {fmtMoney(progress.bankroll, { sign: false })}
        </span>
        {progress.combo >= 2 && (
          <span key={progress.combo} className="num pop rounded bg-amber/20 px-1.5 text-[11px] font-bold text-amber">
            🔥{progress.combo} ×{mult}
          </span>
        )}
        <span className="flex-1" />
        <span className="num text-[9px] uppercase tracking-wider text-white/60">{lvl.name}</span>
        <div className="h-1 w-14 rounded bg-white/10">
          <div className="h-full rounded bg-amber transition-[width] duration-500" style={{ width: `${lvl.pct * 100}%` }} />
        </div>
      </div>}
    </div>
  );
}
