import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { AGENTS, CONCEPT_CARDS, DESK_CARDS, ECON, IDEA_CARDS, PAPER_SESSION_CARDS, SESSION_CARDS } from '../data/index.js';
import DeskSession from '../desk/DeskSession.jsx';
import { buildSession, simulate } from '../trade/engine.js';
import { executeAll } from '../trade/execution.js';
import { HABIT_INFO, habits, isHard, pickTrap, recordAdapt, trapOf, typeOf } from '../game/adaptive.js';
import { lockedPnl, maxDrawdown, verdict } from '../game/rules.js';
import { settleWager } from '../game/wager.js';
import WagerBar from '../game/WagerBar.jsx';
import { challengeFromSearch, compare, newSeed } from '../challenge/link.js';
import { submitScore } from '../challenge/leaderboard.js';
import VerdictPanel, { ChallengeSheet } from '../challenge/VerdictPanel.jsx';
import { fadeAdjust } from '../physical/memory.js';
import IdeaCard from '../desk/IdeaCard.jsx';
import { ideaOf, isIdeaSlot, passIdea, pickIdea, runIdea, tickIdeas } from '../desk/feed.js';
import { PITCH_RULES, deskCurve } from '../desk/scenario.js';
import CargoSession from '../physical/CargoSession.jsx';
import TankSession from '../physical/TankSession.jsx';
import { spot as tankSpot, spotMarket, tankSplit } from '../physical/tank.js';
import PhysDebrief from '../physical/PhysDebrief.jsx';
import { bookPhysical, integratedUnlocked } from '../physical/ledger.js';
import PhysStrip from '../physical/PhysStrip.jsx';
import DeskTable from '../physical/DeskTable.jsx';
import { rememberCargo, rememberHedge, rivalAdjust } from '../physical/memory.js';
import NegotiationPanel from '../physical/NegotiationPanel.jsx';
import { runCargo, bestSale, desperationAt, distressDaysAt, fairDiff, indexFor, sellNegotiated, setPieceAt } from '../physical/cargo.js';
import { recordNegotiation } from '../physical/relationships.js';
import { runAgentCargo, runAgentTank } from '../physical/agents.js';
import { buildTank as buildTankFor } from '../physical/tank.js';
import { botById } from '../lib/rivals.js';
import Rings from '../components/Rings.jsx';
import ChatSheet, { ChatButton } from '../components/ChatSheet.jsx';
import { acceptChallenge, markRead, post } from '../game/chat.js';
import { specialFor } from '../game/calendar.js';
import { localDay } from '../lib/progress.js';

const conceptById = new Map(CONCEPT_CARDS.map((c) => [c.id, c]));
const cardById = new Map([...SESSION_CARDS, ...IDEA_CARDS].map((c) => [c.id, c]));
// Sessions whose real data makes them a priced-in trap (the move ran before, or the headline reversed).
// Desk-book drawdown allowed for a physical WIN (positions are 100k-750k bbl).
const PHYS_RISK_BUDGET = 500_000;
const TRAP_IDS = new Set(PAPER_SESSION_CARDS.filter((c) => trapOf(buildSession(c))).map((c) => c.id));

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
export function sessionTrade(progress, { bots, pnl: raw, verdict: v = null }, account = 'main') {
  // A WIN needs all three checks (best bot, passive benchmark, risk budget); P&L alone isn't enough.
  const win = v ? v.win : raw > 0;
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
  const started = useRef(0); // feed items started this visit: sets the 1-in-4 idea slot
  const today = localDay();
  const special = specialFor(progress, today, SESSION_CARDS);
  // Every feed item is a run: a seed (live ticks, fills, bots, hard tape) and the hard flag.
  const mkItem = (p, card, extra = {}) => ({ key: `${card.id}-${Date.now()}`, card, seed: newSeed(), hard: isHard(p, typeOf(card)), ...extra });
  const specialItem = (sp) => mkItem(progress, cardById.get(sp.cardId), { key: `special-${sp.date}-${Date.now()}`, tag: { special: sp }, label: `⭐ ${sp.label}` });
  const choose = (p) => {
    // Today's event special jumps the queue once; otherwise unplayed -> lowest grade -> review.
    const sp = specialFor(p, today, SESSION_CARDS);
    if (sp && !sp.played && !recent.current.includes(`special:${sp.date}`)) return specialItem(sp);
    // One feed item in four is a physical trade idea.
    if (isIdeaSlot(started.current)) {
      const idea = pickIdea(p, IDEA_CARDS, started.current);
      if (idea) return mkItem(p, idea, { label: '💡 IDEA' });
    }
    // Two-book sessions stay locked until 5 cargoes are done: learn the physical chain first.
    const pool = SESSION_CARDS.filter((c) => c.mode !== 'integrated' || integratedUnlocked(p));
    // Priced-in traps come up more often the more you fall for them.
    if (pickTrap(p, `${started.current}|${Date.now()}`)) {
      const traps = pool.filter((c) => TRAP_IDS.has(c.id) && !recent.current.includes(c.id));
      if (traps.length) { const t = pickNext(p, traps, { recent: recent.current, salt: `trap${Date.now()}` }); return mkItem(p, t); }
    }
    const card = pickNext(p, pool, { recent: recent.current, salt: String(Date.now()) });
    return mkItem(p, card);
  };
  const [chatOpen, setChatOpen] = useState(false);
  const currentRef = useRef(null);
  // ?session=<id> (or a Library tap) opens a specific session first.
  const [current, setCurrent] = useState(() => {
    // ?c=<challenge> replays someone's exact run: same scenario, seed, tape and bots.
    const ch = challengeFromSearch();
    if (ch && cardById.get(ch.id)) return { key: `challenge-${ch.id}-${Date.now()}`, card: cardById.get(ch.id), seed: ch.seed, hard: ch.hard, challenge: ch, label: `⚔ ${ch.name}` };
    const want = startWith ?? new URLSearchParams(location.search).get('session');
    const found = want && cardById.get(want);
    const card = found && (found.mode !== 'integrated' || integratedUnlocked(progress)) ? found : null;
    return card ? mkItem(progress, card, { key: `pick-${want}-${Date.now()}` }) : choose(progress);
  });
  const [sheet, setSheet] = useState(null); // challenge share sheet
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
    setTimeout(() => { setResult(null); setMode('play'); setCurrent(mkItem(progress, card, { key: `pick-${startWith}-${Date.now()}` })); onStarted?.(); }, 0);
  }

  const onFinish = useCallback((r) => {
    // 0) score the session: the three win checks, on raw P&L (before any streak multiplier).
    const cur = currentRef.current;
    const passiveSim = simulate(r.session, executeAll(r.session, [{ type: 'OPEN', side: 'LONG', lots: 2 }], { seed: r.seed }));
    const passive = { pnl: Math.round(lockedPnl(passiveSim.curve, r.limits).pnl), label: `hold ${r.session.sides.LONG.toLowerCase()} 2 lots` };
    const v = verdict({ pnl: r.pnl, bots: r.bots, passive, maxDD: Math.max(r.stats.maxDD, maxDrawdown(r.sim.curve)), budget: r.limits.budget, limitHit: r.limitHit ?? null });
    const trap = trapOf(r.session);
    // 1) read the latest state, 2) book the trade, 3) run the post-session pipeline.
    let trade;
    let rideBefore = 0;
    apply((p) => {
      trade = sessionTrade(p, { ...r, verdict: v }, evalActive(p) ? 'eval' : 'main');
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
    // 4) the desk learns your habits; any wager settles; a bot that front-ran you says so.
    let wager = null;
    let fell = false;
    apply((p) => {
      let q = recordAdapt(p, { card: cur.card, s: r.session, decisions: r.decisions, win: v.win, pnl: r.pnl });
      fell = Boolean(q.adapt.sessions.at(-1)?.fell);
      const w = settleWager(q, { pnl: r.pnl, bots: r.bots });
      wager = w.result;
      q = w.progress;
      const bot = Object.keys(r.costs?.frontRun ?? {})[0];
      const habit = bot && Object.values(HABIT_INFO).find((h) => h.bot === bot);
      if (habit) q = post(q, bot, 'taunt', habit.line);
      return { progress: q };
    });
    // 5) the run as a challenge: link, leaderboard entry, and the head-to-head if this was one.
    const run = { id: cur.card.id, kind: 'paper', seed: r.seed, hard: r.hard, name: progress.playerName || 'Me', pnl: r.pnl, win: v.win, bots: r.bots, checks: v.checks.map((c) => c.pass) };
    submitScore(run);
    const ch = cur.challenge;
    const versus = ch ? { ...compare(r.pnl, ch.pnl), name: ch.name, mine: r.pnl, theirs: ch.pnl } : null;
    const review = { verdict: v, trap: trap ? { ...trap, fell } : null, wager, versus, costs: r.costs, limitHit: r.limitHit ?? null, hard: r.hard };
    const tag = currentRef.current?.tag;
    recent.current = [r.session.id, ...(tag?.special ? [`special:${tag.special.date}`] : []), ...recent.current].slice(0, 8);
    setRode(false);
    // Let the last candle's P&L flash land before the debrief slides up.
    setTimeout(() => setResult({ ...r, trade, rideLost, events, review, run }), 1200);
  }, [apply, record, progress.playerName]);

  // Choose the next session once the debrief is up (progress now includes this result).
  if (result && !next) {
    setTimeout(() => setNext((n) => n ?? choose(progress)), 0);
  }

  const go = (n = next) => {
    if (!n) return;
    // A swipe: open physical ideas move one scenario day; finished ones settle to the desk book.
    started.current += 1;
    const ev = apply((p) => tickIdeas(p, DESK_CARDS));
    if (ev?.length) { setToast(ev.map((e) => e.text).join(' · ')); setTimeout(() => setToast(''), 3500); }
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
      {(!next || ['callit', 'spread'].includes(next.card.type)) && <WagerBar progress={progress} apply={apply} />}
      <div className="mb-2 flex items-center justify-between gap-2">
        <Rings progress={progress} small />
        <ChatButton progress={progress} onOpen={() => setChatOpen(true)} />
      </div>
    </>
  );

  // The desk agents play the same physical session, from public state only.
  // After 5 cargoes, rivals pre-position at your favorite port (fixed for the session).
  // A challenge replays the challenger's tape: their rivals' pre-positioning, not yours.
  const adjust = useMemo(() => (current.challenge ? (current.challenge.fade ? fadeAdjust(current.challenge.fade) : null) : rivalAdjust(progress)), [current.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentRuns = useMemo(() => {
    if (current.card.type === 'cargo') return AGENTS.map((a) => runAgentCargo(a, current.card, ECON, { adjust }));
    if (current.card.type === 'tank') { const t = buildTankFor(current.card, ECON); return AGENTS.map((a) => runAgentTank(a, t)); }
    return null;
  }, [current.card, adjust]);
  const physStrip = agentRuns && ((step, mine) => <PhysStrip runs={agentRuns} step={step} mine={mine} ghost={progress.played[current.card.id]?.curve ?? null} />);
  // Physical sessions: the same three checks (bots, passive, risk budget) on the desk book.
  const physReview = (kind, { pnl, bots, passive, curve, fade = null }) => {
    const v = verdict({ pnl, bots, passive, maxDD: maxDrawdown(curve ?? []), budget: PHYS_RISK_BUDGET });
    const ch = current.challenge;
    const versus = ch ? { ...compare(pnl, ch.pnl), name: ch.name, mine: pnl, theirs: ch.pnl } : null;
    const run = { id: current.card.id, kind, seed: current.seed ?? current.key, hard: false, name: progress.playerName || 'Me', pnl, win: v.win, bots, fade };
    submitScore({ ...run, checks: v.checks.map((c) => c.pass) });
    return { review: { verdict: v, versus }, run };
  };
  const openSheet = (run, title, date, kind, bots, checks, versus) => setSheet({
    run,
    info: {
      title, date, kind, checks,
      standings: [{ name: progress.playerName || 'You', emoji: '🫵', pnl: run.pnl, me: true }, ...bots.map((b) => ({ ...botById[b.id], pnl: b.pnl }))].sort((a, b) => b.pnl - a.pnl),
      versus: versus ? { name: versus.name, pnl: versus.theirs } : null,
    },
  });

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

  // SELL in a cargo session opens a negotiation with the buyers at your port.
  const renderSell = ({ c, st, getSt, advance, onDone, onCancel }) => {
    const sale = bestSale(c, st);
    const port = sale.port;
    const portName = c.ports.find((p) => p.id === port).name;
    const atBerth = st.at === port && !sale.afloat;
    // Distress: buyers shade bids for every day your demurrage meter has been red.
    const distressDays = st.at === port ? distressDaysAt(c, st) : 0;
    // Set-pieces from the events deck (a desperate buyer, a distressed rival seller).
    const piece = setPieceAt(c, port, st.day);
    const halfDayCost = (atBerth && st.waited >= (c.ports.find((p) => p.id === port).laytime ?? 1.5) ? c.demurrage : c.charter) / 2;
    const ctx = {
      side: 'sell', fair: fairDiff(c, port, st.day), desperation: desperationAt(c, port, st.day),
      roster: AGENTS, econ: ECON, relationships: progress.phys.relationships, seed: `${current.seed ?? current.key}|${st.day}|${port}`,
      distressDays, count: piece?.count, line: piece?.line ?? undefined,
      index: (term) => indexFor(c, getSt().day, term).price, costPerHalfDay: halfDayCost,
      onHalfDay: (h) => (h % 2 === 0 ? advance() : true), place: `${portName}${sale.afloat ? ' (afloat)' : ''}`, bbl: c.bbl, name: progress.playerName ?? '',
    };
    return (
      <NegotiationPanel ctx={ctx}
        onClose={(nn) => { apply((p) => ({ progress: recordNegotiation(p, { parties: nn.parties }) })); onCancel(); }}
        onDeal={(deal) => {
          apply((p) => ({ progress: recordNegotiation(p, { parties: deal.parties, deal, edge: deal.edge }) }));
          onDone(sellNegotiated(c, getSt(), { port, diff: deal.diff, term: deal.term, afloat: sale.afloat, nego: deal }));
        }} />
    );
  };

  // CARRY in a tank session buys spot barrels: same panel, reversed. Sellers have floors,
  // patience and (when Cushing is filling) a clock of their own.
  const renderBuy = ({ t, st, action, onDone, onCancel }) => {
    const m = spotMarket(t, st.week, ECON);
    const bbl = Math.min(action.bbl ?? t.capacity, t.capacity);
    const ctx = {
      side: 'buy', fair: m.fair, desperation: m.desperation, theirClock: m.theirClock,
      roster: AGENTS, econ: ECON, relationships: progress.phys.relationships, seed: `${current.seed ?? current.key}|${st.week}|buy`,
      distressDays: 0, index: () => tankSpot(t, st.week),
      // The tank sits empty while you haggle: half a day of rent per round.
      costPerHalfDay: (bbl * t.rent) / 61, onHalfDay: () => true,
      place: `${current.card.location ?? 'Cushing'} spot`, bbl, name: progress.playerName ?? '',
    };
    return (
      <NegotiationPanel ctx={ctx}
        onClose={(nn) => { apply((p) => ({ progress: recordNegotiation(p, { parties: nn.parties }) })); onCancel(); }}
        onDeal={(deal) => {
          apply((p) => ({ progress: recordNegotiation(p, { parties: deal.parties, deal, edge: deal.edge }) }));
          onDone({ diff: deal.diff, nego: deal });
        }} />
    );
  };

  // Physical sessions: book to the physical desk ledger, then the physical debrief.
  const onPhysFinish = (kind) => (r) => {
    const events = apply((p) => bookPhysical(p, { card: current.card, kind, pnl: r.pnl, best: r.best.pnl, C: r.c?.D ?? r.t?.W ?? 0, curve: r.curve, ...(r.book ?? {}) }));
    // Passive benchmark: cargo = sell on day 0 at the best netback; tank = stay empty.
    const bots = (agentRuns ?? []).map((x) => ({ id: x.agent.id, pnl: Math.round(x.pnl) }));
    const passive = kind === 'cargo'
      ? { pnl: Math.round(runCargo(r.c, [{ type: 'SELL' }]).sold?.pnl ?? 0), label: 'sell day 0' }
      : { pnl: 0, label: 'stay empty' };
    Object.assign(r, physReview(kind, { pnl: r.pnl, bots, passive, curve: r.curve, fade: r.c?.fadedName ?? null }));
    if (kind === 'cargo') {
      const sold = r.st.sold;
      apply((p) => ({ progress: rememberCargo(p, { portName: r.c.ports.find((x) => x.id === sold.port).name, days: sold.day + 1, demurrage: r.st.cost.demurrage }) }));
    }
    // Dan pays his tank rent bleed in public.
    const dan = agentRuns?.find((x) => x.agent.id === 'dan');
    if (kind === 'tank' && dan?.rent > 0) {
      apply((p) => ({ progress: post(p, 'dan', 'brag', `Paid ${fmtMoney(dan.rent, { compact: true, sign: false })} rent to store oil on a coin flip. ${dan.pnl >= 0 ? 'WORTH IT' : 'worth it?? 🎰'}`) }));
    }
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
        review={result.review}
        onChallenge={() => openSheet(result.run, current.card.title, fmtDate(c.dates[0]), 'cargo', result.run.bots, result.review.verdict.checks, result.review.versus)}
        pnl={st.sold.pnl}
        best={best.pnl}
        bestText={`${portName(best.port)}${best.wait ? `, drift ${best.wait}d` : ''}, sell day ${best.sellDay + 1}`}
        lines={[
          { label: 'Flat price', value: s.flat, note: `${current.card.bench.name} ${c.flat[0].toFixed(2)} → ${c.flat[st.sold.day].toFixed(2)} $/bbl on ${(c.bbl / 1000).toFixed(0)}k bbl` },
          { label: 'Basis (location)', value: s.basis, note: `load ${c.load.basis.toFixed(2)} → ${portName(st.sold.port)} ${(st.sold.price - c.flat[st.sold.day]).toFixed(2)} vs ${current.card.bench.name}` },
          { label: 'Freight + demurrage + port', value: s.costs, note: `charter ${fmtMoney(st.cost.charter, { compact: true, sign: false })} · demurrage ${fmtMoney(st.cost.demurrage, { compact: true, sign: false })} · port ${fmtMoney(st.cost.port, { compact: true, sign: false })}${st.sold.freightToBuyer ? ` · afloat discount ${fmtMoney(st.sold.freightToBuyer, { compact: true, sign: false })}` : ''}` },
          { label: 'Events', value: s.events },
          ...(s.sched ? [{ label: 'Scheduler decisions', value: s.sched, note: st.log.filter((l) => l.type === 'sched').map((l) => l.text).join(' · ') }] : []),
        ]}
        log={st.log}
        extraTop={st.sold.nego && (
          <div className="mt-3 rounded-xl border border-amber/40 bg-amber/10 p-3">
            <div className="text-[10px] uppercase tracking-[0.2em] text-amber">The deal</div>
            <div className="num mt-1 text-[13px]">
              Sold to <b>{st.sold.nego.name}</b> at <b>{st.sold.diff >= 0 ? '+' : ''}{st.sold.diff.toFixed(2)}</b> vs {st.sold.term === 'AVG5' ? 'AVG5' : 'the index'} · first bid {st.sold.nego.first >= 0 ? '+' : ''}{st.sold.nego.first.toFixed(2)} · {st.sold.nego.halfDays / 2}d of haggling
            </div>
            <div className="num mt-1 flex items-baseline justify-between">
              <span className="text-[12px]">Negotiation edge <b className={st.sold.nego.edge >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(st.sold.nego.edge, { compact: true })}</b> · {st.sold.nego.pulled ? `${st.sold.nego.pulled} bid${st.sold.nego.pulled > 1 ? 's' : ''} pulled` : 'no bids pulled'}</span>
              <span className="rounded bg-amber px-1.5 text-sm font-extrabold text-black">{st.sold.nego.grade.grade}</span>
            </div>
            <div className="num text-[10.5px] text-dim">grade: edge captured vs their reservation ({Math.round(st.sold.nego.grade.captured * 100)}%) less days burned</div>
            {st.sold.term === 'AVG5' && (
              <div className="num mt-1 text-[11.5px] text-white/80">
                AVG5 resolved over {st.sold.index.days.map((d) => `${c.dates[d].slice(5)} $${c.flat[d].toFixed(2)}`).join(' · ')} = ${st.sold.index.price.toFixed(2)} (index on the day ${c.flat[st.sold.day].toFixed(2)}: {fmtMoney((st.sold.index.price - c.flat[st.sold.day]) * c.bbl, { compact: true })} from the term)
              </div>
            )}
          </div>
        )}
        extraBottom={agentRuns && (
          <DeskTable kind="cargo" runs={agentRuns}
            me={{ kind: 'cargo', pnl: st.sold.pnl, split: s, summary: `You: ${st.sold.afloat ? 'sold afloat toward' : 'discharged'} ${portName(st.sold.port)} day ${st.sold.day + 1}, ${st.cost.demurrage ? fmtMoney(st.cost.demurrage, { compact: true, sign: false }) + ' demurrage' : '$0 demurrage'}${result.c.faded ? ` · rivals faded ${portName(result.c.faded)}` : ''}` }}
            cols={[{ key: 'flat', label: 'flat' }, { key: 'basis', label: 'basis' }, { key: 'costs', label: 'costs' }, { key: 'events', label: 'events' }]} />
        )}
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
        review={result.review}
        onChallenge={() => openSheet(result.run, current.card.title, fmtDate(t.weeks[0].date), 'tank', result.run.bots, result.review.verdict.checks, result.review.versus)}
        pnl={sp.total}
        best={best.pnl}
        bestText={best.plan}
        lines={[
          { label: 'Carry locked (spread × barrels)', value: sp.locked, note: st.rolls ? `${st.rolls} roll${st.rolls > 1 ? 's' : ''} included` : 'cash-and-carry spreads you sold' },
          { label: 'Unwind / spread moves', value: sp.unwind, note: 'what selling early or at session end added or cost vs the locked spread' },
          { label: 'Tank rent paid', value: sp.rent, note: `$${t.rent.toFixed(2)}/bbl/month` },
          { label: 'Financing paid', value: sp.financing, note: `${(t.finance * 100).toFixed(1)}%/yr on the barrels' value` },
          ...(sp.sched ? [{ label: 'Scheduler decisions', value: sp.sched, note: st.log.filter((l) => l.type === 'sched').map((l) => l.text).join(' · ') }] : []),
        ]}
        extraTop={held.length > 0 && (<>
          {st.buyNego && (
            <div className="mt-3 rounded-xl border border-amber/40 bg-amber/10 p-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-amber">The buy</div>
              <div className="num mt-1 flex items-baseline justify-between">
                <span className="text-[12.5px]">Bought from <b>{st.buyNego.name}</b> at <b>{st.buyNego.diff >= 0 ? '+' : ''}{st.buyNego.diff.toFixed(2)}</b> vs spot · first offer {st.buyNego.first >= 0 ? '+' : ''}{st.buyNego.first.toFixed(2)} · edge <b className={st.buyNego.edge >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(st.buyNego.edge, { compact: true })}</b></span>
                <span className="rounded bg-amber px-1.5 text-sm font-extrabold text-black">{st.buyNego.grade.grade}</span>
              </div>
            </div>
          )}
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
        </>)}
        log={st.log.map((l) => ({ day: l.week, text: l.text }))}
        extraBottom={agentRuns && (
          <DeskTable runs={agentRuns}
            me={{ kind: 'tank', pnl: sp.total, split: sp, summary: `You: ${st.log.filter((l) => l.type === 'carry').length ? st.log.filter((l) => l.type === 'carry').map((l) => l.text.split(',')[0]).join('; ') : 'never stored'}` }}
            cols={[{ key: 'locked', label: 'carry' }, { key: 'unwind', label: 'unwind' }, { key: 'rent', label: 'rent' }, { key: 'financing', label: 'fin' }]} />
        )}
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

  // Two-book: book the combined result to the physical desk, graded on the hedge.
  const onTwoBookFinish = (r) => {
    const tb = r.twoBook;
    const pnl = Math.round(tb.paperFinal + tb.physFinal);
    const events = apply((p) => bookPhysical(p, { card: current.card, kind: 'integrated', pnl, best: Math.max(1, Math.abs(tb.naked[tb.naked.length - 1])), C: r.session.C, hedgeGrade: tb.grade.grade }));
    apply((p) => ({ progress: rememberHedge(p, tb.ratios[0] ?? 0) }));
    recent.current = [current.card.id, ...recent.current].slice(0, 8);
    setTimeout(() => setResult({ phys: 'integrated', ...r, pnl, events }), 1200);
  };
  const twoBookDebrief = result?.phys === 'integrated' && next && (() => {
    const tb = result.twoBook;
    const g = tb.grade;
    const desk = result.bots.map((b) => ({ ...botById[b.id], pnl: b.pnl })).concat([{ id: 'you', name: 'You', emoji: '🫵', pnl: result.pnl }]).sort((a, b) => b.pnl - a.pnl);
    return (
      <PhysDebrief
        title={`Two-book · ${current.card.instrument}`}
        pnl={result.pnl}
        best={Math.max(1, Math.abs(tb.naked[tb.naked.length - 1]))}
        gradeOverride={g.grade}
        bestText={`graded on the hedge · naked, the physical book would have made ${fmtMoney(Math.round(tb.physFinal), { compact: true })}`}
        lines={[
          { label: `Physical: ${tb.physical.desc}`, value: tb.physFinal, note: 'the exposure you could not close' },
          { label: 'Paper hedge', value: tb.paperFinal, note: `average hedge ratio ${Math.round(g.avg * 100)}%` },
          { label: 'Combined book', value: result.pnl },
        ]}
        extraTop={(
          <div className="mt-3 rounded-xl border border-sky-400/40 bg-sky-500/10 p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-[0.2em] text-sky-300">Hedge grade</span>
              <span className="num text-2xl font-extrabold text-sky-200">{g.grade}</span>
            </div>
            <p className="text-[13px] text-white/85">{g.why}</p>
            <div className="num mt-1 text-[11px] text-dim">combined drawdown {fmtMoney(-g.combinedDD, { compact: true })} vs naked {fmtMoney(-g.nakedDD, { compact: true })} ({Math.round(g.rel * 100)}%)</div>
            <ol className="num mt-2 space-y-0.5 text-[11.5px]">
              {desk.map((r, k) => <li key={r.id} className={r.id === 'you' ? 'font-bold text-amber' : 'text-white/80'}>{k + 1}. {r.emoji} {r.name} <span className={r.pnl >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(r.pnl, { compact: true })}</span></li>)}
            </ol>
          </div>
        )}
        why={current.card.why}
        source={`${current.card.source} ${tb.physical.source}`}
        concept={conceptById.get(current.card.session.concept)}
        onConcept={(cc, ok) => bookConcept(progress, record, cc, ok)}
        next={next}
        onNext={() => go()}
        onStop={() => setMode('idle')}
        extras={extras}
      />
    );
  })();

  // A physical IDEA card in the main feed: RUN IT opens a position that stays open across swipes.
  if (current.card.type === 'idea') {
    const { sc, step } = ideaOf(DESK_CARDS, current.card);
    const decide = (ran) => {
      let line;
      if (ran) {
        apply((p) => ({ progress: runIdea(p, current.card, DESK_CARDS) }));
        line = `▶ Running on the desk book: settles over your next ${step.horizon} swipes`;
      } else {
        let out;
        apply((p) => { const r = passIdea(p, current.card, DESK_CARDS); out = r.outcome; return { progress: r.progress }; });
        line = `${out.right ? '✓ Good pass' : '✗ It worked'}: it ${out.pnl >= 0 ? 'made' : 'lost'} ${fmtMoney(Math.round(out.pnl), { compact: true, sign: false })} over ${step.horizon}d`;
      }
      recent.current = [current.card.id, ...recent.current].slice(0, 8);
      setResult({ idea: true, ran, line });
    };
    return (
      <div className="flex h-[100dvh] flex-col">
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-[40px] pb-2">
          <div className="num mb-1 truncate text-[10px] font-extrabold tracking-[0.18em] text-amber">💡 PHYSICAL IDEA · {sc.title.toUpperCase()}</div>
          <div className="min-h-0 flex-1">
            <IdeaCard key={current.key} sc={sc} idea={{ ...step, by: null }} entry={step.day}
              decided={result?.idea ? { ran: result.ran, text: result.ran ? '▶ RUNNING' : 'PASSED' } : null}
              onRun={() => decide(true)} onPass={() => decide(false)} />
          </div>
        </div>
        {result?.idea && next && (
          <NextUp card={next.card} label={next.label} onGo={() => go()} onStop={() => setMode('idle')}>
            <div className={`num pop mb-1.5 rounded-md px-2 py-1.5 text-[12px] font-bold ${result.ran ? 'bg-amber/15 text-amber' : result.line.startsWith('✓') ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>{result.line}</div>
            {extras}
          </NextUp>
        )}
        {chat}
        {toast && <div className="pop num fixed inset-x-0 bottom-28 z-40 mx-auto w-fit max-w-[90%] rounded-lg bg-white px-3 py-2 text-xs font-bold text-black">{toast}</div>}
      </div>
    );
  }

  // A DESK scenario: physical dislocation as a short feed of ideas, decisions, news and rival pitches.
  if (current.card.type === 'desk') {
    const onPitch = (bot, idea) => apply((p) => ({ progress: post(p, bot, 'pitch', `💡 ${idea.title}. ${idea.pitch}`) }));
    const finishDeskSession = ({ sc, st, result: r }) => {
      const curve = deskCurve(sc, st);
      curve[curve.length - 1] = r.pnl;
      const events = apply((p) => bookPhysical(p, { card: current.card, kind: 'desk', pnl: r.pnl, best: r.best, C: sc.D, calls: r.calls, right: r.right, curve }));
      Object.assign(r, physReview('desk', { pnl: r.pnl, bots: AGENTS.map((a) => ({ id: a.id, pnl: Math.round(r.bots[a.id].pnl) })), passive: { pnl: 0, label: 'do nothing' }, curve }));
      // The best and worst rival trades get talked about in desk chat.
      const ranked = AGENTS.map((a) => ({ a, v: r.bots[a.id].pnl })).sort((x, y) => y.v - x.v);
      apply((p) => ({ progress: post(p, ranked[0].a.id, 'brag', `${current.card.title}: closed ${fmtMoney(Math.round(ranked[0].v), { compact: true })}. ${ranked[0].a.id === 'dan' ? 'told you 🎰' : 'Process.'}`) }));
      recent.current = [current.card.id, ...recent.current].slice(0, 8);
      setTimeout(() => setResult({ phys: 'desk', sc, r, events }), 600);
    };
    const deskDebrief = result?.phys === 'desk' && next && (() => {
      const { sc, r } = result;
      const steps = sc.steps;
      return (
        <PhysDebrief
          review={r.review}
          onChallenge={() => openSheet(r.run, current.card.title, fmtDate(sc.days[0]), 'desk', r.run.bots, r.review.verdict.checks, r.review.versus)}
          title={current.card.title}
          pnl={r.pnl}
          best={r.best}
          bestText={`run every winner, pass every loser, best scheduler calls · you were right on ${r.right}/${r.calls} ideas`}
          lines={[
            { label: 'Ideas you ran', value: Math.round(r.split.ideas), note: `${r.outcomes.filter((o) => o.ran).length} run · ${r.outcomes.filter((o) => !o.ran).length} passed` },
            { label: 'Scheduler decisions', value: Math.round(r.split.sched), note: 'costs paid and consequences landed' },
          ]}
          log={r.log}
          extraTop={(
            <div className="mt-3 rounded-xl border border-line bg-panel p-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-amber">Every call</div>
              {r.outcomes.map((o, i) => (
                <div key={i} className="num mt-1 flex items-baseline justify-between gap-2 text-[11.5px]">
                  <span className="truncate">{o.right ? '✓' : '✗'} {steps[o.stepIdx].kind === 'pitch' ? `${AGENTS.find((a) => a.id === steps[o.stepIdx].by)?.emoji} ` : ''}{o.idea.title}</span>
                  <span className="shrink-0"><span className="text-dim">{o.ran ? 'ran' : 'passed'} </span><b className={o.pnl >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(Math.round(o.pnl), { compact: true })}</b></span>
                </div>
              ))}
            </div>
          )}
          extraBottom={(
            <div className="mt-3 rounded-xl border border-line bg-panel p-3">
              <div className="text-[10px] uppercase tracking-[0.2em] text-dim">Desk table</div>
              {[{ id: 'me', name: 'You', emoji: '🫵', v: r.pnl }, ...AGENTS.map((a) => ({ ...a, v: r.bots[a.id].pnl }))].sort((x, y) => y.v - x.v).map((x) => (
                <div key={x.id} className="num mt-1 text-[11.5px]">
                  <div className="flex justify-between"><span className={x.id === 'me' ? 'font-bold text-amber' : ''}>{x.emoji} {x.name}</span><b className={x.v >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(Math.round(x.v), { compact: true })}</b></div>
                  {x.id !== 'me' && <div className="text-[10px] text-dim">{PITCH_RULES[x.id]}{r.bots[x.id].pitches.length ? ` · pitched: ${r.bots[x.id].pitches.map((pp) => `${pp.title} ${fmtMoney(Math.round(pp.pnl), { compact: true })}`).join(', ')}` : ''}</div>}
                </div>
              ))}
            </div>
          )}
          why={Array.isArray(sc.why) ? sc.why : [sc.why]}
          source={sc.source}
          concept={conceptById.get(sc.concept)}
          onConcept={(cc, ok) => bookConcept(progress, record, cc, ok)}
          next={next}
          onNext={() => go()}
          onStop={() => setMode('idle')}
          extras={extras}
        />
      );
    })();
    return (
      <div className="relative">
        <DeskSession key={current.key} card={current.card} onFinish={finishDeskSession} onPitch={onPitch} ghost={progress.played[current.card.id]?.curve ?? null} />
        {sheet && <ChallengeSheet run={sheet.run} info={sheet.info} onClose={() => setSheet(null)} onName={(nm) => nm && apply((p) => ({ progress: { ...p, playerName: nm } }))} />}
        {deskDebrief}
        {chat}
      </div>
    );
  }

  if (current.card.mode === 'integrated') {
    return (
      <div className="relative">
        <TradeSession key={current.key} card={current.card} salt={current.key} onFinish={onTwoBookFinish}
          bankroll={ECON.hedge.credit_line_usd.value} physical={current.card.session.physical} agents={AGENTS} />
        {twoBookDebrief}
        {chat}
      </div>
    );
  }

  if (current.card.type === 'tank') {
    return (
      <div className="relative">
        <TankSession key={current.key} card={current.card} econ={ECON} onFinish={onPhysFinish('tank')} rivals={physStrip} renderBuy={renderBuy} />
        {tankDebrief}
        {sheet && <ChallengeSheet run={sheet.run} info={sheet.info} onClose={() => setSheet(null)} onName={(nm) => nm && apply((p) => ({ progress: { ...p, playerName: nm } }))} />}
        {chat}
      </div>
    );
  }

  if (current.card.type === 'cargo') {
    return (
      <div className="relative">
        <CargoSession key={current.key} card={current.card} econ={ECON} onFinish={onPhysFinish('cargo')} rivals={physStrip} adjust={adjust} renderSell={renderSell} />
        {physDebrief}
        {sheet && <ChallengeSheet run={sheet.run} info={sheet.info} onClose={() => setSheet(null)} onName={(nm) => nm && apply((p) => ({ progress: { ...p, playerName: nm } }))} />}
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
        salt={current.seed ?? current.key}
        seed={current.seed ?? current.key}
        hard={Boolean(current.hard)}
        habits={habits(progress)}
        onFinish={onFinish}
      />
      {current.challenge && !result && (
        <div className="pop num pointer-events-none fixed inset-x-3 top-[52px] z-20 rounded-lg border border-amber/60 bg-black/90 px-3 py-1.5 text-center text-[12px] font-bold text-amber">
          ⚔ Beat {current.challenge.name}: {fmtMoney(current.challenge.pnl)} · same tape, same bots
        </div>
      )}
      {sheet && <ChallengeSheet run={sheet.run} info={sheet.info} onClose={() => setSheet(null)} onName={(nm) => nm && apply((p) => ({ progress: { ...p, playerName: nm } }))} />}
      {result && next && (
        <Debrief
          result={result}
          review={result.review}
          onChallenge={() => setSheet({
            run: result.run,
            info: {
              title: `${result.session.instrument} · ${result.session.card.headline ?? ''}`.slice(0, 60), date: fmtDate(result.session.date), kind: 'paper',
              standings: [{ name: progress.playerName || 'You', emoji: '🫵', pnl: result.pnl, me: true }, ...result.bots.map((b) => ({ ...botById[b.id], pnl: b.pnl }))].sort((a, b) => b.pnl - a.pnl),
              checks: result.review.verdict.checks,
              versus: result.review.versus ? { name: result.review.versus.name, pnl: result.review.versus.theirs } : null,
            },
          })}
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
