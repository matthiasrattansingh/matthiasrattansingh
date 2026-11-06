import { useEffect, useMemo, useState } from 'react';
import { leverage, liveParties, openNegotiation, respond, tell, edgeOf, negotiationGrade } from './negotiation.js';
import { fmtMoney } from '../lib/book.js';
import { ping, tick, thud } from '../lib/sound.js';

const sd = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}`;
const k = (v) => fmtMoney(Math.round(v), { compact: true, sign: false });

/**
 * Bottom-panel haggle over a fixed screen. Generic for both sides:
 *   side 'sell' (cargo): counterparties are buyers; you ask a HIGHER differential.
 *   side 'buy' (tank spot): counterparties are sellers; you ask a LOWER one.
 * ctx: { side, fair, desperation, roster, econ, relationships, seed, distressDays, theirClock,
 *        index(term) -> number, costPerHalfDay, onHalfDay() -> bool (advance clock; false if out of time),
 *        place: string, bbl, name }
 * onDeal({ party, diff, term, first, reservation, halfDays, edge, grade, pulled, rounds }), onClose(history)
 */
export default function NegotiationPanel({ ctx, onDeal, onClose }) {
  const initial = useMemo(() => openNegotiation({ ...ctx }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [n, setN] = useState(initial);
  const [sel, setSel] = useState(initial.parties[0].id);
  const [stepper, setStepper] = useState(false);
  const [ask, setAsk] = useState(null);
  const [flip, setFlip] = useState(false);
  const [checking, setChecking] = useState(null);
  const [extra, setExtra] = useState(0); // costs burned while haggling
  const dir = ctx.side === 'sell' ? 1 : -1;
  const party = n.parties.find((p) => p.id === sel) ?? n.parties[0];
  const live = liveParties(n);
  const lev = leverage(n);
  const indexAtOpen = useMemo(() => ctx.index('NOW'), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (party.status !== 'live' && live.length) setSel(live[0].id); }, [party.status, live.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishDeal = (nn) => {
    const d = nn.deal;
    const p = nn.parties.find((x) => x.id === d.party);
    const halfDays = nn.halfDays;
    const pulled = nn.parties.filter((x) => x.status === 'pulled').length;
    const edge = edgeOf({ side: ctx.side, bbl: ctx.bbl, indexAtOpen, indexAtDeal: ctx.index(d.term), diff: d.diff, first: p.first, extraCosts: extra });
    const grade = negotiationGrade({ side: ctx.side, diff: d.diff, first: p.first, reservation: p.reservation, halfDays, pulled });
    tick();
    onDeal({ ...d, name: p.name, halfDays, edge, grade, pulled, rounds: n.parties.map((x) => ({ id: x.id, rounds: x.rounds, stalled: x.stalled, status: x.status })), parties: nn.parties });
  };

  const advance = (nn) => {
    // Every counter or stall burns half a day: costs tick and, every two rounds, the day turns.
    setExtra((e) => e + ctx.costPerHalfDay);
    const ok = ctx.onHalfDay?.(nn.halfDays) ?? true;
    if (!ok) nn = { ...nn, parties: nn.parties.map((p) => (p.status === 'live' ? { ...p, final: true } : p)) };
    return nn;
  };

  const act = (a) => {
    if (checking) return;
    if (a.type === 'ACCEPT') {
      const out = respond(n, { type: 'ACCEPT', party: party.id }, ctx.seed);
      if (out.outcome === 'deal') finishDeal(out.n);
      return;
    }
    if (a.type === 'WALK') {
      const out = respond(n, { type: 'WALK', party: party.id }, ctx.seed);
      setN(out.n);
      if (!liveParties(out.n).length) onClose?.(out.n);
      return;
    }
    if (a.type === 'STALL') {
      const out = respond(n, { type: 'STALL' }, ctx.seed);
      const nn = advance(out.n);
      setN(nn);
      if (out.outcome === 'pulled') thud(); else tick();
      if (!liveParties(nn).length) setTimeout(() => onClose?.(nn), 1200);
      return;
    }
    // COUNTER
    const out = respond(n, { type: 'COUNTER', party: party.id, ask, flipTerm: flip }, ctx.seed);
    const nn = advance(out.n);
    setStepper(false);
    setFlip(false);
    if (out.checking) {
      setChecking(party.id);
      ping();
      setTimeout(() => {
        setChecking(null);
        if (out.outcome === 'deal') finishDeal(nn);
        else setN(nn);
      }, 3000);
      return;
    }
    setN(nn);
    if (out.outcome === 'pulled') thud();
    if (!liveParties(nn).length) setTimeout(() => onClose?.(nn), 1200);
  };

  const openStepper = () => {
    setAsk(Math.round((party.bid + dir * 0.25) * 20) / 20);
    setStepper(true);
  };

  return (
    <div className="pop absolute inset-x-0 bottom-0 z-30 rounded-t-2xl border-t border-amber/50 bg-[#0c0d0f] px-3 pt-2 pb-[max(10px,env(safe-area-inset-bottom))]">
      <div className="num flex items-center justify-between text-[10.5px]">
        <span className="font-extrabold tracking-widest text-amber">{ctx.side === 'sell' ? 'SELLING' : 'BUYING'} · {ctx.place}</span>
        <span className={`font-bold ${extra > 0 ? 'margin-pulse text-down' : 'text-dim'}`}>+{(n.halfDays / 2).toFixed(1)}d · {k(extra)} burned</span>
      </div>
      <div className="num mt-0.5 flex items-center justify-between text-[10px] text-dim">
        <span>index ${ctx.index('NOW').toFixed(2)} · fair {sd(ctx.fair)} · {(ctx.bbl / 1000).toFixed(0)}k bbl</span>
        {lev && <span className="rounded bg-up/20 px-1.5 font-bold text-up">{live.length} live bids</span>}
      </div>
      {ctx.theirClock && <div className="num mt-0.5 text-[10px] font-bold text-sky-300">⏱ their clock: {ctx.theirClock}</div>}

      <div className="mt-1.5 space-y-1">
        {n.parties.map((p) => (
          <button key={p.id} onClick={() => p.status === 'live' && setSel(p.id)}
            className={`w-full rounded-lg border px-2 py-1.5 text-left ${p.status !== 'live' ? 'border-line opacity-40' : p.id === party.id ? 'border-amber/70 bg-amber/10' : 'border-line bg-panel'}`}>
            <div className="num flex items-center justify-between text-[12px]">
              <span className="truncate font-bold" style={{ color: p.color }}>{p.emoji} {p.name}</span>
              <span className="shrink-0">
                {checking === p.id ? <span className="margin-pulse text-amber">checking with the desk…</span>
                  : p.status === 'live' ? <><b>{sd(p.bid)}</b> <span className="text-dim">{p.term}</span>{p.final ? <span className="text-down"> FINAL</span> : <span className="text-dim"> · {p.patience}r</span>}</>
                    : <span className="text-down">{p.status.toUpperCase()}</span>}
              </span>
            </div>
            <div className="truncate text-[10.5px] italic text-white/60">“{tell(p, ctx.side, ctx.relationships?.[p.id], ctx.name)}”</div>
          </button>
        ))}
      </div>

      {stepper ? (
        <div className="mt-2">
          <div className="num flex items-center justify-between gap-2">
            <button onClick={() => setAsk((a) => Math.round((a - 0.05) * 20) / 20)} className="h-11 w-11 rounded-lg border border-white/30 text-lg font-bold">−</button>
            <div className="text-center">
              <div className="text-[10px] text-dim">your {ctx.side === 'sell' ? 'ask' : 'bid'} vs index</div>
              <div className="text-xl font-extrabold text-amber">{sd(ask)}</div>
              <div className="text-[10px] text-dim">{fmtMoney((ask - party.bid) * dir * ctx.bbl, { compact: true })} vs their bid</div>
            </div>
            <button onClick={() => setAsk((a) => Math.round((a + 0.05) * 20) / 20)} className="h-11 w-11 rounded-lg border border-white/30 text-lg font-bold">+</button>
          </div>
          <div className="mt-1.5 grid grid-cols-[1fr_1fr_auto] gap-2">
            <button onClick={() => setFlip((f) => !f)} className={`num h-11 rounded-lg border text-[11px] font-bold ${flip ? 'border-sky-400 bg-sky-500/20 text-sky-200' : 'border-white/20 text-white/70'}`}>
              {flip ? `→ ${party.term === 'NOW' ? 'AVG5' : 'NOW'} ✓` : `flip to ${party.term === 'NOW' ? 'AVG5' : 'NOW'}`}
            </button>
            <button onClick={() => act({ type: 'COUNTER' })} className="num h-11 rounded-lg border border-amber/70 bg-amber/15 text-[12px] font-extrabold tracking-widest text-amber">SEND</button>
            <button onClick={() => setStepper(false)} className="num h-11 rounded-lg border border-line px-3 text-[11px] text-dim">✕</button>
          </div>
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-4 gap-2">
          <Btn tone="up" off={party.status !== 'live' || checking} onClick={() => act({ type: 'ACCEPT' })}>ACCEPT</Btn>
          <Btn tone="amber" off={party.status !== 'live' || party.final || checking} onClick={openStepper}>COUNTER</Btn>
          <Btn tone="flat" off={!live.length || checking} onClick={() => act({ type: 'STALL' })}>STALL</Btn>
          <Btn tone="down" off={party.status !== 'live' || checking} onClick={() => act({ type: 'WALK' })}>WALK</Btn>
        </div>
      )}
      <button onClick={() => onClose?.(n)} className="num mt-1.5 w-full text-center text-[10px] text-dim">back to the voyage ✕</button>
    </div>
  );
}

const TONE = { up: 'border-up/60 text-up', down: 'border-down/60 text-down', flat: 'border-white/40 text-white', amber: 'border-amber/60 text-amber' };
function Btn({ tone, off, onClick, children }) {
  return (
    <button onClick={onClick} disabled={Boolean(off)}
      className={`num h-12 rounded-xl border bg-panel text-[11px] font-extrabold tracking-wider transition active:scale-95 ${TONE[tone]} ${off ? 'opacity-35' : ''}`}>
      {children}
    </button>
  );
}
