import { useCallback, useRef, useState } from 'react';
import TradeSession from '../trade/TradeSession.jsx';
import Debrief from '../trade/Debrief.jsx';
import { createFeed } from '../lib/feed.js';
import { comboMultiplier, fmtMoney, settle } from '../lib/book.js';
import { fmtDate } from '../lib/format.js';
import { CONCEPT_CARDS, SESSION_CARDS } from '../data/index.js';

const conceptById = new Map(CONCEPT_CARDS.map((c) => [c.id, c]));

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

/** Book a finished session (or a margin call) and return the trade record. */
export function bookSession(progress, record, { session, bots, pnl: raw }) {
  const win = raw > 0;
  const mult = win ? comboMultiplier(progress.combo) : 1;
  const pnl = Math.round(raw * mult);
  const trade = { pnl, base: Math.round(raw), mult, win, bots };
  record({
    cardId: session.id,
    category: session.card.category,
    correct: win,
    points: Math.max(-20, Math.min(60, Math.round(pnl / 2000))),
    trade,
  });
  return trade;
}

/** Concept question in a debrief or warm-up: right = $2,500 and keeps the streak. */
export function bookConcept(progress, record, concept, correct) {
  const trade = settle(concept, { correct }, progress.combo, concept.id);
  record({ cardId: concept.id, category: 'concepts', correct, points: correct ? 10 : 0, trade });
}

// TRADE: an endless run of sessions. Sessions you lose come back via the
// miss queue (about 1 in 5), same as cards did.
export default function Trade({ progress, record }) {
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const feedRef = useRef(null);
  if (!feedRef.current) feedRef.current = createFeed(SESSION_CARDS);
  // ?session=<id> opens a specific session first (e.g. ?session=ci-abqaiq-2019).
  const [current, setCurrent] = useState(() => {
    const want = new URLSearchParams(location.search).get('session');
    const card = want && SESSION_CARDS.find((c) => c.id === want);
    return card ? { key: `pick-${want}`, card } : feedRef.current.next(1, progress)[0];
  });
  const [result, setResult] = useState(null);
  const [toast, setToast] = useState('');

  const onFinish = useCallback((r) => {
    const trade = bookSession(progressRef.current, record, r);
    // Let the last candle's P&L flash land before the debrief slides up.
    setTimeout(() => setResult({ ...r, trade }), 1200);
  }, [record]);

  const next = () => {
    setResult(null);
    setCurrent(feedRef.current.next(1, progressRef.current)[0]);
  };

  const share = async (grid) => {
    const beat = result.trade.bots.filter((b) => result.trade.pnl > b.pnl).length;
    const how = await shareOrCopy(sessionShareText(result.session, grid, result.trade.pnl, beat));
    if (how === 'copied') { setToast('Copied. Paste it to a friend.'); setTimeout(() => setToast(''), 2500); }
  };

  return (
    <div className="relative">
      <TradeSession key={current.key} card={current.card} bankroll={progress.bankroll} salt={current.key} onFinish={onFinish} />
      {result && (
        <Debrief
          result={result}
          concept={conceptById.get(result.session.card.session.concept)}
          onConcept={(c, ok) => bookConcept(progressRef.current, record, c, ok)}
          onNext={next}
          onShare={share}
        />
      )}
      {toast && <div className="pop num fixed inset-x-0 bottom-24 z-40 mx-auto w-fit rounded-lg bg-white px-3 py-2 text-xs font-bold text-black">{toast}</div>}
    </div>
  );
}
