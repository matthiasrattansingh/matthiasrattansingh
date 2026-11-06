import { useState } from 'react';
import { fmtMoney } from '../lib/book.js';
import { EVAL_DAYS, EVAL_DD, EVAL_START, EVAL_TARGET, evalActive, evalSummary, startEval } from '../game/evalAccount.js';

// EVAL: a prop-firm style evaluation on a $100k sim sub-account.
export default function EvalPanel({ progress, apply, onTrade }) {
  const [confirm, setConfirm] = useState(false);
  const e = progress.eval;
  const active = evalActive(progress);
  const start = () => { apply((p) => ({ progress: startEval(p, Date.now()) })); setConfirm(false); };

  return (
    <div>
      {progress.funded && (
        <div className="mb-3 rounded-xl border border-amber/60 bg-amber/15 p-3 text-center">
          <div className="text-3xl">🏆</div>
          <div className="num text-lg font-extrabold tracking-widest text-amber">FUNDED</div>
          <div className="text-[12px] text-white/80">10- and 25-lot sizes are unlocked in normal play.</div>
        </div>
      )}

      {active ? (() => {
        const s = evalSummary(e);
        return (
          <div className="rounded-2xl border border-white/15 bg-panel p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-[0.2em] text-amber">Eval in progress · day {s.day} of {EVAL_DAYS}</span>
              <span className="num text-[11px] text-dim">{s.daysLeft}d left</span>
            </div>
            <div className={`num mt-1 text-3xl font-extrabold ${e.equity >= EVAL_START ? 'text-up' : 'text-down'}`}>{fmtMoney(e.equity, { sign: false })}</div>
            <div className="mt-2 h-2 rounded bg-white/10"><div className="h-full rounded bg-up" style={{ width: `${s.progress * 100}%` }} /></div>
            <div className="num mt-1 flex justify-between text-[11px] text-dim">
              <span>{fmtMoney(e.equity - EVAL_START)} of +{fmtMoney(EVAL_TARGET, { sign: false })}</span>
              <span>{e.sessions} sessions</span>
            </div>
            <div className="num mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-black/40 p-2"><div className="text-[9px] uppercase text-dim">Peak</div><div className="text-sm font-bold">{fmtMoney(e.peak, { sign: false, compact: true })}</div></div>
              <div className="rounded-lg bg-black/40 p-2"><div className="text-[9px] uppercase text-dim">Floor</div><div className="text-sm font-bold text-down">{fmtMoney(s.floor, { sign: false, compact: true })}</div></div>
              <div className="rounded-lg bg-black/40 p-2"><div className="text-[9px] uppercase text-dim">Room</div><div className={`text-sm font-bold ${s.room < 3000 ? 'text-down' : 'text-white'}`}>{fmtMoney(s.room, { sign: false, compact: true })}</div></div>
            </div>
            <p className="mt-3 text-[12px] text-white/75">Every TRADE session now trades this account. Equity under the floor ends the eval instantly, even mid-session.</p>
            <button onClick={onTrade} className="num mt-3 h-12 w-full rounded-xl border border-amber/60 bg-amber/15 text-sm font-extrabold tracking-widest text-amber">TRADE THE EVAL ▶</button>
          </div>
        );
      })() : (
        <div className="rounded-2xl border border-white/15 bg-panel p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Prop-firm evaluation</div>
          <ul className="mt-2 space-y-1 text-[13px] text-white/85">
            <li>• {fmtMoney(EVAL_START, { sign: false })} sim sub-account, {EVAL_DAYS} calendar days</li>
            <li>• Target: <b className="text-up">+{fmtMoney(EVAL_TARGET, { sign: false })}</b></li>
            <li>• Hard rule: equity {EVAL_DD * 100}% below its peak ends it instantly (trailing)</li>
            <li>• Pass = <b className="text-amber">FUNDED</b>: 10 and 25 lots unlocked for good</li>
            <li>• While it runs, TRADE sessions go to the eval account. Restarting is free.</li>
          </ul>
          {e && e.status !== 'active' && (
            <div className={`mt-3 rounded-lg border p-3 ${e.status === 'passed' ? 'border-up/50 bg-up/10' : 'border-down/50 bg-down/10'}`}>
              <div className={`num text-sm font-extrabold ${e.status === 'passed' ? 'text-up' : 'text-down'}`}>
                {e.status === 'passed' ? `PASSED on day ${e.dayReached}` : `FAILED: ${e.reason === 'time' ? '30 days ran out' : 'trailing drawdown hit'}`}
              </div>
              {e.status === 'failed' && (
                <div className="num mt-1 text-[12px] text-white/80">
                  Peak equity {fmtMoney(e.peak, { sign: false })} ({fmtMoney(e.peak - EVAL_START)} of +$20,000 · {Math.round(((e.peak - EVAL_START) / EVAL_TARGET) * 100)}% of the way) · reached day {e.dayReached} of {EVAL_DAYS}
                </div>
              )}
            </div>
          )}
          {confirm ? (
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button onClick={start} className="num h-12 rounded-xl border border-up/60 bg-up/15 text-xs font-extrabold tracking-widest text-up">START 30 DAYS</button>
              <button onClick={() => setConfirm(false)} className="num h-12 rounded-xl border border-line text-xs text-dim">CANCEL</button>
            </div>
          ) : (
            <button onClick={() => setConfirm(true)} className="num mt-3 h-12 w-full rounded-xl border border-amber/60 bg-amber/15 text-sm font-extrabold tracking-widest text-amber">
              {e ? 'RESTART EVAL' : 'START EVAL'}
            </button>
          )}
        </div>
      )}

      {progress.evalHistory?.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 text-[11px] uppercase tracking-[0.2em] text-dim">Past evals</h3>
          <ul className="space-y-1">
            {progress.evalHistory.map((h) => (
              <li key={h.at} className="num flex justify-between rounded-lg border border-line bg-panel px-3 py-2 text-[12px]">
                <span className={h.status === 'passed' ? 'text-up' : 'text-down'}>{h.status === 'passed' ? '🏆 passed' : `✗ ${h.reason}`}</span>
                <span className="text-dim">peak {fmtMoney(h.peak, { sign: false, compact: true })} · day {h.dayReached}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
