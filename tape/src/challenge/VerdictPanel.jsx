import { useEffect, useRef, useState } from 'react';
import { fmtMoney } from '../lib/book.js';
import { BOTS } from '../lib/rivals.js';
import { challengeUrl } from './link.js';
import { drawScoreCard, shareCard } from './scorecard.js';

const name = (id) => BOTS.find((b) => b.id === id);

/**
 * WIN = all three checks (best bot, passive benchmark, risk budget). Also shows why a session
 * ended early (prop-firm limit), the priced-in trap, execution costs, the wager and the
 * head-to-head against a challenger.
 */
export default function VerdictPanel({ review }) {
  if (!review) return null;
  const { verdict, trap, wager, versus, costs, limitHit, hard } = review;
  return (
    <div className="mt-3 space-y-2">
      {versus && (
        <div className={`rounded-xl border p-3 ${versus.outcome === 'win' ? 'border-up/60 bg-up/10' : versus.outcome === 'lose' ? 'border-down/60 bg-down/10' : 'border-white/30 bg-panel'}`}>
          <div className="text-[10px] uppercase tracking-[0.2em] text-dim">⚔ Challenge · same tape, same bots</div>
          <div className="num mt-1 flex items-baseline justify-between">
            <span className="text-[14px] font-extrabold">{versus.outcome === 'win' ? `You beat ${versus.name}` : versus.outcome === 'lose' ? `${versus.name} beat you` : 'Dead heat'}</span>
            <span className={`text-[14px] font-bold ${versus.diff >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(versus.diff, { compact: true })}</span>
          </div>
          <div className="num text-[11.5px] text-white/75">You {fmtMoney(versus.mine)} vs {versus.name} {fmtMoney(versus.theirs)}</div>
        </div>
      )}
      <div className={`rounded-xl border p-3 ${verdict.win ? 'border-up/60 bg-up/10' : 'border-line bg-panel'}`}>
        <div className="flex items-baseline justify-between">
          <span className="text-[10px] uppercase tracking-[0.2em] text-dim">Session win: all three{hard ? ' · 🔥 HARD tape' : ''}</span>
          <span className={`num rounded px-1.5 text-[12px] font-extrabold ${verdict.win ? 'bg-up text-black' : 'bg-down text-white'}`}>{verdict.win ? 'WIN' : 'NO WIN'}</span>
        </div>
        {verdict.checks.map((c) => (
          <div key={c.key} className="num mt-1 flex items-baseline justify-between gap-2 text-[12px]">
            <span className={c.pass ? 'text-up' : 'text-down'}>{c.pass ? '✓' : '✗'} {c.label}</span>
            <span className="shrink-0 text-white/75">
              {c.key === 'risk' ? `DD ${fmtMoney(-c.you, { compact: true })} / ${fmtMoney(-c.need, { compact: true })}` : `${fmtMoney(c.you, { compact: true })} vs ${fmtMoney(c.need, { compact: true })}${c.who ? ` ${name(c.who)?.emoji ?? ''}` : ''}`}
            </span>
          </div>
        ))}
        {limitHit && <div className="num mt-1.5 rounded bg-down/20 px-2 py-1 text-[11.5px] font-bold text-down">⛔ {limitHit === 'daily' ? 'Daily loss limit' : 'Trailing drawdown cap'} hit: session ended, score locked.</div>}
      </div>
      {trap && <div className="rounded-xl border border-amber/50 bg-amber/10 px-3 py-2 text-[12.5px] leading-snug text-amber">🪤 {trap.text}{trap.fell ? ' You took the bait.' : ''}</div>}
      {costs && (costs.slip > 0 || costs.partial > 0) && (
        <div className="num rounded-lg bg-black/40 px-3 py-1.5 text-[11px] text-white/70">
          Execution: slippage {fmtMoney(-costs.slip, { compact: true })}{costs.partial ? ` · ${costs.partial} lots unfilled` : ''}
          {Object.entries(costs.frontRun ?? {}).map(([b, n]) => ` · ${name(b)?.emoji} front-ran ${n}×`).join('')}
        </div>
      )}
      {wager && (
        <div className={`num rounded-lg px-3 py-1.5 text-[12px] font-bold ${wager.outcome === 'win' ? 'bg-up/15 text-up' : wager.outcome === 'lose' ? 'bg-down/15 text-down' : 'bg-white/10'}`}>
          Wager vs {name(wager.bot)?.emoji} {name(wager.bot)?.name}: {wager.outcome === 'win' ? `won the pot, +${wager.stake} XP` : wager.outcome === 'lose' ? `lost ${wager.stake} XP` : 'push, stake returned'}
        </div>
      )}
    </div>
  );
}

/** The share sheet: the LinkedIn score card, the challenge link and the copy button. */
export function ChallengeSheet({ run: baseRun, info, onClose, onName = null }) {
  const ref = useRef(null);
  const [who, setWho] = useState(baseRun.name && baseRun.name !== 'Me' ? baseRun.name : '');
  const run = { ...baseRun, name: who.trim() || 'A trader' };
  const url = challengeUrl(run);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    drawScoreCard(ref.current, { ...info, name: run.name, pnl: run.pnl, url, hard: run.hard, standings: info.standings.map((r) => (r.me ? { ...r, name: run.name } : r)) });
  }, [who]); // eslint-disable-line react-hooks/exhaustive-deps
  const text = `I made ${fmtMoney(run.pnl)} on "${info.title}" in TAPE. Same tape, same bots: beat my run.`;
  const share = async () => setMsg((await shareCard(ref.current, { url, text })) === 'shared' ? 'Shared.' : 'Image saved, link copied.');
  const copy = async () => { try { await navigator.clipboard.writeText(url); setMsg('Link copied.'); } catch { setMsg(url); } };
  return (
    <div className="pop fixed inset-0 z-50 flex flex-col bg-black/95 px-4 pt-[44px] pb-[max(12px,env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.2em] text-amber">Challenge link · post it</span>
        <button onClick={onClose} className="num text-[11px] text-dim">CLOSE ✕</button>
      </div>
      <label className="num mt-2 flex items-center gap-2 text-[11px] text-dim">
        Your name on the card
        <input value={who} maxLength={24} placeholder="e.g. Matthias R." onChange={(e) => setWho(e.target.value)} onBlur={() => onName?.(who.trim())}
          className="min-w-0 flex-1 rounded bg-panel px-2 py-1 text-[12px] text-white outline-none" />
      </label>
      <canvas ref={ref} className="mt-2 aspect-square w-full rounded-xl border border-line" />
      <div className="num mt-2 truncate rounded-lg bg-panel px-2 py-1.5 text-[10.5px] text-white/70">{url}</div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <button onClick={share} className="num h-12 rounded-xl border border-amber/60 bg-amber/20 text-[12px] font-extrabold tracking-widest text-amber">SHARE IMAGE</button>
        <button onClick={copy} className="num h-12 rounded-xl border border-white/30 bg-panel text-[12px] font-bold tracking-widest">COPY LINK</button>
      </div>
      {msg && <p className="num mt-2 text-center text-[11px] text-up">{msg}</p>}
      <p className="mt-auto text-center text-[10px] text-white/40">Anyone who opens the link plays this exact scenario: same price path, same fills, same bots. Scores in links are self-reported.</p>
    </div>
  );
}
