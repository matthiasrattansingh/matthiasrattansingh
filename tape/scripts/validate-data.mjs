// Checks every seed card: `npm run validate`. Run it after editing the JSON.
import { readFileSync } from 'node:fs';
import { validateCard } from '../src/lib/validate.js';

const files = { 'callit.json': 'cards', 'concepts.json': 'cards', 'spreads.json': 'cards', 'tapecheck.json': 'instruments', 'cargo.json': 'cards', 'tank.json': 'cards' };
const load = (file) => JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url)))[files[file]];
let bad = 0;
const ids = new Set();
const counts = {};
const fail = (file, id, msg) => { bad++; console.log(`✗ ${file} ${id ?? '(no id)'}: ${msg}`); };
const conceptIds = new Set(load('concepts.json').map((c) => c.id));
let spreadSessions = 0;

for (const file of Object.keys(files)) {
  for (const c of load(file)) {
    const errors = validateCard(c);
    if (ids.has(c.id)) errors.push('duplicate id');
    ids.add(c.id);
    counts[c.type] = (counts[c.type] ?? 0) + 1;
    // TRADE mode: every CALL IT is a session; spreads may be.
    if (c.type === 'callit' && !c.session) errors.push('missing "session" (run scripts/build-sessions.py)');
    if (c.concept && !conceptIds.has(c.concept)) errors.push(`concept "${c.concept}" is not a concept id`);
    if (c.session) {
      counts.sessions = (counts.sessions ?? 0) + 1;
      if (c.type === 'spread') spreadSessions++;
      if (c.session.concept && !conceptIds.has(c.session.concept)) errors.push(`session.concept "${c.session.concept}" is not a concept id`);
    }
    if (errors.length) fail(file, c.id, errors.join('; '));
  }
}
if (spreadSessions < 4) fail('spreads.json', '-', `need at least 4 spread sessions, found ${spreadSessions}`);

// FORECAST library (scripts/build-forecast.py): real EIA weeks, every record sourced.
{
  const { classOf, baseRates, classesFor, actualOf } = await import('../src/forecast/engine.js');
  const fc = JSON.parse(readFileSync(new URL('../src/data/forecast.json', import.meta.url)));
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  for (const kind of ['petroleum', 'gas']) {
    const recs = fc[kind];
    const classes = classesFor(fc, kind);
    if (recs.length < 150) fail('forecast.json', kind, `need at least 150 weeks, found ${recs.length}`);
    let prev = '';
    const seen = new Set();
    for (const r of recs) {
      const e = [];
      if (seen.has(r.id)) e.push('duplicate id');
      seen.add(r.id);
      if (!(r.week_ending > prev)) e.push('weeks out of order');
      prev = r.week_ending;
      if (!r.source || !r.source.includes(r.week_ending)) e.push('missing per-record source');
      if (!(r.release_date > r.week_ending)) e.push('release must follow the week end');
      const px = kind === 'gas' ? r.ng : r.wti;
      if (!px || ![px.settle, px.chg, px.next_chg, px.run5_pct].every(num)) e.push('release-day price fields missing');
      if (px && px.date < r.release_date) e.push('price day before release');
      if (!num(actualOf(kind, r))) e.push('missing print');
      if (r.class !== classOf(actualOf(kind, r), classes)) e.push(`class ${r.class} does not match the print`);
      if (kind === 'petroleum') {
        for (const k of ['gasoline', 'distillate', 'util', 'util_chg', 'prod', 'imports', 'exports', 'imports_avg8', 'exports_avg8', 'spr_chg', 'adjustment']) if (!num(r[k])) e.push(`${k} missing`);
        if ((r.api != null || r.consensus != null) && !r.api_source) e.push('API/consensus without a citation');
      } else {
        for (const k of ['level', 'avg5_change', 'avg5_level', 'prev_change']) if (!num(r[k])) e.push(`${k} missing`);
      }
      for (const t of r.regime) if (!t.tag || !t.source) e.push('regime tag without a source');
      if (e.length) fail('forecast.json', r.id, e.join('; '));
    }
    // Stored base rates must be the real ones computed from the records.
    const real = baseRates(recs, kind, classes);
    const stored = fc.base_rates[kind === 'gas' ? 'gas' : 'crude'];
    for (const n of Object.keys(real)) if (Math.abs(real[n] - stored[n]) > 1e-3) fail('forecast.json', kind, `stored base rate ${n} ${stored[n]} ≠ computed ${real[n].toFixed(4)}`);
    counts[`forecast ${kind}`] = recs.length;
  }
}
console.log(Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join('  '));
console.log(bad ? `${bad} problem(s) need fixing` : 'All cards valid ✓');
process.exit(bad ? 1 : 0);
