// Shape checks for seed cards. Shared by the app and `npm run validate`.
const COMMON = ['id', 'type', 'category', 'difficulty', 'source'];
const REQUIRED = {
  callit: ['instrument', 'unit', 'headline', 'setup', 'decision', 'outcome', 'horizon', 'series', 'after', 'why'],
  concept: ['title', 'lines', 'question'],
  spread: ['title', 'unit', 'headline', 'setup', 'legs', 'spread', 'horizon', 'outcome', 'why'],
  tapecheck: ['symbol', 'name', 'unit', 'driver', 'fallback'],
};
const CATEGORIES = ['crude', 'spreads', 'products', 'concepts'];

export function validateCard(c) {
  const errors = [];
  for (const f of [...COMMON, ...(REQUIRED[c?.type] ?? [])]) if (c?.[f] === undefined) errors.push(`missing "${f}"`);
  if (c && !REQUIRED[c.type]) errors.push(`unknown type "${c.type}"`);
  if (c?.category && !CATEGORIES.includes(c.category)) errors.push(`category must be one of ${CATEGORIES.join(', ')}`);
  if (c?.type === 'concept' && c.question && !(c.question.answer >= 0 && c.question.answer < c.question.choices?.length)) {
    errors.push('question.answer must index into question.choices');
  }
  if (c?.type === 'spread' && c.outcome && !['WIDEN', 'NARROW'].includes(c.outcome.result)) {
    errors.push('outcome.result must be WIDEN or NARROW');
  }
  if (c?.session) errors.push(...validateSession(c));
  return errors;
}

export const NEWS_MAX = 40;
export const OPEN_MAX = 44;

/** TRADE-mode checks: candle shape and count, news fits one line, ends at the real outcome. */
export function validateSession(c) {
  const s = c.session;
  const errors = [];
  const candles = s.candles ?? [];
  const [lo, hi] = c.type === 'spread' ? [8, 8] : [12, 16];
  if (candles.length < lo || candles.length > hi) errors.push(`session needs ${lo}-${hi} candles, has ${candles.length}`);
  candles.forEach((k, i) => {
    if (!Array.isArray(k) || k.length < 4 || k.slice(0, 4).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
      errors.push(`candle ${i} must be [open, high, low, close, label]`);
      return;
    }
    const [o, h, l, cl] = k;
    if (h < Math.max(o, cl) - 1e-9 || l > Math.min(o, cl) + 1e-9) errors.push(`candle ${i}: high/low must contain open and close`);
  });
  const end = c.type === 'spread' ? c.outcome?.spread : c.outcome?.price;
  if (candles.length && Math.abs(candles[candles.length - 1][3] - end) > 1e-9) errors.push('last candle must close at the outcome price');
  if (!s.open) errors.push('session.open (one-line opener) is required');
  else if (s.open.length > OPEN_MAX) errors.push(`session.open is over ${OPEN_MAX} characters`);
  for (const n of s.news ?? []) {
    if (!n.text || n.text.length > NEWS_MAX) errors.push(`news "${n.text}" must be 1-${NEWS_MAX} characters`);
    if (!(n.at >= 0 && n.at < candles.length)) errors.push(`news "${n.text}" has no valid "at" candle index`);
  }
  return errors;
}

