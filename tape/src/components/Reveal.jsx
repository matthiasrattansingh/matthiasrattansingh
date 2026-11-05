import { useState } from 'react';

// Shared result panel: right/wrong banner, points, the "why" lines and a source note.
export default function Reveal({ correct, points, title, children, why = [], source }) {
  const [showSrc, setShowSrc] = useState(false);
  return (
    <div className={`pop rounded-2xl border p-3.5 ${correct ? 'border-up/40 bg-up/10' : 'border-down/40 bg-down/10'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`num text-base font-extrabold ${correct ? 'text-up' : 'text-down'}`}>
          {correct ? '✓ ' : '✗ '}{title}
        </span>
        {points !== undefined && (
          <span className={`num shrink-0 text-sm font-bold ${points > 0 ? 'text-up' : points < 0 ? 'text-down' : 'text-dim'}`}>
            {points > 0 ? '+' : ''}{points} pts
          </span>
        )}
      </div>
      {children}
      {why.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px] leading-snug text-white/85">
          {why.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {source && (
        <button className="mt-2 block text-left text-[10px] leading-snug tracking-wide text-dim" onClick={() => setShowSrc((s) => !s)}>
          {showSrc ? source : 'ⓘ SOURCE'}
        </button>
      )}
    </div>
  );
}
