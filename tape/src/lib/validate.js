// Shape checks for seed cards. Shared by the app and `npm run validate`.
const COMMON = ['id', 'type', 'category', 'difficulty', 'source'];
const REQUIRED = {
  callit: ['instrument', 'unit', 'headline', 'setup', 'decision', 'outcome', 'horizon', 'series', 'after', 'why'],
  concept: ['title', 'lines', 'question'],
  spread: ['title', 'unit', 'headline', 'setup', 'legs', 'spread', 'horizon', 'outcome', 'why'],
  tapecheck: ['symbol', 'name', 'unit', 'driver', 'fallback'],
  cargo: ['title', 'open', 'cargo', 'bench', 'days', 'load', 'ports', 'decisions', 'events', 'why'],
  tank: ['title', 'open', 'location', 'weekly', 'why'],
  desk: ['title', 'open', 'date', 'days', 'series', 'chart', 'steps', 'pitchable', 'why', 'concept'],
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
  if (c?.type === 'desk') errors.push(...validateDesk(c));
  if (c?.scheduler) errors.push(...validateScheduler(c.scheduler, c.type === 'tank' ? (c.weekly?.length ?? 0) : (c.days?.length ?? 0)));
  return errors;
}

/** Scheduler decisions: 2-3 options, each costs or pays now and/or lands later inside the session. */
export function validateScheduler(list, steps) {
  const errors = [];
  const ids = new Set();
  for (const x of list) {
    if (!x.id || ids.has(x.id)) errors.push(`scheduler: missing or duplicate id "${x.id}"`);
    ids.add(x.id);
    if (!(x.day >= 0 && x.day < steps)) errors.push(`scheduler ${x.id}: day out of range`);
    if (!x.title || !x.prompt) errors.push(`scheduler ${x.id}: needs a title and a prompt`);
    if (!(x.options?.length >= 2 && x.options.length <= 3)) errors.push(`scheduler ${x.id}: needs 2-3 options`);
    for (const o of x.options ?? []) {
      if (!o.label || o.label.length > 48) errors.push(`scheduler ${x.id}: option label must be 1-48 characters`);
      if (!o.now && !o.later) errors.push(`scheduler ${x.id}: option "${o.label}" has no consequence`);
      if (o.now && !Number.isFinite(o.now.usd)) errors.push(`scheduler ${x.id}: now.usd must be a number`);
      if (o.later && (!Number.isFinite(o.later.usd) || !(o.later.day > x.day && o.later.day < steps + 1) || !o.later.text)) {
        errors.push(`scheduler ${x.id}: later needs usd, text and a day after the decision`);
      }
    }
  }
  return errors;
}

const IDEA_TYPES = ['location_arb', 'storage', 'basis', 'quality', 'freight'];
const BOTS = ['mo', 'carla', 'quinn', 'dan'];

/** DESK scenarios: real/modeled series with sources, 8-12 feed cards, priced ideas. */
export function validateDesk(c) {
  const errors = [];
  const D = c.days?.length ?? 0;
  if (D < 8 || D > 14) errors.push(`desk needs 8-14 trading days, has ${D}`);
  if (c.open && c.open.length > OPEN_MAX) errors.push(`open is over ${OPEN_MAX} characters`);
  const series = c.series ?? {};
  for (const [k, s] of Object.entries(series)) {
    if (s.values?.length !== D || s.values.some((v) => !Number.isFinite(v))) errors.push(`series ${k}: needs ${D} numbers`);
    if (!['real', 'modeled'].includes(s.kind)) errors.push(`series ${k}: kind must be real or modeled`);
    if (!s.source) errors.push(`series ${k}: missing source`);
    if (s.kind === 'modeled' && !(s.anchors?.length >= 2 && s.anchors.every((a) => a.source))) errors.push(`series ${k}: modeled series need 2+ cited anchors`);
  }
  for (const k of [...(c.chart ?? []), ...Object.keys(c.pitchable ?? {})]) if (!series[k]) errors.push(`unknown series "${k}"`);
  const steps = c.steps ?? [];
  if (steps.length < 8 || steps.length > 12) errors.push(`desk needs 8-12 cards, has ${steps.length}`);
  for (const k of ['idea', 'decision', 'news']) if (!steps.some((s) => s.kind === k)) errors.push(`desk needs at least one ${k} card`);
  steps.forEach((s, i) => {
    if (!(s.day >= 0 && s.day < D)) errors.push(`card ${i}: day out of range`);
    if (i && s.day < steps[i - 1].day) errors.push(`card ${i}: cards must be in day order`);
    if (s.kind === 'news' && (!s.headline || s.headline.length > 60)) errors.push(`card ${i}: headline must be 1-60 characters`);
    if (s.kind === 'pitch' && !BOTS.includes(s.by)) errors.push(`card ${i}: pitch needs a bot (${BOTS.join(', ')})`);
    if (s.kind === 'decision') errors.push(...validateScheduler([{ ...s, id: `card${i}` }], D).map((e) => `card ${i}: ${e}`));
    if (s.kind === 'idea') {
      if (!IDEA_TYPES.includes(s.type)) errors.push(`card ${i}: idea type must be one of ${IDEA_TYPES.join(', ')}`);
      if (!(s.bbl > 0) || !(s.horizon >= 1) || s.day + s.horizon > D - 1 + 1) errors.push(`card ${i}: needs bbl and a horizon inside the scenario`);
      if (!(s.legs?.length >= 2) || s.legs.some((l) => !series[l.series] || !['buy', 'sell'].includes(l.side) || !['entry', 'exit'].includes(l.at))) errors.push(`card ${i}: legs need a known series, buy/sell and entry/exit`);
      if (!s.costs?.length) errors.push(`card ${i}: an idea must price its costs`);
      if (!(s.killers?.length >= 2)) errors.push(`card ${i}: needs at least two "what kills this trade" lines`);
      if (!s.pitch || s.pitch.length > 140) errors.push(`card ${i}: pitch must be 1-140 characters`);
    }
  });
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
