import { useEffect, useMemo, useRef, useState } from 'react';
import { PhysChart } from './PhysChart.js';
import {
  bestCargo, bestSale, buildCargo, canChoosePort, deliveredAt, markToMarket, netbackAt, newCargoState, step,
} from './cargo.js';
import { fmtMoney } from '../lib/book.js';
import { tick, thud, ping, unlock } from '../lib/sound.js';

export const CARGO_DECIDE_MS = 10_000;
const k = (v) => fmtMoney(Math.round(v), { compact: true, sign: false });
const usd = (v) => `$${v.toFixed(2)}`;
const shortDate = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function buzz(p) { try { navigator.vibrate?.(p); } catch { /* unsupported */ } }

/**
 * CARGO session: one physical cargo, day by day. Fixed one-screen layout:
 * chart (benchmark vs your delivered price) · ports · cost meter · P&L · thumb row.
 * Props: card, econ, rivals? (strip), onFinish({ c, st, pnl, best }), sellPanel? (negotiation hook).
 */
export default function CargoSession({ card, econ, onFinish, rivals = null, renderSell = null, adjust = null }) {
  const c = useMemo(() => {
    const base = buildCargo(card, econ);
    return adjust ? adjust(base) : base;
  }, [card, econ, adjust]);
  const [st, setSt] = useState(newCargoState);
  const [portPanel, setPortPanel] = useState(true); // day 0: pick a port first
  const [banner, setBanner] = useState(null);
  const [selling, setSelling] = useState(false);
  const canvasRef = useRef(null);
  const chartRef = useRef(null);
  const doneRef = useRef(false);
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;

  const destOrBest = st.dest ?? bestSale(c, st)?.port ?? c.ports[0].id;
  const cargoLine = c.flat.map((_, d) => deliveredAt(c, st.at ?? destOrBest, d));

  useEffect(() => {
    const chart = new PhysChart(canvasRef.current, { steps: c.D, labelOf: (i) => shortDate(c.dates[i]) });
    chartRef.current = chart;
    return () => chart.destroy();
  }, [c]);

  useEffect(() => {
    const known = st.day + 1;
    chartRef.current?.set([
      { name: card.bench.name, color: 'rgba(255,255,255,0.55)', values: c.flat.slice(0, known), width: 1.6 },
      { name: 'YOUR CARGO', color: '#ffb000', values: cargoLine.slice(0, known), width: 2.4 },
    ], st.day, c.events.filter((e) => e.day <= st.day).map((e) => ({ step: e.day, color: 'rgba(255,77,94,0.6)' })));
  });

  // Breaking events for the day.
  useEffect(() => {
    const today = st.log.filter((l) => l.day === st.day && !['port', 'sell'].includes(l.type));
    if (!today.length) return undefined;
    setBanner(today.map((l) => l.text).join(' · '));
    buzz([50, 30, 50]);
    ping();
    const id = setTimeout(() => setBanner(null), 4000);
    return () => clearTimeout(id);
  }, [st.day, st.log.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Session over -> book it.
  useEffect(() => {
    if (!st.sold || doneRef.current) return;
    doneRef.current = true;
    if (st.sold.pnl < -200000) thud(); else tick();
    const best = bestCargo(c);
    finishRef.current?.({ c, st, pnl: st.sold.pnl, best });
  }, [st.sold, c]);

  const act = (a) => {
    if (st.sold || selling) return;
    unlock();
    if (a.type === 'SELL' && renderSell) { setSelling(true); return; }
    const before = st.day;
    const next = step(c, st, a);
    setSt(next);
    if (a.type === 'PORT') setPortPanel(false);
    if (next.day !== before) tick();
  };

  // The market never waits: 10s, then the default (sail on, or wait at port; day 0 picks best netback).
  useEffect(() => {
    if (st.sold || selling) return undefined;
    const id = setTimeout(() => {
      if (!st.dest && !st.at) {
        const best = [...c.ports].sort((a, b) => netbackAt(c, st, b.id) - netbackAt(c, st, a.id))[0];
        act({ type: 'PORT', port: best.id });
      } else act({ type: st.at ? 'WAIT' : 'SAIL' });
    }, CARGO_DECIDE_MS);
    return () => clearTimeout(id);
  }, [st.day, st.dest, st.sold, selling]); // eslint-disable-line react-hooks/exhaustive-deps

  const mtm = markToMarket(c, st);
  const costs = st.cost.charter + st.cost.demurrage + st.cost.port;
  const onDemurrage = Boolean(st.at) && (st.queue > 0 || st.waited >= (c.ports.find((p) => p.id === st.at)?.laytime ?? 1.5));
  const choose = canChoosePort(c, st);
  const portName = (id) => c.ports.find((p) => p.id === id)?.name;
  const location = st.at ? `At ${portName(st.at)}${st.queue ? ` · berth in ${st.queue}d` : ''}` : st.dest ? `→ ${portName(st.dest)} · ETA day ${st.eta + 1}` : 'Loaded · choose a port';

  return (
    <div className="flex h-[100dvh] select-none flex-col bg-black pt-[34px]" style={{ touchAction: 'none' }}>
      <div className="flex items-baseline justify-between gap-2 px-3 py-1">
        <span className="num truncate text-[12px] font-bold">🛢️ {card.cargo.name} · {(c.bbl / 1000).toFixed(0)}k bbl</span>
        <span className="num shrink-0 text-[10px] text-dim">{shortDate(c.dates[st.day])} · day {st.day + 1}/{c.D}</span>
      </div>
      <div className="truncate px-3 text-[12.5px] font-semibold text-amber">{card.open}</div>

      <div className="relative min-h-0 flex-1 px-1 pt-1">
        <canvas ref={canvasRef} className="block h-full w-full" />
        {banner && (
          <div key={banner} className="news-drop absolute inset-x-2 top-1 z-10 flex items-center gap-2 rounded-lg border border-down/60 bg-down/90 px-2.5 py-1.5">
            <span className="margin-pulse h-2 w-2 shrink-0 rounded-full bg-white" />
            <span className="truncate text-[13px] font-bold text-white">{banner}</span>
          </div>
        )}
        {!st.sold && !selling && <Ring key={`${st.day}-${st.dest}`} />}
        <span className="num pointer-events-none absolute bottom-0 left-2 text-[9px] text-white/30">flat price real · port basis modeled</span>
      </div>

      <div className="num grid grid-cols-3 gap-1 border-t border-line px-2 py-1 text-[10.5px]">
        {c.ports.map((p) => {
          const here = st.at === p.id;
          const dest = st.dest === p.id;
          return (
            <div key={p.id} className={`truncate rounded-md px-1.5 py-1 ${here || dest ? 'bg-amber/15 text-amber' : 'bg-white/5 text-white/70'}`}>
              <div className="truncate font-bold">{p.name}</div>
              <div>{usd(deliveredAt(c, p.id, st.day))} <span className="text-dim">net {usd(netbackAt(c, st, p.id))}</span></div>
            </div>
          );
        })}
      </div>

      {rivals}

      <div className="border-t border-line px-3 pt-1">
        <div className="flex items-center justify-between text-[10.5px]">
          <span className="num truncate text-white/70">{location}</span>
          <span className={`num shrink-0 font-bold ${onDemurrage ? 'margin-pulse text-down' : 'text-white/70'}`}>
            {onDemurrage ? `DEMURRAGE ${k(c.demurrage)}/d` : `CHARTER ${k(c.charter)}/d`} · costs {k(costs)}
          </span>
        </div>
        <div className="flex items-end justify-between">
          <span className={`num text-[30px] font-extrabold leading-tight ${mtm > 0 ? 'text-up' : mtm < 0 ? 'text-down' : 'text-white'}`}>{fmtMoney(Math.round(mtm))}</span>
          <span className="num pb-1 text-right text-[10px] leading-tight text-dim">if you sell now<br />{bestSale(c, st)?.afloat ? 'afloat' : 'at berth'} · {portName(bestSale(c, st)?.port)}</span>
        </div>
      </div>

      <div className="relative px-3 pt-1.5 pb-[max(10px,env(safe-area-inset-bottom))]">
        {st.sold ? (
          <div className="num h-14 text-center text-sm leading-[56px] text-dim">Cargo sold · {fmtMoney(st.sold.pnl)}</div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            <Btn tone={st.at ? 'dim' : 'up'} off={st.at || !st.dest} onClick={() => act({ type: 'SAIL' })}>SAIL ▶</Btn>
            <Btn tone="flat" off={!st.dest && !st.at} onClick={() => act({ type: 'WAIT' })}>{st.at ? 'WAIT' : 'DRIFT'}</Btn>
            <Btn tone="down" off={false} onClick={() => act({ type: 'SELL' })}>SELL</Btn>
            <Btn tone="amber" off={!choose} onClick={() => setPortPanel(true)}>PORT</Btn>
          </div>
        )}
        {portPanel && choose && !st.sold && (
          <div className="pop absolute inset-x-0 bottom-0 z-20 rounded-t-2xl border-t border-amber/40 bg-[#0c0d0f] px-3 pt-2 pb-[max(10px,env(safe-area-inset-bottom))]">
            <div className="mb-1 flex items-center justify-between">
              <span className="num text-[11px] font-extrabold tracking-widest text-amber">CHOOSE PORT</span>
              {st.dest && <button onClick={() => setPortPanel(false)} className="num text-[10px] text-dim">KEEP COURSE ✕</button>}
            </div>
            {c.ports.map((p) => {
              const days = Math.max(1, p.voyage - st.day) + st.delays;
              const voyageCost = days * c.charter;
              return (
                <button key={p.id} onClick={() => act({ type: 'PORT', port: p.id })}
                  className={`num mb-1.5 flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${st.dest === p.id ? 'border-amber/70 bg-amber/10' : 'border-line bg-panel'}`}>
                  <span>
                    <span className="block text-[13px] font-bold">{p.name}</span>
                    <span className="text-[10.5px] text-dim">{days}d · voyage {k(voyageCost)}</span>
                  </span>
                  <span className="text-right">
                    <span className="block text-[13px] font-bold">{usd(deliveredAt(c, p.id, st.day))}</span>
                    <span className="text-[10.5px] text-dim">netback {usd(netbackAt(c, { ...st, dest: null }, p.id))}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {selling && renderSell?.({ c, st, onDone: (next) => { setSelling(false); if (next) setSt(next); }, onCancel: () => setSelling(false) })}
      </div>
    </div>
  );
}

function Ring() {
  const r = 15;
  const len = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 40 40" className="pointer-events-none absolute right-12 bottom-3 h-9 w-9 -rotate-90">
      <circle cx="20" cy="20" r={r} fill="rgba(0,0,0,.6)" stroke="rgba(255,255,255,.15)" strokeWidth="3.5" />
      <circle cx="20" cy="20" r={r} fill="none" stroke="#ffb000" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={len}
        className="timer-ring" style={{ '--len': len, animationDuration: `${CARGO_DECIDE_MS}ms` }} />
    </svg>
  );
}

const TONE = {
  up: 'border-up/60 text-up', down: 'border-down/60 text-down', flat: 'border-white/40 text-white',
  amber: 'border-amber/60 text-amber', dim: 'border-white/15 text-white/50',
};
function Btn({ tone, off, onClick, children }) {
  return (
    <button onClick={onClick} disabled={off}
      className={`num h-14 rounded-xl border bg-panel text-[12px] font-extrabold tracking-wider transition active:scale-95 ${TONE[tone]} ${off ? 'opacity-35' : ''}`}>
      {children}
    </button>
  );
}
