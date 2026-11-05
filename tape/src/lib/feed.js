// Builds the endless feed. Seed cards first (unseen before seen), types
// interleaved, and roughly 1 in 5 slots is a review card from the miss queue.

export const REVIEW_EVERY = 5;

function shuffle(xs, rand = Math.random) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Reorder so the same card type rarely appears twice in a row. */
function interleave(cards) {
  const pool = [...cards];
  const out = [];
  while (pool.length) {
    const prev = out[out.length - 1];
    let i = pool.findIndex((c) => c.type !== prev?.type);
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

export function buildDeck(cards, progress, { prioritize = [] } = {}) {
  const first = new Set(prioritize);
  const pri = cards.filter((c) => first.has(c.id));
  const rest = cards.filter((c) => !first.has(c.id));
  const unseen = rest.filter((c) => !progress.seen[c.id]);
  const seen = rest.filter((c) => progress.seen[c.id]);
  return [...shuffle(pri), ...interleave(shuffle(unseen)), ...interleave(shuffle(seen))].map((c) => c.id);
}

/**
 * Stateful feed generator. Keep one per session; call next(n, progress)
 * to get n more feed items: { key, card, review }.
 */
export function createFeed(cards, { inserts = [], insertEvery = 0 } = {}) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  let deck = [];
  let slot = 0;
  let insertIdx = 0;
  const recent = [];

  function remember(id) {
    recent.push(id);
    if (recent.length > 6) recent.shift();
  }

  function pickReview(progress) {
    const due = Object.entries(progress.misses)
      .filter(([id]) => byId.has(id) && !recent.includes(id))
      .sort((a, b) => a[1].due - b[1].due);
    if (!due.length) return null;
    const [id, m] = due[0];
    return m.due <= progress.answered + REVIEW_EVERY ? id : null;
  }

  function pickNormal(progress) {
    for (let tries = 0; tries < 2; tries++) {
      if (!deck.length) deck = buildDeck(cards, progress, { prioritize: Object.keys(progress.misses) });
      const i = deck.findIndex((id) => !recent.includes(id));
      if (i >= 0) return deck.splice(i, 1)[0];
      deck = [];
    }
    return cards[0].id;
  }

  return {
    next(n, progress) {
      const items = [];
      for (let k = 0; k < n; k++, slot++) {
        if (insertEvery && inserts.length && slot % insertEvery === insertEvery - 1) {
          const card = inserts[insertIdx++ % inserts.length];
          items.push({ key: `s${slot}-${card.id}`, card, review: false });
          continue;
        }
        const reviewId = slot % REVIEW_EVERY === REVIEW_EVERY - 1 ? pickReview(progress) : null;
        const id = reviewId ?? pickNormal(progress);
        if (reviewId) deck = deck.filter((x) => x !== reviewId);
        remember(id);
        items.push({ key: `s${slot}-${id}`, card: byId.get(id), review: Boolean(reviewId) });
      }
      return items;
    },
  };
}
