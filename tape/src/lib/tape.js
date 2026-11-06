import tape from '../data/tapecheck.json';

/** Seeded headline for a symbol on (or the day before) a given date, or null. */
export function headlineFor(symbol, asOf) {
  if (!asOf) return null;
  const d = new Date(`${asOf}T12:00:00`);
  const prev = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  const hit = (tape.headlines ?? []).find((h) => h.symbols?.includes(symbol) && (h.date === asOf || h.date === prev));
  return hit?.text ?? null;
}
