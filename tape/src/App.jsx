import { useCallback, useMemo, useRef, useState } from 'react';
import Feed from './components/Feed.jsx';
import CardShell from './components/CardShell.jsx';
import StoryBar from './components/StoryBar.jsx';
import Hud from './components/Hud.jsx';
import useProgress from './lib/useProgress.js';
import { createFeed } from './lib/feed.js';

// Step 2 placeholders: tap right/wrong to exercise scoring, streak and the miss queue.
const PLACEHOLDERS = [
  { id: 'demo-1', type: 'callit', category: 'crude', title: 'Prediction card' },
  { id: 'demo-2', type: 'concept', category: 'concepts', title: 'Concept card' },
  { id: 'demo-3', type: 'spread', category: 'spreads', title: 'Spread card' },
];

export default function App() {
  const { progress, session, record } = useProgress();
  const feedRef = useRef(null);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  if (!feedRef.current) feedRef.current = createFeed(PLACEHOLDERS);

  const [items, setItems] = useState(() => feedRef.current.next(6, progress));
  const [active, setActive] = useState(0);
  const [done, setDone] = useState({});

  const more = useCallback(() => setItems((xs) => [...xs, ...feedRef.current.next(5, progressRef.current)]), []);
  const answer = (item, correct) => {
    setDone((d) => ({ ...d, [item.key]: correct }));
    record({ cardId: item.card.id, category: item.card.category, correct, points: correct ? 10 : -5 });
  };
  const activeItem = items[active];
  const missCount = useMemo(() => Object.keys(progress.misses).length, [progress.misses]);

  return (
    <div className="relative h-[100dvh] bg-black">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-md bg-gradient-to-b from-black to-transparent">
        <StoryBar activeKey={activeItem?.key} done={activeItem && activeItem.key in done} />
        <Hud progress={progress} session={session} />
      </header>
      <Feed
        items={items}
        onActiveChange={setActive}
        onNearEnd={more}
        renderItem={(item) => (
          <CardShell kicker={item.card.type.toUpperCase()} badge={item.review && <span className="text-amber">↻ REVIEW</span>}>
            <div className="my-auto rounded-2xl border border-line bg-panel p-6">
              <h2 className="text-2xl font-bold">{item.card.title}</h2>
              <p className="num mt-2 text-xs text-dim">misses queued: {missCount} · answered: {progress.answered}</p>
              {item.key in done ? (
                <p className={`num mt-6 font-bold ${done[item.key] ? 'text-up' : 'text-down'}`}>
                  {done[item.key] ? '✓ RIGHT' : '✗ WRONG — queued for review'}
                </p>
              ) : (
                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button className="rounded-xl bg-up/15 py-3 font-bold text-up" onClick={() => answer(item, true)}>RIGHT</button>
                  <button className="rounded-xl bg-down/15 py-3 font-bold text-down" onClick={() => answer(item, false)}>WRONG</button>
                </div>
              )}
            </div>
          </CardShell>
        )}
      />
    </div>
  );
}
