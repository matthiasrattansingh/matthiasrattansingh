import { useCallback, useRef, useState } from 'react';
import TradeSession from '../trade/TradeSession.jsx';
import { createFeed } from '../lib/feed.js';
import { comboMultiplier, fmtMoney } from '../lib/book.js';
import { botDecisions, simulate } from '../trade/engine.js';
import { BOTS } from '../lib/rivals.js';
import { SESSION_CARDS } from '../data/index.js';

// TRADE: an endless run of sessions. Sessions you lose come back via the
// miss queue (about 1 in 5), same as cards did.
export default function Trade({ progress, record }) {
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const feedRef = useRef(null);
  if (!feedRef.current) feedRef.current = createFeed(SESSION_CARDS);
  const [current, setCurrent] = useState(() => feedRef.current.next(1, progress)[0]);
  const [result, setResult] = useState(null);

  const onFinish = useCallback(({ session, sim }) => {
    const p = progressRef.current;
    const win = sim.final > 0;
    const mult = win ? comboMultiplier(p.combo) : 1;
    const pnl = Math.round(sim.final * mult);
    const bots = BOTS.map((b) => ({ id: b.id, pnl: Math.round(simulate(session, botDecisions(b.id, session, current.key)).final) }));
    const trade = { pnl, base: Math.round(sim.final), mult, win, bots };
    record({
      cardId: session.id,
      category: session.card.category,
      correct: win,
      points: Math.max(-20, Math.min(60, Math.round(pnl / 2000))),
      trade,
    });
    setResult({ trade, sim, session });
  }, [record, current.key]);

  const next = () => {
    setResult(null);
    setCurrent(feedRef.current.next(1, progressRef.current)[0]);
  };

  return (
    <div className="relative">
      <TradeSession key={current.key} card={current.card} bankroll={progress.bankroll} onFinish={onFinish} />
      {result && (
        <div className="pop absolute inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-line bg-black/95 px-4 pt-4 pb-6">
          <div className="text-[10px] uppercase tracking-[0.2em] text-dim">Session P&L</div>
          <div className={`num text-4xl font-extrabold ${result.trade.pnl > 0 ? 'text-up' : result.trade.pnl < 0 ? 'text-down' : 'text-white'}`}>
            {fmtMoney(result.trade.pnl)}{result.trade.mult > 1 && <span className="ml-2 text-base text-amber">🔥×{result.trade.mult}</span>}
          </div>
          <button onClick={next} className="num mt-4 h-14 w-full rounded-xl border border-amber/60 bg-amber/15 text-sm font-extrabold tracking-widest text-amber">
            NEXT SESSION ▶
          </button>
        </div>
      )}
    </div>
  );
}
