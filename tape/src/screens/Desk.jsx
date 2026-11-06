import { BOTS } from '../lib/rivals.js';
import { fmtMoney, START_BANKROLL } from '../lib/book.js';
import { todayDesk } from '../lib/progress.js';

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

// The desk: you vs four rival bots, today and all-time.
export default function Desk({ progress }) {
  const d = todayDesk(progress.day);
  const me = { id: 'you', name: 'You', emoji: '🫵' };
  const todayRows = [{ ...me, value: d.you }, ...BOTS.map((b) => ({ ...b, value: d.bots[b.id] ?? 0 }))].sort((a, b) => b.value - a.value);
  const bankRows = [{ ...me, value: progress.bankroll }, ...BOTS.map((b) => ({ ...b, value: progress.bots[b.id] ?? START_BANKROLL }))].sort((a, b) => b.value - a.value);
  const rank = todayRows.findIndex((r) => r.id === 'you') + 1;

  return (
    <div className="h-[100dvh] overflow-y-auto">
      <div className="mx-auto max-w-md px-4 pt-20 pb-10">
        <div className="rounded-2xl border border-amber/40 bg-amber/10 p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Today on the desk</div>
          <div className="mt-1 text-3xl font-extrabold">{rank === 1 ? '👑 You’re #1' : `You’re #${rank} of 5`}</div>
          <p className="mt-1 text-[13px] text-white/75">
            {d.trades ? `${d.trades} trade${d.trades > 1 ? 's' : ''} today. ` : 'No trades yet today. '}
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
        <p className="mt-6 text-center text-[11px] text-dim">
          Win streaks pay: 2 in a row ×1.25 · 3 ×1.5 · 5+ ×2 on winning trades. Play money only.
        </p>
      </div>
    </div>
  );
}
