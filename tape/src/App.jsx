import { useCallback, useRef, useState } from 'react';
import Feed from './components/Feed.jsx';
import StoryBar from './components/StoryBar.jsx';
import Hud from './components/Hud.jsx';
import useProgress from './lib/useProgress.js';
import { createFeed } from './lib/feed.js';
import { FEED_CARDS, TAPE_CARDS } from './data/index.js';
import { CARD_COMPONENTS } from './cards/index.js';

const TAPE_EVERY = 9; // one TAPE CHECK card slotted in every 9 cards
const RENDER_WINDOW = 3; // cards further than this from the screen render as empty frames

export default function App() {
  const { progress, session, record, view } = useProgress();
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const feedRef = useRef(null);
  if (!feedRef.current) feedRef.current = createFeed(FEED_CARDS, { inserts: TAPE_CARDS, insertEvery: TAPE_EVERY });

  // Generate outside state updaters (StrictMode runs those twice).
  const firstBatch = useRef(null);
  if (!firstBatch.current) firstBatch.current = feedRef.current.next(8, progress);
  const [items, setItems] = useState(firstBatch.current);
  const [active, setActive] = useState(0);
  const [answers, setAnswers] = useState({}); // feed slot key -> saved answer

  const lengthRef = useRef(items.length);
  const more = useCallback(() => {
    const batch = feedRef.current.next(6, progressRef.current);
    lengthRef.current += batch.length;
    setItems((xs) => [...xs, ...batch]);
  }, []);
  const onActive = useCallback((i) => {
    setActive(i);
    if (i >= lengthRef.current - 3) more();
  }, [more]);

  const onAnswer = (item) => (saved, result) => {
    setAnswers((a) => ({ ...a, [item.key]: saved }));
    if (result) record({ cardId: item.card.id, category: item.card.category, correct: result.correct, points: result.points });
    else view(item.card.id);
  };

  const activeItem = items[active];

  return (
    <div className="relative h-[100dvh] bg-black">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-md bg-gradient-to-b from-black via-black/90 to-transparent">
        <StoryBar activeKey={activeItem?.key} done={Boolean(activeItem && answers[activeItem.key])} />
        <Hud progress={progress} session={session} />
      </header>
      <Feed
        items={items}
        onActiveChange={onActive}
        renderItem={(item, i) => {
          if (Math.abs(i - active) > RENDER_WINDOW) return <section className="h-[100dvh] snap-start" />;
          const Card = CARD_COMPONENTS[item.card.type];
          return (
            <Card
              card={item.card}
              slotKey={item.key}
              answer={answers[item.key]}
              onAnswer={onAnswer(item)}
              badge={item.review ? <span className="num text-amber">↻ REVIEW</span> : undefined}
            />
          );
        }}
      />
    </div>
  );
}
