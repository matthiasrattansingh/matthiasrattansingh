import { useEffect } from 'react';
import { botById } from '../lib/rivals.js';
import { fmtMoney } from '../lib/book.js';
import { unread } from '../game/chat.js';

function ago(at) {
  const m = Math.round((Date.now() - at) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

/** The CHAT pill with its unread badge (shown between sessions, never on the trading screen). */
export function ChatButton({ progress, onOpen }) {
  const n = unread(progress);
  return (
    <button onClick={onOpen} className="num relative h-9 shrink-0 whitespace-nowrap rounded-lg border border-white/20 bg-black px-3 text-[11px] font-bold tracking-widest">
      💬 CHAT
      {n > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[18px] rounded-full bg-down px-1 text-[10px] leading-[18px] text-white">{n}</span>}
    </button>
  );
}

/** Desk chat as a bottom sheet. The only action is accepting a challenge. */
export default function ChatSheet({ progress, onClose, onRead, onAccept }) {
  useEffect(() => { onRead(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const msgs = [...(progress.chat?.msgs ?? [])].reverse();
  const ch = progress.chat?.challenge;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div className="pop mx-auto flex max-h-[78dvh] w-full max-w-md flex-col rounded-t-2xl border-t border-line bg-[#0c0d0f]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <span className="num text-sm font-extrabold tracking-widest">💬 DESK CHAT</span>
          <button onClick={onClose} className="num text-xs text-dim">CLOSE ✕</button>
        </div>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {msgs.length === 0 && <li className="py-6 text-center text-sm text-dim">Quiet on the desk. Trade a session and they’ll have opinions.</li>}
          {msgs.map((m) => {
            const b = botById[m.bot];
            const isLive = m.challenge && ch?.id === m.challenge;
            return (
              <li key={m.id} className={`rounded-xl px-3 py-2 ${m.kind === 'challenge' ? 'border border-amber/50 bg-amber/10' : 'bg-white/[.05]'}`}>
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] font-bold">{b?.emoji} {b?.name}</span>
                  <span className="num text-[10px] text-dim">{ago(m.at)}</span>
                </div>
                <p className="mt-0.5 text-[13.5px] leading-snug text-white/90">{m.text}</p>
                {isLive && (
                  ch.status === 'open' ? (
                    <button onClick={() => onAccept(ch)} className="num mt-2 h-10 w-full rounded-lg border border-amber/70 bg-amber/20 text-[12px] font-extrabold tracking-widest text-amber">
                      ACCEPT · BEAT {fmtMoney(ch.target, { compact: true })} ⚔️
                    </button>
                  ) : (
                    <div className={`num mt-1 text-[11px] font-bold ${ch.status === 'won' ? 'text-up' : ch.status === 'lost' || ch.status === 'expired' ? 'text-down' : 'text-amber'}`}>
                      {ch.status === 'accepted' ? 'ACCEPTED: play it from TRADE today' : ch.status.toUpperCase()}
                    </div>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
