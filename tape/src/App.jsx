import { useCallback, useMemo, useRef, useState } from 'react';
import Feed from './components/Feed.jsx';
import StoryBar from './components/StoryBar.jsx';
import Hud from './components/Hud.jsx';
import MarginCall from './components/MarginCall.jsx';
import Profile from './screens/Profile.jsx';
import Desk from './screens/Desk.jsx';
import Bell from './screens/Bell.jsx';
import useProgress from './lib/useProgress.js';
import useLiveQuotes from './lib/useLiveQuotes.js';
import { createFeed } from './lib/feed.js';
import { settle } from './lib/book.js';
import { localDay } from './lib/progress.js';
import { bellCards, bellSummary } from './lib/bell.js';
import { FEED_CARDS, TAPE_CARDS } from './data/index.js';
import { CARD_COMPONENTS } from './cards/index.js';

const TAPE_EVERY = 9; // one TAPE CHECK card slotted into the main feed every 9 cards
const RENDER_WINDOW = 3; // cards further than this from the screen render as empty frames
const SYMBOLS = TAPE_CARDS.map((c) => c.symbol);
const LIVE_ITEMS = TAPE_CARDS.map((card) => ({ key: `live-${card.id}`, card }));

export default function App() {
  const { progress, session, record, view, saveBell, clearMarginCall, reset } = useProgress();
  const { quotes, status } = useLiveQuotes(SYMBOLS);
  const [tab, setTab] = useState('feed');
  const date = useMemo(() => localDay(), []);

  const progressRef = useRef(progress);
  progressRef.current = progress;
  const feedRef = useRef(null);
  if (!feedRef.current) feedRef.current = createFeed(FEED_CARDS, { inserts: TAPE_CARDS, insertEvery: TAPE_EVERY });

  // Generate outside state updaters (StrictMode runs those twice).
  const firstBatch = useRef(null);
  if (!firstBatch.current) firstBatch.current = feedRef.current.next(8, progress);
  const [items, setItems] = useState(firstBatch.current);
  const [active, setActive] = useState({ feed: 0, live: 0, bell: 0 });
  const [answers, setAnswers] = useState({}); // feed slot key -> saved answer

  const lengthRef = useRef(items.length);
  const more = useCallback(() => {
    const batch = feedRef.current.next(6, progressRef.current);
    lengthRef.current += batch.length;
    setItems((xs) => [...xs, ...batch]);
  }, []);
  const onFeedActive = useCallback((i) => {
    setActive((a) => ({ ...a, feed: i }));
    if (i >= lengthRef.current - 3) more();
  }, [more]);
  const onLiveActive = useCallback((i) => setActive((a) => ({ ...a, live: i })), []);
  const onBellActive = useCallback((i) => setActive((a) => ({ ...a, bell: i })), []);

  const bellSaved = progress.bell[date]?.saved ?? {};
  const bellDone = useMemo(() => bellSummary(bellCards(FEED_CARDS, date), date, bellSaved).done, [date, bellSaved]);
  const answerFor = (key) => answers[key] ?? bellSaved[key];

  // Every answer settles here: P&L (with the current win-streak multiplier),
  // the desk's trades on the same card, then the ledger.
  const onAnswer = (item) => (saved, result) => {
    if (!result) {
      setAnswers((a) => ({ ...a, [item.key]: saved }));
      view(item.card.id);
      return;
    }
    const card = item.card;
    const trade = settle(card, card.type === 'concept' ? { correct: result.correct } : saved, progressRef.current.combo, item.key);
    const full = { ...saved, result, trade, at: Date.now() };
    setAnswers((a) => ({ ...a, [item.key]: full }));
    if (item.bell) saveBell(date, item.key, full);
    record({ cardId: card.id, category: card.category, correct: trade.win, points: result.points, trade });
  };

  const renderCard = (activeIndex) => (item, i) => {
    if (Math.abs(i - activeIndex) > RENDER_WINDOW) return <section className="h-[100dvh] snap-start" />;
    const Card = CARD_COMPONENTS[item.card.type];
    const answer = answerFor(item.key);
    return (
      <Card
        card={item.card}
        slotKey={item.key}
        quote={item.card.symbol ? quotes[item.card.symbol] : undefined}
        answer={answer}
        onAnswer={answer ? () => {} : onAnswer(item)}
        badge={item.review ? <span className="num text-amber">↻ REVIEW</span> : item.bell ? <span className="num text-amber">🔔 BELL</span> : undefined}
      />
    );
  };

  const barItem = tab === 'feed' ? items[active.feed] : tab === 'live' ? LIVE_ITEMS[active.live] : null;

  return (
    <div className="relative h-[100dvh] bg-black">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-md bg-gradient-to-b from-black via-black/90 to-transparent pb-2">
        <StoryBar activeKey={barItem?.key ?? tab} done={!barItem || Boolean(answerFor(barItem.key))} />
        <Hud progress={progress} tab={tab} onTab={setTab} liveStatus={status} bellDone={bellDone} />
      </header>

      <div className={tab === 'feed' ? '' : 'hidden'}>
        <Feed items={items} onActiveChange={onFeedActive} renderItem={renderCard(active.feed)} />
      </div>
      {tab === 'bell' && <Bell date={date} progress={progress} renderCard={renderCard} onActive={onBellActive} active={active.bell} />}
      {tab === 'live' && <Feed items={LIVE_ITEMS} onActiveChange={onLiveActive} renderItem={renderCard(active.live)} />}
      {tab === 'desk' && <Desk progress={progress} />}
      {tab === 'me' && <Profile progress={progress} session={session} onReset={reset} />}

      {progress.marginCall && <MarginCall blowups={progress.blowups} onClose={clearMarginCall} />}
    </div>
  );
}
