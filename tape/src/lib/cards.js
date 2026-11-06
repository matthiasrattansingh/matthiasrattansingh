// One place that knows how to name and date any session card (paper, spread, cargo, tank, integrated).
export function cardTitle(c) {
  if (c.type === 'spread') return c.title;
  if (c.type === 'cargo' || c.type === 'tank') return c.title;
  return c.instrument;
}

export function cardDate(c) {
  if (c.type === 'spread') return c.spread.date;
  if (c.type === 'cargo') return c.days?.[0]?.date ?? c.start;
  if (c.type === 'tank') return c.weekly?.[0]?.date ?? c.start;
  return c.decision.date;
}

export function cardKind(c) {
  if (c.mode === 'integrated') return 'two-book';
  if (c.type === 'cargo') return 'cargo';
  if (c.type === 'tank') return 'tank';
  if (c.type === 'spread') return 'spread';
  return c.category;
}

export const isPhysical = (c) => c.type === 'cargo' || c.type === 'tank';
