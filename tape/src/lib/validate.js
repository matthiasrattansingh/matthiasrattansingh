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
  return errors;
}

