import { useEffect, useState } from 'react';
import { fmtMoney } from '../lib/book.js';
import { botById } from '../lib/rivals.js';

/** Counts a number up from 0 like a P&L ticker. */
function useTicker(target, ms = 900, delay = 250) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf;
    const start = performance.now() + delay;
    const tick = (t) => {
      const k = Math.min(1, Math.max(0, (t - start) / ms));
      setV(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, delay]);
  return v;
}

function buzz(win) {
  try { navigator.vibrate?.(win ? [20, 40, 30] : [80]); } catch { /* not supported */ }
}

// Result panel for a trade: the P&L ticker, combo multiplier, how the desk did
// on the same card, then the "why" lines and source.
export default function TradeReveal({ trade, title, detail, why = [], source, fresh }) {
  const [showSrc, setShowSrc] = useState(false);
  const shown = useTicker(trade.pnl, fresh ? 900 : 1, fresh ? 250 : 0);
  useEffect(() => { if (fresh) buzz(trade.win); }, [fresh, trade.win]);

  const beat = trade.bots.filter((b) => trade.pnl > b.pnl).length;
  const win = trade.pnl > 0;
  const tone = win ? 'text-up' : trade.pnl < 0 ? 'text-down' : 'text-dim';
  return (
    <div className={`pop rounded-2xl border p-3 ${win ? 'border-up/40 bg-up/10' : 'border-down/40 bg-down/10'} ${
      fresh ? (win ? 'win-glow' : 'loss-shake') : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="num truncate text-[11px] uppercase tracking-wider text-white/70">{title}</span>
        {trade.mult > 1 && <span className="num shrink-0 rounded bg-amber/20 px-1.5 text-[11px] font-bold text-amber">🔥 ×{trade.mult}</span>}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span className={`num text-3xl font-extrabold leading-tight ${tone}`}>{fmtMoney(Math.round(shown))}</span>
        {detail}
      </div>

      {trade.bots.length > 0 && (
        <div className="rise mt-1.5" style={{ animationDelay: fresh ? '1s' : '0s' }}>
          <div className="num flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px]">
            {trade.bots.map((b) => (
              <span key={b.id} className={b.pnl > trade.pnl ? 'text-white/90' : 'text-dim'}>
                {botById[b.id].emoji} {b.call[0]}{b.lots} <span className={b.pnl > 0 ? 'text-up' : b.pnl < 0 ? 'text-down' : ''}>{fmtMoney(b.pnl, { compact: true })}</span>
              </span>
            ))}
          </div>
          <div className={`num mt-0.5 text-[11px] font-bold ${beat === 4 ? 'text-amber' : beat >= 2 ? 'text-up' : 'text-down'}`}>
            {beat === 4 ? '👑 You beat the whole desk' : `Beat ${beat}/4 of the desk`}
          </div>
        </div>
      )}

      {why.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-[12.5px] leading-snug text-white/85">
          {why.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {source && (
        <button className="mt-1 block text-left text-[10px] leading-snug tracking-wide text-dim" onClick={() => setShowSrc((s) => !s)}>
          {showSrc ? source : 'ⓘ SOURCE'}
        </button>
      )}
    </div>
  );
}
