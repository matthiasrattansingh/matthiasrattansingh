import { SESSION_CARDS } from '../data/index.js';
import { fmtMoney } from '../lib/book.js';
import { collectionStats } from '../game/collection.js';
import { cardDate, cardKind, cardTitle } from '../lib/cards.js';
import { integratedUnlocked, INTEGRATED_UNLOCK_CARGOES } from '../physical/ledger.js';

const GRADE_STYLE = {
  S: 'bg-amber text-black', A: 'bg-up text-black', B: 'bg-sky-400 text-black', C: 'bg-white/70 text-black', D: 'bg-down text-white',
};

const yearOf = (c) => cardDate(c).slice(0, 4);
const nameOf = (c) => cardTitle(c);
const shortDate = (c) => new Date(`${cardDate(c)}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** One collectible: played = name, date, best P&L, grade; unplayed = a silhouette. */
function Tile({ card, row, onOpen, missed, locked }) {
  if (locked) {
    return (
      <div className="flex aspect-[3/4] flex-col items-center justify-center rounded-xl border border-sky-400/20 bg-sky-500/[.04] p-2 text-center">
        <span className="text-2xl opacity-50">🔒</span>
        <span className="num mt-1 text-[10px] font-bold text-sky-300/70">two-book</span>
        <span className="num text-[9px] text-dim">{INTEGRATED_UNLOCK_CARGOES} cargoes to unlock</span>
      </div>
    );
  }
  if (missed) {
    return (
      <div className="flex aspect-[3/4] flex-col justify-between rounded-xl border border-dashed border-white/15 bg-white/[.03] p-2 opacity-60 grayscale">
        <span className="num text-[9px] uppercase tracking-wider text-dim">missed</span>
        <div>
          <div className="truncate text-[11px] font-bold text-white/60">{missed.title}</div>
          <div className="num text-[9px] text-dim">{missed.date}</div>
        </div>
      </div>
    );
  }
  if (!row) {
    return (
      <button onClick={() => onOpen(card.id)} className="flex aspect-[3/4] flex-col items-center justify-center rounded-xl border border-line bg-[repeating-linear-gradient(45deg,#111,#111_6px,#151515_6px,#151515_12px)] p-2 text-center active:scale-95">
        <span className="text-2xl opacity-30">{card.type === 'cargo' ? '🚢' : card.type === 'tank' ? '🛢️' : '📈'}</span>
        <span className="num mt-1 text-[11px] font-bold text-white/40">??? — {yearOf(card)}</span>
      </button>
    );
  }
  return (
    <button onClick={() => onOpen(card.id)} className="relative flex aspect-[3/4] flex-col justify-between rounded-xl border border-white/15 bg-panel p-2 text-left active:scale-95">
      <span className={`num absolute top-1.5 right-1.5 rounded px-1.5 text-[11px] font-extrabold ${GRADE_STYLE[row.grade]}`}>{row.grade}</span>
      <span className={`num text-[9px] uppercase tracking-wider ${card.type === 'cargo' || card.type === 'tank' ? 'text-amber' : 'text-dim'}`}>{cardKind(card)}</span>
      <div>
        <div className="truncate text-[12px] font-extrabold">{nameOf(card)}</div>
        <div className="num text-[9px] text-dim">{shortDate(card)}</div>
        <div className={`num mt-0.5 text-[11px] font-bold ${row.best > 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(row.best, { compact: true })}</div>
      </div>
    </button>
  );
}

// LIBRARY: every session as a collectible card. Tap one to trade it (again).
export default function Library({ progress, onOpen, specials = [] }) {
  const stats = collectionStats(progress, SESSION_CARDS.length);
  const sorted = [...SESSION_CARDS].sort((a, b) => yearOf(a).localeCompare(yearOf(b)));
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="num text-2xl font-extrabold">{stats.collected}/{stats.total} <span className="text-sm font-bold text-dim">collected</span></span>
        <span className="num text-sm font-bold text-amber">{stats.s} S-grade{stats.s === 1 ? '' : 's'}</span>
      </div>
      <div className="mt-1 h-1.5 rounded bg-white/10"><div className="h-full rounded bg-amber" style={{ width: `${(stats.collected / stats.total) * 100}%` }} /></div>
      <p className="mt-1 text-[11px] text-dim">S = within 90% of holding the right side at 5 lots · A 70% · B 45% · C any profit · D lost money</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {sorted.map((c) => <Tile key={c.id} card={c} row={progress.played[c.id]} onOpen={onOpen} locked={c.mode === 'integrated' && !integratedUnlocked(progress)} />)}
      </div>
      {specials.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">Event specials</h3>
          <div className="grid grid-cols-3 gap-2">
            {specials.map((sp) => (sp.played
              ? <div key={sp.date} className="flex aspect-[3/4] flex-col justify-between rounded-xl border border-amber/40 bg-amber/10 p-2">
                  <span className="num text-[9px] uppercase tracking-wider text-amber">special</span>
                  <div>
                    <div className="truncate text-[11px] font-bold">{sp.title}</div>
                    <div className="num text-[9px] text-dim">{sp.date}</div>
                    <div className={`num text-[11px] font-bold ${sp.pnl > 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(sp.pnl, { compact: true })}</div>
                  </div>
                </div>
              : <Tile key={sp.date} missed={sp} />))}
          </div>
        </>
      )}
    </div>
  );
}
