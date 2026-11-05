import { useCallback, useState } from 'react';
import Feed from './components/Feed.jsx';
import CardShell from './components/CardShell.jsx';
import StoryBar from './components/StoryBar.jsx';

const PLACEHOLDERS = [
  { key: 'p1', kicker: 'CALL IT', title: 'Prediction card', body: 'Historical setup → LONG / SHORT / FLAT.' },
  { key: 'p2', kicker: 'CONCEPT BITE', title: 'Concept card', body: 'One idea, four lines, one question.' },
  { key: 'p3', kicker: 'SPREAD SNAP', title: 'Spread card', body: 'Two prices → WIDEN or NARROW.' },
];

export default function App() {
  const [active, setActive] = useState(0);
  const [items, setItems] = useState(PLACEHOLDERS);
  const more = useCallback(
    () => setItems((xs) => [...xs, ...PLACEHOLDERS.map((p) => ({ ...p, key: `${p.key}-${xs.length}` }))]),
    [],
  );

  return (
    <div className="relative h-[100dvh] bg-black">
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 mx-auto max-w-md">
        <StoryBar activeKey={items[active]?.key} done={false} />
        <div className="flex items-center justify-between px-4 py-2">
          <span className="num text-sm font-bold tracking-[0.3em] text-up">TAPE</span>
          <span className="num text-xs text-dim">{active + 1}/{items.length}</span>
        </div>
      </header>
      <Feed
        items={items}
        onActiveChange={setActive}
        onNearEnd={more}
        renderItem={(item) => (
          <CardShell kicker={item.kicker}>
            <div className="my-auto rounded-2xl border border-line bg-panel p-6">
              <h2 className="text-2xl font-bold">{item.title}</h2>
              <p className="mt-2 text-dim">{item.body}</p>
              <p className="num mt-6 text-xs text-dim">swipe up ↑</p>
            </div>
          </CardShell>
        )}
      />
    </div>
  );
}
