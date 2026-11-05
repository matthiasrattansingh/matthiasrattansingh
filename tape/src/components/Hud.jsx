import { levelFor } from '../lib/levels.js';
import { liveStreak } from '../lib/progress.js';

const TABS = [
  { id: 'feed', label: 'FEED' },
  { id: 'live', label: 'LIVE' },
  { id: 'me', label: 'ME' },
];

// Top-of-screen bar: tabs, streak, session score, then level + XP bar.
export default function Hud({ progress, session, tab, onTab, liveStatus }) {
  const lvl = levelFor(progress.xp);
  const streak = liveStreak(progress.streak);
  const tone = session.score > 0 ? 'text-up' : session.score < 0 ? 'text-down' : 'text-dim';
  return (
    <div className="px-4 pt-1.5">
      <div className="flex items-center gap-3">
        <nav className="pointer-events-auto flex gap-1">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => onTab(t.id)}
              className={`num rounded-md px-2 py-1 text-[11px] font-bold tracking-[0.2em] ${
                tab === t.id ? 'bg-white/15 text-white' : 'text-dim'
              }`}>
              {t.label}
              {t.id === 'live' && liveStatus === 'live' && <span className="ml-1 text-up">●</span>}
            </button>
          ))}
        </nav>
        <span className="flex-1" />
        <span className="num text-xs text-amber" title="Day streak">🔥{streak}</span>
        <span className={`num min-w-8 text-right text-xs font-semibold ${tone}`} title="Session score">
          {session.score > 0 ? '+' : ''}{session.score}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="num text-[9px] uppercase tracking-wider text-white/70">{lvl.name}</span>
        <div className="h-1 flex-1 rounded bg-white/10">
          <div className="h-full rounded bg-amber transition-[width] duration-500" style={{ width: `${lvl.pct * 100}%` }} />
        </div>
        <span className="num text-[9px] text-dim">{progress.xp} XP</span>
      </div>
    </div>
  );
}
