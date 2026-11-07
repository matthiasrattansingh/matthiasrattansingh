import { useState } from 'react';
import { BOTS } from '../lib/rivals.js';
import { STAKES, cancelWager, canWager, placeWager } from './wager.js';

/** Stake XP against one named bot before the next session: winner takes the pot. */
export default function WagerBar({ progress, apply }) {
  const w = progress.wager;
  const [bot, setBot] = useState('dan');
  if (w) {
    const b = BOTS.find((x) => x.id === w.bot);
    return (
      <div className="num mb-1.5 flex items-center justify-between rounded-md border border-amber/50 bg-amber/10 px-2 py-1 text-[11px] font-bold text-amber">
        <span>🎲 {w.stake} XP on beating {b?.emoji} {b?.name} · pot {w.stake * 2}</span>
        <button onClick={() => apply((p) => ({ progress: cancelWager(p) }))} className="text-[10px] text-white/60">cancel</button>
      </div>
    );
  }
  return (
    <div className="num mb-1.5 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-[10.5px]">
      <span className="text-dim">🎲 stake vs</span>
      {BOTS.map((b) => (
        <button key={b.id} onClick={() => setBot(b.id)} className={`rounded px-1 ${bot === b.id ? 'bg-white/20' : ''}`}>{b.emoji}</button>
      ))}
      {STAKES.map((s) => (
        <button key={s} disabled={!canWager(progress, s)} onClick={() => apply((p) => ({ progress: placeWager(p, bot, s) }))}
          className="rounded border border-amber/40 px-1.5 py-0.5 font-bold text-amber disabled:opacity-30">{s}</button>
      ))}
      <span className="text-dim">XP</span>
    </div>
  );
}
