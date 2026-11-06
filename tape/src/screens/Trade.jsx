import { useCallback, useEffect, useRef, useState } from 'react';
import TradeSession from '../trade/TradeSession.jsx';
import Debrief from '../trade/Debrief.jsx';
import NextUp from '../trade/NextUp.jsx';
import { comboMultiplier, fmtMoney, settle } from '../lib/book.js';
import { startRide } from '../lib/progress.js';
import { fmtDate } from '../lib/format.js';
import { pickNext } from '../game/order.js';
import { sizesFor } from '../game/ride.js';
import { afterSession } from '../game/afterSession.js';
import { EVAL_DD, evalActive } from '../game/evalAccount.js';
import { CONCEPT_CARDS, ECON, PAPER_SESSION_CARDS, SESSION_CARDS } from '../data/index.js';
import CargoSession from '../physical/CargoSession.jsx';
import TankSession from '../physical/TankSession.jsx';
import { tankSplit } from '../physical/tank.js';
import PhysDebrief from '../physical/PhysDebrief.jsx';
import { bookPhysical } from '../physical/ledger.js';
import Rings from '../components/Rings.jsx';
import ChatSheet, { ChatButton } from '../components/ChatSheet.jsx';
import { acceptChallenge, markRead } from '../game/chat.js';
import { specialFor } from '../game/calendar.js';
import { localDay } from '../lib/progress.js';

const conceptById = new Map(CONCEPT_CARDS.map((c) => [c.id, c]));
const cardById = new Map(SESSION_CARDS.map((c) => [c.id, c]));

/** Share text for a finished session, in the OPEN BELL format. */
export function sessionShareText(s, grid, pnl, beat) {
  return `TAPE · ${s.instrument} ${fmtDate(s.date)}\n${grid}  ${fmtMoney(pnl)}\nBeat ${beat}/4 of the desk${beat === 4 ? ' 👑' : ''}\nCan you trade it better? ${location.origin}${location.pathname}?session=${s.id}`;
}

export async function shareOrCopy(text) {
  try {
    if (navigator.share) { await navigator.share({ text }); return 'shared'; }
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** The settled trade for a finished session (multiplier applies to wins). */
export function sessionTrade(progress, { bots, pnl: raw }, account = 'main') {
  const win = raw > 0;
  // Eval accounts trade plain P&L: no streak multipliers on a prop-firm evaluation.
  const mult = win && account !== 'eval' ? comboMultiplier(progress.combo) : 1;
  return { pnl: Math.round(raw * mult), base: Math.round(raw), mult, win, bots, session: true, account };
}

export function sessionResult(session, trade) {
  return {
    cardId: session.id,
    category: session.card.category,
    correct: trade.win,
    points: Math.max(-20, Math.min(60, Math.round(trade.pnl / 2000))),
    trade,
  };
}

/** Book a finished session (or a margin call) through `record`; returns the trade. */
export function bookSession(progress, record, r) {
  const trade = sessionTrade(progress, r);
  record(sessionResult(r.session, trade));
  return trade;
}

/** Concept question in a debrief or warm-up: right = $2,500 and keeps the streak. */
export function bookConcept(progress, record, concept, correct) {
  const trade = settle(concept, { correct }, progress.combo, concept.id);
  record({ cardId: concept.id, category: 'concepts', correct, points: correct ? 10 : 0, trade });
}

// TRADE: sessions back to back. After each one the debrief shows the next
// session already moving behind a 5s countdown (autoplay); STOP pauses it.
export default function Trade({ progress, record, apply, startWith, onStarted }) {
  const recent = useRef([]);
  const today = localDay();
  const special = specialFor(progress, today, SESSION_CARDS);
  const specialItem = (sp) => ({ key: `special-${sp.date}-${Date.now()}`, card: cardById.get(sp.cardId), tag: { special: sp }, label: `⭐ ${sp.label}` });
  const choose = (p) => {
    // Today's event special jumps the queue once; otherwise unplayed -> lowest grade -> review.
    const sp = specialFor(p, today, SESSION_CARDS);
    if (sp && !sp.played && !recent.current.includes(`special:${sp.date}`)) return specialItem(sp);
    const card = pickNext(p, SESSION_CARDS, { recent: recent.current, salt: String(Date.now()) });
    return { key: `${card.id}-${Date.now()}`, card };
  };
  const [chatOpen, setChatOpen] = useState(false);
  const currentRef = useRef(null);
  // ?session=<id> (or a Library tap) opens a specific session first.
  const [current, setCurrent] = useState(() => {
    const want = startWith ?? new URLSearchParams(location.search).get('session');
    const card = want && cardById.get(want);
    return card ? { key: `pick-${want}-${Date.now()}`, card } : choose(progress);
  });
  currentRef.current = current;
  const [next, setNext] = useState(null);
  const [result, setResult] = useState(null);
  const [mode, setMode] = useState('play'); // play | idle
  const [rode, setRode] = useState(false);
  const [toast, setToast] = useState('');

  // Opened from the Library: clear the request once this session has started.
  useEffect(() => { if (startWith) onStarted?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A Library tap while TRADE is open.
  const lastStart = useRef(startWith);
  if (startWith && startWith !== lastStart.current && cardById.get(startWith)) {
    lastStart.current = startWith;
    const card = cardById.get(startWith);
    setTimeout(() => { setResult(null); setMode('play'); setCurrent({ key: `pick-${startWith}-${Date.now()}`, card }); onStarted?.(); }, 0);
  }

  const onFinish = useCallback((r) => {
    // 1) read the latest state, 2) book the trade, 3) run the post-session pipeline.
    let trade;
    let rideBefore = 0;
    apply((p) => {
      trade = sessionTrade(p, r, evalActive(p) ? 'eval' : 'main');
      rideBefore = p.ride?.active ? p.ride.balance : 0;
      return { progress: p };
    });
    record(sessionResult(r.session, trade));
    let rideLost = 0;
    const events = apply((p) => {
      if (rideBefore > 0 && !p.ride.active) rideLost = rideBefore;
      return afterSession(p, {
        session: r.session, pnl: r.pnl, curve: r.sim.curve, full: true, stats: r.stats,
        bots: r.bots, marginCall: r.marginCall, guardHit: r.guardHit, trade, now: Date.now(),
        tag: currentRef.current?.tag ?? null, cards: PAPER_SESSION_CARDS,
      });
    });
    const tag = currentRef.current?.tag;
    recent.current = [r.session.id, ...(tag?.special ? [`special:${tag.special.date}`] : []), ...recent.current].slice(0, 8);
    setRode(false);
    // Let the last candle's P&L flash land before the debrief slides up.
    setTimeout(() => setResult({ ...r, trade, rideLost, events }), 1200);
  }, [apply, record]);

  // Choose the next session once the debrief is up (progress now includes this result).
  if (result && !next) {
    setTimeout(() => setNext((n) => n ?? choose(progress)), 0);
  }

  const go = (n = next) => {
    if (!n) return;
    setResult(null);
    setNext(null);
    setMode('play');
    setCurrent(n);
  };

  const share = async (grid) => {
    const beat = result.trade.bots.filter((b) => result.trade.pnl > b.pnl).length;
    const how = await shareOrCopy(sessionShareText(result.session, grid, result.trade.pnl, beat));
    if (how === 'copied') { setToast('Copied. Paste it to a friend.'); setTimeout(() => setToast(''), 2500); }
  };

  const ride = () => {
    apply((p) => ({ progress: startRide(p, result.trade.pnl) }));
    setRode(true);
  };

  const challenge = progress.chat?.challenge;
  const accept = (ch) => {
    apply((p) => ({ progress: acceptChallenge(p) }));
    setChatOpen(false);
    go({ key: `challenge-${ch.id}-${Date.now()}`, card: cardById.get(ch.sessionId), tag: { challenge: ch.id } });
  };
  const chat = chatOpen && (
    <ChatSheet progress={progress} onClose={() => setChatOpen(false)} onRead={() => apply((p) => ({ progress: markRead(p) }))} onAccept={accept} />
  );
  // Between-session panel extras: rings, chat, today's special, an accepted challenge.
  const extras = (
    <>
      {special && !special.played && next?.tag?.special?.date !== special.date && (
        <button onClick={() => go(specialItem(special))} className="pop mb-1.5 w-full truncate rounded-md border border-amber/60 bg-amber/15 px-2 py-1.5 text-left text-[11.5px] font-extrabold text-amber">
          ⭐ {special.label} — today only · PLAY ▶
        </button>
      )}
      {challenge?.status === 'accepted' && challenge.date === today && (
        <button onClick={() => go({ key: `challenge-${challenge.id}-${Date.now()}`, card: cardById.get(challenge.sessionId), tag: { challenge: challenge.id } })}
          className="pop mb-1.5 w-full truncate rounded-md border border-amber/60 bg-amber/10 px-2 py-1.5 text-left text-[11.5px] font-bold text-amber">
          ⚔️ Challenge: beat {fmtMoney(challenge.target, { compact: true })} on {challenge.inst} · PLAY ▶
        </button>
      )}
      <div className="mb-2 flex items-center justify-between gap-2">
        <Rings progress={progress} small />
        <ChatButton progress={progress} onOpen={() => setChatOpen(true)} />
      </div>
    </>
  );

  const inEval = evalActive(progress);
  // In an eval, sessions trade the eval sub-account: no ride, and the trailing drawdown is the limit.
  const { sizes, maxLots } = sizesFor(inEval ? { ...progress, ride: { active: false } } : progress);
  const rideBal = !inEval && progress.ride?.active ? progress.ride.balance : 0;

  if (mode === 'idle') {
    const n = next ?? choose(progress);
    return (
      <div className="flex h-[100dvh] flex-col pt-[44px]">
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="text-5xl">⏸</div>
          <p className="mt-3 text-lg font-bold">Autoplay paused</p>
          <p className="mt-1 text-sm text-dim">The market's still moving. Tap NEXT when you're ready.</p>
          {rideBal > 0 && <p className="num mt-3 text-sm font-bold text-up">RIDE {fmtMoney(rideBal)} riding into your next session</p>}
          <div className="mt-6"><Rings progress={progress} /></div>
        </div>
        <NextUp card={n.card} label={n.label} hold onGo={() => go(n)} onStop={() => {}}>{extras}</NextUp>
        {chat}
      </div>
    );
  }

  // Physical sessions: book to the physical desk ledger, then the physical debrief.
  const onPhysFinish = (kind) => (r) => {
    const events = apply((p) => bookPhysical(p, { card: current.card, kind, pnl: r.pnl, best: r.best.pnl, C: r.c?.D ?? r.t?.W ?? 0, ...(r.book ?? {}) }));
    recent.current = [current.card.id, ...recent.current].slice(0, 8);
    setTimeout(() => setResult({ phys: kind, ...r, events }), 1200);
  };
  const physDebrief = result?.phys === 'cargo' && next && (() => {
    const { c, st, best } = result;
    const s = st.sold.split;
    const portName = (id) => c.ports.find((p) => p.id === id)?.name;
    return (
      <PhysDebrief
        title={`${current.card.title}`}
        pnl={st.sold.pnl}
        best={best.pnl}
        bestText={`${portName(best.port)}${best.wait ? `, drift ${best.wait}d` : ''}, sell day ${best.sellDay + 1}`}
        lines={[
          { label: 'Flat price', value: s.flat, note: `${current.card.bench.name} ${c.flat[0].toFixed(2)} → ${c.flat[st.sold.day].toFixed(2)} $/bbl on ${(c.bbl / 1000).toFixed(0)}k bbl` },
          { label: 'Basis (location)', value: s.basis, note: `load ${c.load.basis.toFixed(2)} → ${portName(st.sold.port)} ${(st.sold.price - c.flat[st.sold.day]).toFixed(2)} vs ${current.card.bench.name}` },
          { label: 'Freight + demurrage + port', value: s.costs, note: `charter ${fmtMoney(st.cost.charter, { compact: true, sign: false })} · demurrage ${fmtMoney(st.cost.demurrage, { compact: true, sign: false })} · port ${fmtMoney(st.cost.port, { compact: true, sign: false })}${st.sold.freightToBuyer ? ` · afloat discount ${fmtMoney(st.sold.freightToBuyer, { compact: true, sign: false })}` : ''}` },
          { label: 'Events', value: s.events },
        ]}
        log={st.log}
        why={current.card.why}
        source={current.card.source}
        concept={conceptById.get(current.card.concept)}
        onConcept={(cc, ok) => bookConcept(progress, record, cc, ok)}
        next={next}
        onNext={() => go()}
        onStop={() => setMode('idle')}
        extras={extras}
      />
    );
  })();

  const tankDebrief = result?.phys === 'tank' && next && (() => {
    const { t, st, best } = result;
    const sp = tankSplit(t, st);
    const held = st.rows.filter((r) => r.inv > 0);
    const carryPerWeek = held.length ? sp.locked / held.length : 0;
    return (
      <PhysDebrief
        title={current.card.title}
        pnl={sp.total}
        best={best.pnl}
        bestText={best.plan}
        lines={[
          { label: 'Carry locked (spread × barrels)', value: sp.locked, note: st.rolls ? `${st.rolls} roll${st.rolls > 1 ? 's' : ''} included` : 'cash-and-carry spreads you sold' },
          { label: 'Unwind / spread moves', value: sp.unwind, note: 'what selling early or at session end added or cost vs the locked spread' },
          { label: 'Tank rent paid', value: sp.rent, note: `$${t.rent.toFixed(2)}/bbl/month` },
          { label: 'Financing paid', value: sp.financing, note: `${(t.finance * 100).toFixed(1)}%/yr on the barrels' value` },
        ]}
        extraTop={held.length > 0 && (
          <div className="mt-3 rounded-xl border border-line bg-panel p-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Carry earned vs rent paid, week by week</div>
            <table className="num mt-1 w-full text-[11px]">
              <thead><tr className="text-dim"><th className="text-left font-normal">week</th><th className="text-right font-normal">carry</th><th className="text-right font-normal">rent + fin</th><th className="text-right font-normal">net</th></tr></thead>
              <tbody>
                {held.map((r) => {
                  const cost = r.rent + r.financing;
                  return (
                    <tr key={r.week}>
                      <td>{new Date(`${r.date}T12:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                      <td className="text-right text-up">{fmtMoney(carryPerWeek, { compact: true })}</td>
                      <td className="text-right text-down">{fmtMoney(-cost, { compact: true })}</td>
                      <td className={`text-right font-bold ${carryPerWeek - cost >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(carryPerWeek - cost, { compact: true })}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-white/70">The spread has to pay more than the tank.</p>
          </div>
        )}
        log={st.log.map((l) => ({ day: l.week, text: l.text }))}
        why={current.card.why}
        source={current.card.source}
        concept={conceptById.get(current.card.concept)}
        onConcept={(cc, ok) => bookConcept(progress, record, cc, ok)}
        next={next}
        onNext={() => go()}
        onStop={() => setMode('idle')}
        extras={extras}
      />
    );
  })();

  if (current.card.type === 'tank') {
    return (
      <div className="relative">
        <TankSession key={current.key} card={current.card} econ={ECON} onFinish={onPhysFinish('tank')} />
        {tankDebrief}
        {chat}
      </div>
    );
  }

  if (current.card.type === 'cargo') {
    return (
      <div className="relative">
        <CargoSession key={current.key} card={current.card} econ={ECON} onFinish={onPhysFinish('cargo')} />
        {physDebrief}
        {chat}
      </div>
    );
  }

  const ghostRow = progress.played[current.card.id];
  return (
    <div className="relative">
      <TradeSession
        key={current.key}
        card={current.card}
        bankroll={inEval ? progress.eval.equity : progress.bankroll + rideBal}
        ride={rideBal}
        account={inEval ? 'eval' : null}
        guard={inEval ? { peak: progress.eval.peak, limit: EVAL_DD } : null}
        sizes={sizes}
        maxLots={maxLots}
        ghost={ghostRow?.curve ?? null}
        salt={current.key}
        onFinish={onFinish}
      />
      {result && next && (
        <Debrief
          result={result}
          concept={conceptById.get(result.session.card.session.concept)}
          onConcept={(c, ok) => bookConcept(progress, record, c, ok)}
          onNext={() => go()}
          onStop={() => setMode('idle')}
          onShare={share}
          next={next}
          ride={rideBal}
          onRide={ride}
          canRide={result.trade.pnl > 0 && !result.marginCall && !rode && result.trade.account !== 'eval'}
          rode={rode}
          rideLost={result.rideLost}
          banner={(result.events?.find((e) => e.type === 'eval') ?? result.events?.find((e) => e.type === 'league') ?? result.events?.[0])?.text ?? null}
          extra={extras}
        />
      )}
      {chat}
      {toast && <div className="pop num fixed inset-x-0 bottom-24 z-40 mx-auto w-fit rounded-lg bg-white px-3 py-2 text-xs font-bold text-black">{toast}</div>}
    </div>
  );
}
