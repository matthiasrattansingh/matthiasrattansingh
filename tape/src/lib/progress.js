// The progress model: XP, streak, accuracy by category and the miss queue.
// Every function here is pure: (progress, ...) -> new progress.
import { xpFor } from './scoring.js';

export const CATEGORIES = {
  crude: 'Crude direction',
  spreads: 'Spreads',
  products: 'Products',
  concepts: 'Concepts',
};

// Spaced repetition schedule in "cards answered" (not days): a miss comes back
// after 4 cards; each correct review pushes it further out; after the last
// step it graduates out of the queue.
export const REVIEW_STEPS = [4, 12, 30];

export function emptyProgress() {
  return {
    version: 1,
    xp: 0,
    answered: 0,
    bestSession: 0,
    streak: { count: 0, best: 0, last: null },
    stats: Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, { right: 0, total: 0 }])),
    seen: {},
    misses: {},
  };
}

/** Merge whatever was saved with the current shape so old saves keep working. */
export function hydrate(saved) {
  const base = emptyProgress();
  if (!saved || saved.version !== 1) return base;
  return {
    ...base,
    ...saved,
    streak: { ...base.streak, ...saved.streak },
    stats: { ...base.stats, ...saved.stats },
    seen: saved.seen ?? {},
    misses: saved.misses ?? {},
  };
}

export function localDay(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dayDiff(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

/** Consecutive-days streak. Using the app on a new day extends or resets it. */
export function touchStreak(streak, today = localDay()) {
  if (streak.last === today) return streak;
  const gap = streak.last ? dayDiff(streak.last, today) : null;
  const count = gap === 1 ? streak.count + 1 : 1;
  return { count, best: Math.max(streak.best, count), last: today };
}

/** A streak shown on screen: 0 if you skipped yesterday and haven't played today. */
export function liveStreak(streak, today = localDay()) {
  if (!streak.last) return 0;
  return dayDiff(streak.last, today) <= 1 ? streak.count : 0;
}

function scheduleMiss(misses, id, correct, answered) {
  const cur = misses[id];
  const next = { ...misses };
  if (!correct) {
    next[id] = { due: answered + REVIEW_STEPS[0], step: 0, lapses: (cur?.lapses ?? 0) + 1 };
  } else if (cur) {
    const step = cur.step + 1;
    if (step >= REVIEW_STEPS.length) delete next[id];
    else next[id] = { ...cur, step, due: answered + REVIEW_STEPS[step] };
  }
  return next;
}

/**
 * Record one answered card.
 * result: { cardId, category, correct, points }
 */
export function recordResult(progress, result, today = localDay()) {
  const answered = progress.answered + 1;
  const cat = progress.stats[result.category] ?? { right: 0, total: 0 };
  return {
    ...progress,
    answered,
    xp: progress.xp + xpFor(result.points),
    streak: touchStreak(progress.streak, today),
    stats: {
      ...progress.stats,
      [result.category]: { right: cat.right + (result.correct ? 1 : 0), total: cat.total + 1 },
    },
    seen: { ...progress.seen, [result.cardId]: (progress.seen[result.cardId] ?? 0) + 1 },
    misses: scheduleMiss(progress.misses, result.cardId, result.correct, answered),
  };
}

/** Small XP for "learn one thing" cards with no right/wrong (e.g. TAPE CHECK). */
export function recordView(progress, cardId, xp = 3, today = localDay()) {
  if (progress.seen[cardId] && progress.seenToday?.[cardId] === today) return progress;
  return {
    ...progress,
    xp: progress.xp + xp,
    streak: touchStreak(progress.streak, today),
    seen: { ...progress.seen, [cardId]: (progress.seen[cardId] ?? 0) + 1 },
    seenToday: { ...(progress.seenToday ?? {}), [cardId]: today },
  };
}
