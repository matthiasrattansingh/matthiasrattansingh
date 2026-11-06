import data from '../data/levels.json';

const LEVELS = [...data.levels].sort((a, b) => a.minXp - b.minXp);

export function levelFor(xp) {
  let idx = 0;
  LEVELS.forEach((l, i) => { if (xp >= l.minXp) idx = i; });
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] ?? null;
  const pct = next ? (xp - cur.minXp) / (next.minXp - cur.minXp) : 1;
  return { ...cur, index: idx, next, pct: Math.max(0, Math.min(1, pct)) };
}

export { LEVELS };
