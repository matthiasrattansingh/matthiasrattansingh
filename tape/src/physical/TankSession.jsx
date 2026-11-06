import { useEffect, useMemo, useRef, useState } from 'react';
import { bestTank, buildTank, carryCost, carryOffer, newTankState, priceOf, spot, stepTank, tankPnl } from './tank.js';
import { fmtMoney } from '../lib/book.js';
import { tick, ping, unlock } from '../lib/sound.js';

export const TANK_DECIDE_MS = 10_000;
const k = (v) => fmtMoney(Math.round(v), { compact: true, sign: false });
const mon = (m) => new Date(`${m}-15T12:00`).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
const shortDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const VOLUMES = [100_000, 250_000, 500_000];

/** The front-4-month curve this week (solid) vs last week (dashed), with carry per month labelled. */
function Curve({ t, w, hedgeMonth }) {
  const cur = t.weeks[w];
  const prev = w > 0 ? t.weeks[w - 1] : null;
  const vals = [...cur.curve, ...(prev?.curve ?? [])];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.25, 0.3);
  const W = 300;
  const H = 150;
  const x = (i) => 30 + i * ((W - 60) / 3);
  const y = (v) => 18 + (1 - (v - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 40);
  const line = (c) => c.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-full w-full">
      {prev && <polyline points={line(prev.curve)} fill="none" stroke="rgba(255,255,255,.3)" strokeDasharray="4 4" strokeWidth="1.5" />}
      <polyline points={line(cur.curve)} fill="none" stroke="#ffb000" strokeWidth="2.5" style={{ transition: 'all .5s' }} />
      {cur.curve.map((v, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(v)} r={cur.months[i] === hedgeMonth ? 6 : 4} fill={cur.months[i] === hedgeMonth ? '#ff4d5e' : '#ffb000'} style={{ transition: 'all .5s' }} />
          <text x={x(i)} y={y(v) - 9} textAnchor="middle" className="num" fontSize="10" fill="#fff">{v.toFixed(2)}</text>
          <text x={x(i)} y={H - 4} textAnchor="middle" className="num" fontSize="10" fill="rgba(255,255,255,.55)">{mon(cur.months[i])}{i === 0 ? ' (spot)' : ''}</text>
          {i > 0 && (
            <text x={(x(i) + x(i - 1)) / 2} y={Math.max(y(v), y(cur.curve[i - 1])) + 16} textAnchor="middle" className="num" fontSize="9.5"
              fill={v - cur.curve[i - 1] > carryCost(t, w) ? '#22e584' : '#ff4d5e'}>
              {v - cur.curve[i - 1] >= 0 ? '+' : ''}{(v - cur.curve[i - 1]).toFixed(2)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

/**
 * TANK session: barrels in a Cushing tank, weekly steps. Fixed one-screen layout:
 * curve · tank + hedge · rent meter · P&L · CARRY / ROLL / SELL / WAIT.
 */
export default function TankSession({ card, econ, onFinish, rivals = null, renderBuy = null }) {
  const t = useMemo(() => buildTank(card, econ), [card, econ]);
  const [st, setSt] = useState(newTankState);
  const [panel, setPanel] = useState(false);
  const [vol, setVol] = useState(500_000);
  const [buying, setBuying] = useState(null);
  const [banner, setBanner] = useState(null);
  const doneRef = useRef(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  const w = Math.min(st.week, t.W - 1);
  const wk = t.weeks[w];

  useEffect(() => {
    const e = wk.eia;
    setBanner(`EIA wk to ${new Date(`${e.week_ending}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: Cushing ${e.cushing_mmbbl >= 0 ? '+' : ''}${e.cushing_mmbbl}M · US ${e.us_mmbbl >= 0 ? '+' : ''}${e.us_mmbbl}M`);
    ping();
    const id = setTimeout(() => setBanner(null), 4500);
    return () => clearTimeout(id);
  }, [w]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!st.done || doneRef.current) return;
    doneRef.current = true;
    finishRef.current?.({ t, st, pnl: tankPnl(t, st), best: bestTank(t) });
  }, [st.done, t, st]);

  const act = (a) => {
    if (st.done) return;
    unlock();
    if (a.type === 'CARRY' && renderBuy && !a.agreed) { setBuying(a); setPanel(false); return; }
    setSt(stepTank(t, st, a));
    setPanel(false);
    if (a.type === 'WAIT') tick();
  };

  useEffect(() => {
    if (st.done || panel || buying) return undefined;
    const id = setTimeout(() => act({ type: 'WAIT' }), TANK_DECIDE_MS);
    return () => clearTimeout(id);
  }, [st.week, st.done, panel, buying]); // eslint-disable-line react-hooks/exhaustive-deps

  const pnl = tankPnl(t, st);
  const rentWk = st.inv * t.rent * (7 / 30.4);
  const hedgeIdx = st.hedge ? wk.months.indexOf(st.hedge.month) : -1;
  const canRoll = st.hedge && hedgeIdx >= 0 && hedgeIdx < 3;

  return (
    <div className="flex h-[100dvh] select-none flex-col bg-black pt-[34px]" style={{ touchAction: 'none' }}>
      <div className="flex items-baseline justify-between gap-2 px-3 py-1">
        <span className="num truncate text-[12px] font-bold">🛢️ {card.location} tank · {(t.capacity / 1000).toFixed(0)}k bbl</span>
        <span className="num shrink-0 text-[10px] text-dim">{shortDate(wk.date)} · wk {w + 1}/{t.W}</span>
      </div>
      <div className="truncate px-3 text-[12.5px] font-semibold text-amber">{card.open}</div>

      <div className="relative min-h-0 flex-1 px-2 pt-1">
        <Curve t={t} w={w} hedgeMonth={st.hedge?.month} />
        {banner && (
          <div key={banner} className="news-drop absolute inset-x-2 top-1 z-10 flex items-center gap-2 rounded-lg border border-sky-400/60 bg-sky-600/90 px-2.5 py-1.5">
            <span className="margin-pulse h-2 w-2 shrink-0 rounded-full bg-white" />
            <span className="num truncate text-[12px] font-bold text-white">{banner}</span>
          </div>
        )}
        <span className="num pointer-events-none absolute right-2 bottom-5 text-[9px] text-white/40">NYMEX WTI curve · EIA, real</span>
      </div>

      <div className="border-t border-line px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[9px] uppercase tracking-wider text-dim">tank</span>
          <div className="h-2.5 flex-1 rounded bg-white/10"><div className="h-full rounded bg-amber transition-all duration-500" style={{ width: `${(st.inv / t.capacity) * 100}%` }} /></div>
          <span className="num text-[10.5px] text-white/80">{(st.inv / 1000).toFixed(0)}k / {(t.capacity / 1000).toFixed(0)}k</span>
        </div>
        <div className="num mt-0.5 flex justify-between text-[10.5px]">
          <span className="truncate text-white/70">{st.hedge ? `SHORT ${(st.hedge.bbl / 1000).toFixed(0)}k ${mon(st.hedge.month)} @ ${st.hedge.entry.toFixed(2)}` : 'No hedge'}</span>
          <span className={`shrink-0 font-bold ${st.inv ? 'text-down' : 'text-white/50'}`}>RENT ${t.rent.toFixed(2)}/bbl/mo · {k(rentWk)}/wk</span>
        </div>
      </div>

      {typeof rivals === 'function' ? rivals(st.week, tankPnl(t, st)) : rivals}

      <div className="border-t border-line px-3 pt-1">
        <div className="flex items-end justify-between">
          <span className={`num text-[30px] font-extrabold leading-tight ${pnl > 0 ? 'text-up' : pnl < 0 ? 'text-down' : 'text-white'}`}>{fmtMoney(Math.round(pnl))}</span>
          <span className="num pb-1 text-right text-[10px] leading-tight text-dim">carry locked {k(st.locked)}<br />rent paid {k(st.rent)} · fin {k(st.financing)}</span>
        </div>
      </div>

      <div className="relative px-3 pt-1.5 pb-[max(10px,env(safe-area-inset-bottom))]">
        {st.done ? (
          <div className="num h-14 text-center text-sm leading-[56px] text-dim">Session over · {fmtMoney(Math.round(pnl))}</div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            <Btn tone="up" off={st.inv > 0} onClick={() => setPanel(true)}>CARRY</Btn>
            <Btn tone="amber" off={!canRoll} onClick={() => act({ type: 'ROLL' })}>ROLL</Btn>
            <Btn tone="down" off={!st.inv} onClick={() => act({ type: 'SELL' })}>SELL INV</Btn>
            <Btn tone="flat" off={false} onClick={() => act({ type: 'WAIT' })}>WAIT ▶</Btn>
          </div>
        )}
        {panel && (
          <div className="pop absolute inset-x-0 bottom-0 z-20 rounded-t-2xl border-t border-up/40 bg-[#0c0d0f] px-3 pt-2 pb-[max(10px,env(safe-area-inset-bottom))]">
            <div className="mb-1 flex items-center justify-between">
              <span className="num text-[11px] font-extrabold tracking-widest text-up">BUY SPOT + SELL FORWARD</span>
              <button onClick={() => setPanel(false)} className="num text-[10px] text-dim">CANCEL ✕</button>
            </div>
            <div className="mb-1.5 flex items-center gap-1.5">
              {VOLUMES.map((v) => (
                <button key={v} onClick={() => setVol(v)} className={`num rounded-md px-2 py-0.5 text-xs font-bold ${vol === v ? 'bg-amber text-black' : 'bg-white/10 text-white/70'}`}>{v / 1000}k</button>
              ))}
              <span className="num text-[10px] text-dim">bbl · cost ${carryCost(t, w).toFixed(2)}/bbl/mo</span>
            </div>
            {[1, 2, 3].map((kk) => {
              const o = carryOffer(t, w, kk);
              const pays = o.perMonth > carryCost(t, w);
              return (
                <button key={kk} onClick={() => act({ type: 'CARRY', k: kk, bbl: vol })}
                  className={`num mb-1.5 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${pays ? 'border-up/50 bg-up/10' : 'border-down/40 bg-down/5'}`}>
                  <span>
                    <span className="block text-[13px] font-bold">Sell {mon(o.month)} @ {o.price.toFixed(2)}</span>
                    <span className="text-[10.5px] text-dim">{o.months} mo · spread {o.spread >= 0 ? '+' : ''}{o.spread.toFixed(2)}</span>
                  </span>
                  <span className="text-right">
                    <span className={`block text-[13px] font-bold ${pays ? 'text-up' : 'text-down'}`}>{o.perMonth >= 0 ? '+' : ''}{o.perMonth.toFixed(2)}/mo</span>
                    <span className="text-[10.5px] text-dim">net {k((o.spread - o.cost) * vol)}</span>
                  </span>
                </button>
              );
            })}
            <p className="text-center text-[10.5px] text-white/60">The spread has to pay more than the tank.</p>
          </div>
        )}
        {buying && renderBuy?.({ t, st, action: buying, onDone: (deal) => { setBuying(null); if (deal) setSt(stepTank(t, st, { ...buying, ...deal, agreed: true })); }, onCancel: () => setBuying(null) })}
      </div>
    </div>
  );
}

const TONE = {
  up: 'border-up/60 text-up', down: 'border-down/60 text-down', flat: 'border-white/40 text-white', amber: 'border-amber/60 text-amber',
};
function Btn({ tone, off, onClick, children }) {
  return (
    <button onClick={onClick} disabled={off}
      className={`num h-14 rounded-xl border bg-panel text-[12px] font-extrabold tracking-wider transition active:scale-95 ${TONE[tone]} ${off ? 'opacity-35' : ''}`}>
      {children}
    </button>
  );
}

export { priceOf, spot };
