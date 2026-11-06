import { Fragment, useEffect, useRef, useState } from 'react';
import { BOTS } from '../lib/rivals.js';
import { fmtMoney, START_BANKROLL } from '../lib/book.js';
import { localDay, todayDesk } from '../lib/progress.js';
import Rings from '../components/Rings.jsx';
import { questText, QUEST_XP } from '../game/quests.js';
import { DEMOTE, PROMOTE, SEATS, TIER_ICON, myLeagueXp, standings } from '../game/league.js';
import { specialFor } from '../game/calendar.js';
import { SESSION_CARDS } from '../data/index.js';

function Board({ title, rows, fmt }) {
  return (
    <>
      <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">{title}</h3>
      <ol className="space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.id} className={`num flex items-center justify-between rounded-lg border px-3 py-2.5 text-sm ${
            r.id === 'you' ? 'border-amber/50 bg-amber/10' : 'border-line bg-panel'}`}>
            <span>{i === 0 ? '👑' : `${i + 1}.`} {r.emoji} {r.name}</span>
            <span className={r.value > (fmt === 'bank' ? START_BANKROLL : 0) ? 'text-up' : r.value < (fmt === 'bank' ? START_BANKROLL : 0) ? 'text-down' : 'text-dim'}>
              {fmtMoney(r.value, { sign: fmt !== 'bank' })}
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Today({ progress }) {
  const d = todayDesk(progress.day);
  const me = { id: 'you', name: 'You', emoji: '🫵' };
  const todayRows = [{ ...me, value: d.you }, ...BOTS.map((b) => ({ ...b, value: d.bots[b.id] ?? 0 }))].sort((a, b) => b.value - a.value);
  const bankRows = [{ ...me, value: progress.bankroll }, ...BOTS.map((b) => ({ ...b, value: progress.bots[b.id] ?? START_BANKROLL }))].sort((a, b) => b.value - a.value);
  const rank = todayRows.findIndex((r) => r.id === 'you') + 1;
  return (
    <>
      <div className="mt-4 rounded-2xl border border-amber/40 bg-amber/10 p-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Today on the desk</div>
        <div className="mt-1 text-2xl font-extrabold">{rank === 1 ? '👑 You’re #1' : `You’re #${rank} of 5`}</div>
        <p className="mt-1 text-[13px] text-white/75">
          {rank === 1 ? 'Defend the top spot.' : `${fmtMoney(todayRows[0].value - d.you, { sign: false })} behind ${todayRows[0].name}.`}
        </p>
      </div>
      <Board title="Today’s P&L" rows={todayRows} />
      <Board title="Account value, all-time" rows={bankRows} fmt="bank" />
      <div className="mt-6 grid grid-cols-2 gap-2">
        {[
          ['Best win streak', `🔥${progress.bestCombo}`],
          ['Biggest win', fmtMoney(progress.bigWin)],
          ['Peak account', fmtMoney(progress.peak, { sign: false })],
          ['Margin calls', `💀 ${progress.blowups}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl border border-line bg-panel p-3">
            <div className="text-[10px] uppercase tracking-wider text-dim">{k}</div>
            <div className="num mt-0.5 text-lg font-bold">{v}</div>
          </div>
        ))}
      </div>
      <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">Your rivals (bots)</h3>
      <ul className="space-y-1.5">
        {BOTS.map((b) => (
          <li key={b.id} className="rounded-lg border border-line bg-panel px-3 py-2">
            <div className="text-sm font-semibold">{b.emoji} {b.name}</div>
            <div className="text-[12px] text-dim">{b.style}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

function League({ progress }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(id); }, []);
  const meRef = useRef(null);
  const [meVisible, setMeVisible] = useState(false);
  useEffect(() => {
    if (!meRef.current) return undefined;
    const io = new IntersectionObserver(([e]) => setMeVisible(e.isIntersecting), { threshold: 0.9 });
    io.observe(meRef.current);
    return () => io.disconnect();
  });
  if (!progress.league) return null;
  const table = standings(progress, now);
  const me = table.find((r) => r.me);
  const [y, m, d] = progress.league.week.split('-').map(Number);
  const close = new Date(y, m - 1, d + 7);
  const hoursLeft = Math.max(0, Math.round((close - now) / 3_600_000));
  const zone = (rank) => (rank <= PROMOTE ? 'promote' : rank > SEATS - DEMOTE ? 'demote' : null);
  const row = (r, pinned) => (
    <li key={`${r.id}${pinned ? '-pin' : ''}`} ref={r.me && !pinned ? meRef : undefined}
      className={`num flex items-center gap-2 rounded-lg border px-2.5 py-2 text-[13px] ${
        r.me ? (pinned ? 'border-amber/70 bg-[#2b2104] shadow-[0_-8px_20px_rgba(0,0,0,.8)]' : 'border-amber/70 bg-amber/15') : zone(r.rank) === 'promote' ? 'border-up/25 bg-up/[.06]' : zone(r.rank) === 'demote' ? 'border-down/25 bg-down/[.06]' : 'border-line bg-panel'}`}>
      <span className={`w-6 text-right text-[11px] ${zone(r.rank) === 'promote' ? 'text-up' : zone(r.rank) === 'demote' ? 'text-down' : 'text-dim'}`}>{r.rank}</span>
      <span className="flex h-6 w-6 items-center justify-center rounded-full text-[13px]" style={{ background: `${r.color}33` }}>{r.emoji}</span>
      <span className={`flex-1 truncate ${r.me ? 'font-extrabold text-amber' : ''}`}>{r.name}</span>
      <span className="text-white/80">{r.xp.toLocaleString()} XP</span>
    </li>
  );
  return (
    <>
      <div className="mt-4 rounded-2xl border border-white/15 bg-panel p-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-dim">{TIER_ICON[progress.league.tier]} {progress.league.tier} league · week of {new Date(`${progress.league.week}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
        <div className="mt-1 text-2xl font-extrabold">#{me.rank} of {SEATS}</div>
        <p className="mt-1 text-[12.5px] text-white/75">
          {myLeagueXp(progress).toLocaleString()} XP this week · ends in {hoursLeft}h · top {PROMOTE} promote, bottom {DEMOTE} drop
        </p>
      </div>
      <ol className="mt-3 space-y-1">
        {table.map((r) => (
          <Fragment key={r.id}>
            {r.rank === PROMOTE + 1 && <li key="pz" className="num py-1 text-center text-[9px] tracking-widest text-up">▲ PROMOTION ZONE ▲</li>}
            {r.rank === SEATS - DEMOTE + 1 && <li key="dz" className="num py-1 text-center text-[9px] tracking-widest text-down">▼ DEMOTION ZONE ▼</li>}
            {row(r, false)}
          </Fragment>
        ))}
      </ol>
      {!meVisible && <div className="sticky bottom-2 mt-2">{row(me, true)}</div>}
    </>
  );
}

// The desk: today's rings and quests, then today vs the bots or the weekly league.
export default function Desk({ progress }) {
  const [view, setView] = useState('today');
  const date = localDay();
  const quests = progress.quests?.date === date ? progress.quests.list : [];
  const special = specialFor(progress, date, SESSION_CARDS);
  return (
    <div className="h-[100dvh] overflow-y-auto">
      <div className="mx-auto max-w-md px-4 pt-20 pb-10">
        {special && (
          <div className={`mb-3 rounded-xl border px-3 py-2 ${special.played ? 'border-up/40 bg-up/10' : 'border-amber/60 bg-amber/15'}`}>
            <div className={`num text-[12px] font-extrabold tracking-wide ${special.played ? 'text-up' : 'text-amber'}`}>
              ⭐ {special.label} — {special.played ? 'played ✓' : 'today only'}
            </div>
            <div className="text-[11.5px] text-white/75">{special.blurb}{special.time ? ` (${special.time})` : ''} {special.played ? '' : 'It’s next up in TRADE.'}</div>
          </div>
        )}
        <div className="rounded-2xl border border-line bg-panel p-3">
          <Rings progress={progress} />
          <ul className="mt-3 space-y-1">
            {quests.map((q) => (
              <li key={q.t} className={`flex items-center gap-2 text-[12.5px] ${q.done ? 'text-up' : 'text-white/85'}`}>
                <span>{q.done ? '✅' : '◻️'}</span>
                <span className={`flex-1 ${q.done ? 'line-through decoration-up/50' : ''}`}>{questText(q)}</span>
                <span className="num text-[10px] text-dim">+$1k +{QUEST_XP}XP</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-white/5 p-1">
          {['today', 'league'].map((v) => (
            <button key={v} onClick={() => setView(v)} className={`num rounded-md py-1.5 text-[11px] font-bold tracking-widest ${view === v ? 'bg-white/15 text-white' : 'text-dim'}`}>
              {v === 'today' ? 'TODAY' : `LEAGUE ${progress.league ? TIER_ICON[progress.league.tier] : ''}`}
            </button>
          ))}
        </div>
        {view === 'today' ? <Today progress={progress} /> : <League progress={progress} />}
      </div>
    </div>
  );
}
