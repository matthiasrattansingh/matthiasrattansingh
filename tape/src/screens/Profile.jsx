import { useState } from 'react';
import { levelFor, LEVELS } from '../lib/levels.js';
import { CATEGORIES, liveStreak } from '../lib/progress.js';
import { ALL_CARDS } from '../data/index.js';
import { fmtMoney } from '../lib/book.js';
import { soundOn, setSoundOn } from '../lib/sound.js';

const byId = new Map(ALL_CARDS.map((c) => [c.id, c]));
const titleOf = (c) => c?.title ?? c?.headline ?? c?.name ?? c?.id;

function Stat({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className={`num mt-0.5 text-xl font-bold ${tone}`}>{value}</div>
    </div>
  );
}

// Profile: level ladder, streak, scores, accuracy by category, miss queue.
export default function Profile({ progress, session, onReset }) {
  const [confirm, setConfirm] = useState(false);
  const [sound, setSound] = useState(soundOn);
  const lvl = levelFor(progress.xp);
  const misses = Object.entries(progress.misses).sort((a, b) => a[1].due - b[1].due);
  const total = Object.values(progress.stats).reduce((a, s) => ({ right: a.right + s.right, total: a.total + s.total }), { right: 0, total: 0 });

  return (
    <div className="h-[100dvh] overflow-y-auto">
      <div className="mx-auto max-w-md px-4 pt-20 pb-10">
        <div className="rounded-2xl border border-amber/40 bg-amber/10 p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Level {lvl.index + 1} of {LEVELS.length}</div>
          <div className="text-2xl font-extrabold">{lvl.name}</div>
          <p className="mt-0.5 text-[13px] text-white/75">{lvl.blurb}</p>
          <div className="mt-3 h-2 rounded bg-white/10">
            <div className="h-full rounded bg-amber" style={{ width: `${lvl.pct * 100}%` }} />
          </div>
          <div className="num mt-1 flex justify-between text-[11px] text-dim">
            <span>{progress.xp} XP</span>
            <span>{lvl.next ? `${lvl.next.minXp - progress.xp} to ${lvl.next.name}` : 'Top of the desk'}</span>
          </div>
          <div className="mt-3 flex gap-1">
            {LEVELS.map((l, i) => (
              <div key={l.name} className={`num flex-1 rounded px-1 py-1 text-center text-[9px] uppercase tracking-wide ${
                i <= lvl.index ? 'bg-amber/25 text-amber' : 'bg-white/5 text-dim'}`}>
                {l.name}
              </div>
            ))}
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Day streak" value={`📅${liveStreak(progress.streak)}`} tone="text-amber" />
          <Stat label="Best days" value={progress.streak.best} />
          <Stat label="Answered" value={progress.answered} />
          <Stat label="Session P&L" value={fmtMoney(session.pnl, { compact: true })}
            tone={session.pnl > 0 ? 'text-up' : session.pnl < 0 ? 'text-down' : 'text-white'} />
          <Stat label="Best session" value={fmtMoney(progress.bestSession, { compact: true })} />
          <Stat label="Hit rate" value={total.total ? `${Math.round((total.right / total.total) * 100)}%` : '—'} />
        </div>

        <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">Accuracy by category</h3>
        <div className="space-y-2">
          {Object.entries(CATEGORIES).map(([key, label]) => {
            const s = progress.stats[key] ?? { right: 0, total: 0 };
            const pct = s.total ? s.right / s.total : 0;
            const tone = !s.total ? 'bg-white/20' : pct >= 0.6 ? 'bg-up' : pct >= 0.4 ? 'bg-amber' : 'bg-down';
            return (
              <div key={key} className="rounded-xl border border-line bg-panel p-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold">{label}</span>
                  <span className="num text-sm">
                    {s.total ? `${Math.round(pct * 100)}%` : '—'}
                    <span className="ml-2 text-[11px] text-dim">{s.right}/{s.total}</span>
                  </span>
                </div>
                <div className="mt-2 h-1.5 rounded bg-white/10">
                  <div className={`h-full rounded ${tone}`} style={{ width: `${pct * 100}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">
          Miss queue · {misses.length} card{misses.length === 1 ? '' : 's'}
        </h3>
        {misses.length === 0 ? (
          <p className="text-sm text-dim">Nothing queued. Cards you get wrong come back here, then resurface in the feed.</p>
        ) : (
          <ul className="space-y-1.5">
            {misses.map(([id, m]) => (
              <li key={id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-panel px-3 py-2">
                <span className="truncate text-[13px]">{titleOf(byId.get(id))}</span>
                <span className="num shrink-0 text-[10px] text-dim">
                  {m.due <= progress.answered ? 'due now' : `in ${m.due - progress.answered}`} · step {m.step + 1}/3
                </span>
              </li>
            ))}
          </ul>
        )}

        <button onClick={() => { setSoundOn(!sound); setSound(!sound); }}
          className="mt-6 flex w-full items-center justify-between rounded-xl border border-line bg-panel px-3 py-3">
          <span className="text-sm font-semibold">Trading sounds <span className="text-[11px] font-normal text-dim">tick on close, thud on a big loss</span></span>
          <span className={`num rounded-full px-2.5 py-0.5 text-xs font-bold ${sound ? 'bg-up text-black' : 'bg-white/10 text-dim'}`}>{sound ? 'ON' : 'OFF'}</span>
        </button>

        <div className="mt-8 text-center">
          {confirm ? (
            <div className="space-x-2">
              <button onClick={() => { onReset(); setConfirm(false); }} className="num rounded-lg border border-down/50 px-3 py-2 text-xs text-down">
                Yes, wipe progress
              </button>
              <button onClick={() => setConfirm(false)} className="num rounded-lg border border-line px-3 py-2 text-xs text-dim">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirm(true)} className="num text-[11px] uppercase tracking-wider text-dim">Reset progress</button>
          )}
        </div>
      </div>
    </div>
  );
}
