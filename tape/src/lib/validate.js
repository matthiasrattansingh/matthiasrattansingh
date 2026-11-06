// Shape checks for seed cards. Shared by the app and `npm run validate`.
const COMMON = ['id', 'type', 'category', 'difficulty', 'source'];
const REQUIRED = {
  callit: ['instrument', 'unit', 'headline', 'setup', 'decision', 'outcome', 'horizon', 'series', 'after', 'why'],
  concept: ['title', 'lines', 'question'],
  spread: ['title', 'unit', 'headline', 'setup', 'legs', 'spread', 'horizon', 'outcome', 'why'],
  tapecheck: ['symbol', 'name', 'unit', 'driver', 'fallback'],
  cargo: ['title', 'open', 'cargo', 'bench', 'days', 'load', 'ports', 'decisions', 'events', 'why'],
  tank: ['title', 'open', 'location', 'weekly', 'why'],
};
const CATEGORIES = ['crude', 'spreads', 'products', 'concepts', 'physical'];

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
  if (c?.type === 'cargo') errors.push(...validateCargo(c));
  if (c?.type === 'tank') errors.push(...validateTank(c));
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


export const CARGO_EVENTS = ['port_congestion', 'pipeline_outage', 'weather_delay', 'refinery_outage', 'refinery_restart', 'demand_spike', 'demand_fade', 'quality_dispute', 'distressed_seller'];

/** CARGO checks: 10-14 real day-steps, 2-3 ports, events dated to the days they fire on. */
export function validateCargo(c) {
  const errors = [];
  const days = c.days ?? [];
  if (days.length < 10 || days.length > 14) errors.push(`cargo needs 10-14 day-steps, has ${days.length} (run scripts/build-physical.py)`);
  if (days.some((d) => !d.date || !Number.isFinite(d.flat))) errors.push('every day needs a date and a numeric flat price');
  if (c.open && c.open.length > OPEN_MAX) errors.push(`open is over ${OPEN_MAX} characters`);
  if (!(c.ports?.length >= 2 && c.ports.length <= 3)) errors.push('cargo needs 2-3 ports');
  for (const p of c.ports ?? []) {
    if (!p.id || !p.name || !(p.voyage >= 1) || !p.basis || !Number.isFinite(p.basis.start) || !Number.isFinite(p.basis.end)) errors.push(`port ${p.id ?? '?'} needs id, name, voyage >= 1 and basis {start, end}`);
    if (days.length && p.voyage > days.length - 1) errors.push(`port ${p.id}: voyage longer than the session`);
  }
  if (!c.decisions?.includes(0)) errors.push('decisions must include day 0 (choose the first port)');
  const ids = new Set((c.ports ?? []).map((p) => p.id));
  for (const ev of c.events ?? []) {
    if (!CARGO_EVENTS.includes(ev.type)) errors.push(`unknown event type ${ev.type}`);
    if (!(ev.day >= 0 && ev.day < days.length)) errors.push(`event "${ev.text}" day out of range`);
    else if (ev.date && days[ev.day].date !== ev.date) errors.push(`event "${ev.text}" dated ${ev.date} but day ${ev.day} is ${days[ev.day].date}`);
    if (ev.port && !ids.has(ev.port)) errors.push(`event "${ev.text}" names unknown port ${ev.port}`);
    if (!ev.text || ev.text.length > NEWS_MAX) errors.push(`event text must be 1-${NEWS_MAX} characters: "${ev.text}"`);
    // Negotiation set-pieces: how many buyers come to the table and what they open with.
    if (ev.buyers != null && !(ev.port && [1, 2, 3].includes(ev.buyers))) errors.push(`event "${ev.text}" set-piece needs a port and 1-3 buyers`);
    if (ev.line != null && !(ev.line.length > 0 && ev.line.length <= NEWS_MAX)) errors.push(`event "${ev.text}" line must be 1-${NEWS_MAX} characters`);
    if (ev.until_day != null && !(ev.until_day > ev.day)) errors.push(`event "${ev.text}" until_day must be after its day`);
  }
  return errors;
}

/** TANK checks: 8-12 weekly steps, each with a 4-month curve, delivery months and an EIA print. */
export function validateTank(c) {
  const errors = [];
  const weeks = c.weekly ?? [];
  if (weeks.length < 8 || weeks.length > 12) errors.push(`tank needs 8-12 weekly steps, has ${weeks.length} (run scripts/build-physical.py)`);
  if (c.open && c.open.length > OPEN_MAX) errors.push(`open is over ${OPEN_MAX} characters`);
  weeks.forEach((w, i) => {
    if (!(w.curve?.length === 4) || w.curve.some((v) => !Number.isFinite(v))) errors.push(`week ${i}: curve needs 4 prices`);
    if (!(w.months?.length === 4)) errors.push(`week ${i}: months needs 4 delivery months`);
    if (!w.eia || !Number.isFinite(w.eia.cushing_mmbbl)) errors.push(`week ${i}: missing the EIA print`);
  });
  return errors;
}
