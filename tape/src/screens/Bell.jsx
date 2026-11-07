import { useMemo, useState } from 'react';
import TradeSession from '../trade/TradeSession.jsx';
import { gradeGrid } from '../trade/engine.js';
import Choice from '../components/Choice.jsx';
import { BELL_CANDLES, bellSession, bellState, shareText } from '../lib/bell.js';
import { fmtMoney } from '../lib/book.js';
import { BOTS } from '../lib/rivals.js';
import { seeded } from '../lib/format.js';
import { CONCEPT_CARDS, SESSION_CARDS } from '../data/index.js';
import { bookConcept, bookSession, shareOrCopy } from './Trade.jsx';
import { afterSession } from '../game/afterSession.js';
import { bellStreak } from '../game/streaks.js';


function Warmup({ concept, onDone }) {
  const [pick, setPick] = useState(null);
  const order = useMemo(() => {
    const rand = seeded(`warm|${concept.id}`);
    const idx = concept.question.choices.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    return idx;
  }, [concept]);
  const right = pick === concept.question.answer;
  return (
    <div className="flex h-[100dvh] flex-col px-4 pt-[52px] pb-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-amber">🔔 Open Bell · warm-up · +$2,500 if right</div>
      <h2 className="mt-1 text-2xl font-extrabold">{concept.title}</h2>
      <p className="mt-1 text-[13px] leading-snug text-white/70">{concept.lines.slice(0, 2).join(' ')}</p>
      <p className="mt-3 text-[15px] font-semibold leading-snug">{concept.question.prompt}</p>
      <div className="mt-2 space-y-2">
        {order.map((i) => {
          const ok = i === concept.question.answer;
          const look = pick === null ? 'border-line bg-panel active:bg-white/10' : ok ? 'border-up/60 bg-up/15 text-up' : pick === i ? 'border-down/60 bg-down/15 text-down' : 'hidden';
          return (
            <button key={i} onClick={() => pick === null && setPick(i)} className={`w-full rounded-xl border px-3 py-3 text-left text-sm leading-snug ${look}`}>
              {concept.question.choices[i]}
            </button>
          );
        })}
      </div>
      {pick !== null && <p className={`mt-2 text-[13px] leading-snug ${right ? 'text-up' : 'text-white/80'}`}>{right ? '✓ +$2,500. ' : '✗ '}{concept.question.explain}</p>}
      <div className="mt-auto">
        {pick !== null && <Choice tone="amber" className="h-14 w-full" onClick={() => onDone(right)}>RING THE BELL · 5 TRADES ▶</Choice>}
      </div>
    </div>
  );
}

function Results({ date, r, abandoned, streak = 0 }) {
  const [status, setStatus] = useState('');
  const share = async () => {
    const how = await shareOrCopy(shareText(date, r));
    setStatus(how === 'copied' ? 'Copied. Paste it to a friend.' : how === 'failed' ? shareText(date, r) : '');
  };
  if (abandoned) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center px-6 text-center">
        <div className="text-6xl">🔕</div>
        <p className="mt-3 text-lg font-bold">You left today's bell mid-session.</p>
        <p className="mt-1 text-sm text-dim">One shot per day. New bell at midnight.</p>
      </div>
    );
  }
  const board = [{ id: 'you', name: 'You', emoji: '🫵', pnl: r.pnl }, ...BOTS.map((b) => ({ ...b, pnl: r.bots[b.id] ?? 0 }))].sort((a, b) => b.pnl - a.pnl);
  return (
    <div className="flex h-[100dvh] flex-col px-4 pt-[52px] pb-4">
      <div className="text-[10px] uppercase tracking-[0.2em] text-amber">🔔 Open Bell · {r.title}</div>
      <div className="num mt-1 text-[12px] font-bold text-amber">🔥 {streak}-day bell streak{streak >= 7 ? ' · on fire' : ''}</div>
      <div className="num mt-4 text-center text-4xl tracking-widest">{r.grid}</div>
      <div className={`num mt-3 text-center text-5xl font-extrabold ${r.pnl >= 0 ? 'text-up' : 'text-down'}`}>{fmtMoney(r.pnl)}</div>
      <div className="num mt-1 text-center text-sm font-bold text-amber">{r.beat === 4 ? '👑 You beat the whole desk' : `You beat ${r.beat}/4 of the desk`}</div>
      <ol className="mt-5 space-y-1.5">
        {board.map((x, i) => (
          <li key={x.id} className={`num flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${x.id === 'you' ? 'border-amber/50 bg-amber/10' : 'border-line bg-panel'}`}>
            <span>{i + 1}. {x.emoji} {x.name}</span>
            <span className={x.pnl >= 0 ? 'text-up' : 'text-down'}>{fmtMoney(x.pnl)}</span>
          </li>
        ))}
      </ol>
      <div className="mt-auto pt-4">
        <Choice tone="amber" className="h-14 w-full" onClick={share}>SHARE · CHALLENGE A FRIEND</Choice>
        {status && <p className="mt-2 whitespace-pre-wrap text-center text-[12px] text-dim">{status}</p>}
        <p className="mt-2 text-center text-[11px] text-dim">Same session for everyone today. New bell at midnight.</p>
      </div>
    </div>
  );
}

// The daily challenge: warm-up question, then today's session as 5 candles.
export default function Bell({ date, progress, record, apply, saveBell }) {
  const card = useMemo(() => bellSession(SESSION_CARDS, date), [date]);
  // Warm-up uses a different concept from today's session, so it can't give the trade away.
  const concept = useMemo(() => {
    const pool = CONCEPT_CARDS.filter((c) => c.id !== card.session.concept);
    return pool[Math.floor(seeded(`warmup|${date}`)() * pool.length)];
  }, [card, date]);
  const saved = bellState(progress, date);
  const [stage, setStage] = useState(() => (saved.result ? 'results' : saved.started ? 'abandoned' : saved.warmup ? 'trade' : 'warmup'));

  if (stage === 'results' || stage === 'abandoned') return <Results date={date} r={saved.result} abandoned={stage === 'abandoned' && !saved.result} streak={bellStreak(progress, date)} />;
  if (stage === 'warmup') {
    return (
      <Warmup concept={concept} onDone={(ok) => {
        bookConcept(progress, record, concept, ok);
        saveBell(date, 'warmup', { correct: ok });
        saveBell(date, 'started', true);
        setStage('trade');
      }} />
    );
  }
  return (
    <TradeSession
      card={card}
      bankroll={progress.bankroll}
      salt={`bell|${date}`}
      maxCandles={BELL_CANDLES}
      onFinish={(r) => {
        const trade = bookSession(progress, record, r);
        apply((p) => afterSession(p, { session: r.session, pnl: r.pnl, curve: r.sim.curve, full: false, stats: r.stats, bots: r.bots, marginCall: r.marginCall, trade, now: Date.now() }));
        const beat = trade.bots.filter((b) => trade.pnl > b.pnl).length;
        saveBell(date, 'result', {
          pnl: trade.pnl, beat, grid: gradeGrid(r.sim), title: `${r.session.instrument} · ${r.session.open}`,
          bots: Object.fromEntries(trade.bots.map((b) => [b.id, b.pnl])),
        });
        setTimeout(() => setStage('results'), 1400);
      }}
    />
  );
}
