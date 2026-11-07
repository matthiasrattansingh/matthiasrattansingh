import { Suspense, lazy, useState } from 'react';
import { levelFor, LEVELS } from '../lib/levels.js';
import { CATEGORIES, liveStreak } from '../lib/progress.js';
import { ALL_CARDS } from '../data/index.js';
import { fmtMoney } from '../lib/book.js';
import { soundOn, setSoundOn } from '../lib/sound.js';
import { cashOutRide } from '../lib/progress.js';
import { hedgeAverage, physLevel, PHYS_LEVELS, integratedUnlocked, INTEGRATED_UNLOCK_CARGOES } from '../physical/ledger.js';
import { TIER_ICON } from '../game/league.js';
import Library from './Library.jsx';
import EvalPanel from './EvalPanel.jsx';
// Forecast scores read ~5 years of EIA weeks: code-split.
const ForecastStats = lazy(() => import('../forecast/ForecastStats.jsx'));

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

const VIEWS = [['profile', 'PROFILE'], ['library', 'LIBRARY'], ['eval', 'EVAL']];

/** The PHYSICAL career track: desk P&L, cargoes, lifetime hedge grade. */
function PhysicalTrack({ progress, apply }) {
  const ph = progress.phys;
  const lvl = physLevel(ph.xp);
  const hedge = hedgeAverage(progress);
  return (
    <div className="mt-3 rounded-2xl border border-sky-400/40 bg-sky-500/10 p-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-sky-300">Physical track · level {lvl.index + 1} of {PHYS_LEVELS.length}</div>
      <div className="text-2xl font-extrabold">{lvl.name}</div>
      <p className="mt-0.5 text-[13px] text-white/75">{lvl.blurb}</p>
      <div className="mt-3 h-2 rounded bg-white/10"><div className="h-full rounded bg-sky-400" style={{ width: `${lvl.pct * 100}%` }} /></div>
      <div className="num mt-1 flex justify-between text-[11px] text-dim">
        <span>{ph.xp} physical XP</span>
        <span>{lvl.next ? `${lvl.next.minXp - ph.xp} to ${lvl.next.name}` : 'Top of the chain'}</span>
      </div>
      <div className="num mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-black/40 p-2"><div className="text-[9px] uppercase text-dim">Desk P&L</div><div className={`text-sm font-bold ${ph.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(ph.pnl, { compact: true })}</div></div>
        <div className="rounded-lg bg-black/40 p-2"><div className="text-[9px] uppercase text-dim">Cargo · tank</div><div className="text-sm font-bold">{ph.cargoes} · {ph.tanks}</div></div>
        <div className="rounded-lg bg-black/40 p-2"><div className="text-[9px] uppercase text-dim">Hedge grade</div><div className="text-sm font-bold text-sky-200">{hedge ? `${hedge.letter} (${hedge.avg.toFixed(1)})` : '—'}</div></div>
      </div>
      <div className="num mt-2 grid grid-cols-2 gap-2 text-center">
        <div className="rounded-lg bg-black/40 p-2">
          <div className="text-[9px] uppercase text-dim">Idea cards · {ph.ideas?.run ?? 0} run · {ph.ideas?.passed ?? 0} passed</div>
          <div className={`text-sm font-bold ${(ph.ideas?.pnl ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(ph.ideas?.pnl ?? 0, { compact: true })}<span className="text-[10.5px] font-normal text-dim"> · right {ph.ideas?.right ?? 0}/{ph.ideas?.calls ?? 0}</span></div>
        </div>
        <div className="rounded-lg bg-black/40 p-2">
          <div className="text-[9px] uppercase text-dim">Desk scenarios</div>
          <div className="text-sm font-bold">{ph.desks ?? 0}<span className="text-[10.5px] font-normal text-dim"> · calls right {ph.deskRight ?? 0}/{ph.deskCalls ?? 0}</span></div>
        </div>
      </div>
      <div className="num mt-2 flex items-center justify-between rounded-lg bg-black/40 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-dim">Negotiation edge</span>
        <span className="text-sm font-bold">
          <span className={(ph.negotiation?.edge ?? 0) >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(ph.negotiation?.edge ?? 0, { compact: true })}</span>
          <span className="text-[11px] font-normal text-dim"> · {ph.negotiation?.deals ?? 0} deals · {ph.negotiation?.pulled ?? 0} bids pulled on you</span>
        </span>
      </div>
      <label className="num mt-2 flex items-center justify-between gap-2 text-[10.5px] text-dim">
        <span>Name the counterparties use</span>
        <input value={progress.playerName ?? ''} maxLength={16} placeholder="(none)"
          onChange={(e) => { const v = e.target.value; apply?.((p) => ({ progress: { ...p, playerName: v } })); }}
          className="w-28 rounded bg-black/50 px-2 py-1 text-right text-[12px] text-white outline-none" />
      </label>
      <p className="mt-2 text-[11px] text-dim">
        {integratedUnlocked(progress) ? `Two-book sessions unlocked · ${ph.integrated} played${hedge ? ` · lifetime hedge average over ${hedge.n}` : ''}` : `Two-book sessions unlock after ${INTEGRATED_UNLOCK_CARGOES} cargoes (${ph.cargoes}/${INTEGRATED_UNLOCK_CARGOES}).`}
      </p>
    </div>
  );
}

// ME: profile, the LIBRARY collection and the prop-firm EVAL.
export default function Profile({ progress, session, onReset, apply, onOpenSession, onTrade, specials, view: initial = 'profile' }) {
  const [view, setView] = useState(initial);
  return (
    <div className="h-[100dvh] overflow-y-auto">
      <div className="mx-auto max-w-md px-4 pt-20 pb-10">
        <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-white/5 p-1">
          {VIEWS.map(([v, label]) => (
            <button key={v} onClick={() => setView(v)} className={`num rounded-md py-1.5 text-[11px] font-bold tracking-widest ${view === v ? 'bg-white/15 text-white' : 'text-dim'}`}>
              {label}{v === 'eval' && progress.eval?.status === 'active' ? ' ●' : ''}
            </button>
          ))}
        </div>
        {view === 'profile' && <ProfileBody progress={progress} session={session} onReset={onReset} apply={apply} />}
        {view === 'library' && <Library progress={progress} onOpen={onOpenSession} specials={specials} />}
        {view === 'eval' && <EvalPanel progress={progress} apply={apply} onTrade={onTrade} />}
      </div>
    </div>
  );
}

// Profile: level ladder, streak, scores, accuracy by category, miss queue.
function ProfileBody({ progress, session, onReset, apply }) {
  const [confirm, setConfirm] = useState(false);
  const [sound, setSound] = useState(soundOn);
  const lvl = levelFor(progress.xp);
  const misses = Object.entries(progress.misses).sort((a, b) => a[1].due - b[1].due);
  const total = Object.values(progress.stats).reduce((a, s) => ({ right: a.right + s.right, total: a.total + s.total }), { right: 0, total: 0 });

  return (
    <>
        {progress.funded && <div className="num mb-2 rounded-lg border border-amber/60 bg-amber/15 py-1.5 text-center text-xs font-extrabold tracking-[0.3em] text-amber">🏆 FUNDED TRADER</div>}
        <div className="rounded-2xl border border-amber/40 bg-amber/10 p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Paper track · level {lvl.index + 1} of {LEVELS.length}</div>
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

        {progress.ride?.active && (
          <div className="mt-3 flex items-center justify-between rounded-xl border border-up/40 bg-up/10 px-3 py-2.5">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-up">Ride balance</div>
              <div className="num text-xl font-extrabold text-up">{fmtMoney(progress.ride.balance)}</div>
              <div className="text-[11px] text-dim">Lost in full on your next losing session.</div>
            </div>
            <button onClick={() => apply((p) => ({ progress: cashOutRide(p) }))}
              className="num rounded-lg border border-up/60 px-3 py-2 text-xs font-extrabold tracking-wider text-up">CASH OUT</button>
          </div>
        )}

        <PhysicalTrack progress={progress} apply={apply} />

        <Suspense fallback={null}><ForecastStats progress={progress} /></Suspense>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <Stat label="Day streak" value={`📅${liveStreak(progress.streak)}`} tone="text-amber" />
          <Stat label="Best days" value={progress.streak.best} />
          <Stat label="Answered" value={progress.answered} />
          <Stat label="Session P&L" value={fmtMoney(session.pnl, { compact: true })}
            tone={session.pnl > 0 ? 'text-up' : session.pnl < 0 ? 'text-down' : 'text-white'} />
          <Stat label="Best session" value={fmtMoney(progress.bestSession, { compact: true })} />
          <Stat label="Hit rate" value={total.total ? `${Math.round((total.right / total.total) * 100)}%` : '—'} />
        </div>

        <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">League history</h3>
        {progress.leagueHistory?.length ? (
          <ul className="space-y-1">
            {progress.leagueHistory.map((h) => (
              <li key={h.week} className="num flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px]">
                <span>{TIER_ICON[h.tier]} {h.tier} · week of {h.week}</span>
                <span className={h.result === 'promoted' ? 'text-up' : h.result === 'demoted' ? 'text-down' : 'text-dim'}>#{h.rank} · {h.result}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-dim">{progress.league ? `${TIER_ICON[progress.league.tier]} ${progress.league.tier} league in progress. Results land here every Monday.` : 'Your first league starts now.'}</p>
        )}

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
        {/* Which deploy is this? Matches the commit and time in GitHub Actions. */}
        <p className="num mt-3 text-center text-[10px] text-white/30">build {__BUILD__}</p>
    </>
  );
}
