import { useCallback, useMemo, useRef, useState } from 'react';
import Feed from '../components/Feed.jsx';
import FORECAST from '../data/forecast.json'; // real EIA weeks; this screen is code-split
import { PrintCard, ReactionCard } from './ForecastCards.jsx';
import { agentForecasts, baseRates, buildDeck, classesFor, printStats, printXp, reactionStats, actualOf } from './engine.js';

// The EIA tab: an endless feed of real weekly prints. Each week is two feed items:
// the PRINT forecast, then the REACTION call. Petroleum and gas run 2:1; each kind's deck
// mirrors its own real size-class base rates.
const PATTERN = ['petroleum', 'petroleum', 'gas'];
const CHUNK = 6;

export default function ForecastScreen({ progress, apply }) {
  const meta = useMemo(() => Object.fromEntries(['petroleum', 'gas'].map((kind) => {
    const records = FORECAST[kind];
    const classes = classesFor(FORECAST, kind);
    return [kind, { records, classes, rates: baseRates(records, kind, classes), idx: new Map(records.map((r, i) => [r.id, i])) }];
  })), []);

  // Decks are built once per visit from the weeks you haven't played yet.
  const decks = useRef(null);
  if (!decks.current) {
    const seed = `${progress.createdAt}|${Object.keys(progress.forecast.prints.petroleum).length}`;
    decks.current = Object.fromEntries(Object.entries(meta).map(([kind, m]) => [kind, buildDeck(kind, m.records, m.classes, { seed, played: progress.forecast.prints[kind], rates: m.rates })]));
  }
  const cursor = useRef({ n: 0, petroleum: 0, gas: 0 });
  const take = (count) => {
    const out = [];
    for (let k = 0; k < count; k++) {
      const kind = PATTERN[cursor.current.n++ % PATTERN.length];
      const deck = decks.current[kind];
      const id = deck[cursor.current[kind]++ % deck.length];
      out.push({ key: `p-${id}-${cursor.current.n}`, type: 'print', kind, id }, { key: `r-${id}-${cursor.current.n}`, type: 'reaction', kind, id });
    }
    return out;
  };
  const [items, setItems] = useState(() => take(CHUNK));
  const onActive = useCallback((i) => { if (i >= items.length - 4) setItems((xs) => [...xs, ...take(CHUNK)]); }, [items.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => Object.fromEntries(Object.entries(meta).map(([kind, m]) => [kind, {
    print: printStats(kind, m.records, m.classes, progress.forecast.prints[kind]),
    reaction: reactionStats(kind, m.records, progress.forecast.reactions[kind]),
  }])), [meta, progress.forecast]);

  const lock = (kind, id, guess) => apply((p) => {
    if (p.forecast.prints[kind][id] != null) return { progress: p };
    const m = meta[kind];
    const err = Math.abs(guess - actualOf(kind, m.records[m.idx.get(id)]));
    // Band from your record before this week (it tightens as you improve; overcalling shrinks it).
    const before = printStats(kind, m.records, m.classes, p.forecast.prints[kind]);
    return { progress: { ...p, xp: p.xp + printXp(kind, err, before), forecast: { ...p.forecast, prints: { ...p.forecast.prints, [kind]: { ...p.forecast.prints[kind], [id]: guess } } } } };
  });
  const call = (kind, id, dir, right) => apply((p) => {
    if (p.forecast.reactions[kind][id]) return { progress: p };
    return { progress: { ...p, xp: p.xp + (right ? 10 : 2), forecast: { ...p.forecast, reactions: { ...p.forecast.reactions, [kind]: { ...p.forecast.reactions[kind], [id]: dir } } } } };
  });

  return (
    <Feed items={items} onActiveChange={onActive}
      renderItem={(item, i) => {
        const m = meta[item.kind];
        const ri = m.idx.get(item.id);
        const rec = m.records[ri];
        const guess = progress.forecast.prints[item.kind][item.id];
        if (item.type === 'print') {
          return (
            <PrintCard kind={item.kind} rec={rec} records={m.records} index={Math.floor(i / 2)} classes={m.classes} rates={m.rates}
              guess={guess} stats={stats[item.kind].print} agents={agentForecasts(item.kind, m.records, ri)}
              onLock={(g) => lock(item.kind, item.id, g)} />
          );
        }
        const c = progress.forecast.reactions[item.kind][item.id];
        return (
          <ReactionCard kind={item.kind} rec={rec} printLocked={guess != null} call={c} rstats={stats[item.kind].reaction}
            onCall={(dir) => call(item.kind, item.id, dir, dir === (rec[item.kind === 'gas' ? 'ng' : 'wti'].chg > 0 ? 'UP' : 'DOWN'))} />
        );
      }} />
  );
}
