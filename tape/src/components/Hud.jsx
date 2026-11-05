import { levelFor } from '../lib/levels.js';
import { liveStreak } from '../lib/progress.js';

// Top-of-screen game stats: level + XP bar, streak, session P&L in points.
export default function Hud({ progress, session }) {
  const lvl = levelFor(progress.xp);
  const streak = liveStreak(progress.streak);
  const tone = session.score > 0 ? 'text-up' : session.score < 0 ? 'text-down' : 'text-dim';
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className="num text-sm font-bold tracking-[0.3em] text-up">TAPE</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-wider">
          <span className="truncate text-white/80">{lvl.name}</span>
          <span className="num text-dim">{progress.xp} XP</span>
        </div>
        <div className="mt-0.5 h-1 rounded bg-white/10">
          <div className="h-full rounded bg-amber" style={{ width: `${lvl.pct * 100}%` }} />
        </div>
      </div>
      <span className="num text-xs text-amber" title="Day streak">🔥{streak}</span>
      <span className={`num text-xs font-semibold ${tone}`} title="Session score">
        {session.score > 0 ? '+' : ''}{session.score}
      </span>
    </div>
  );
}
