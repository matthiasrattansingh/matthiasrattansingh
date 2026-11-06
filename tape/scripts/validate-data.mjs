// Checks every seed card: `npm run validate`. Run it after editing the JSON.
import { readFileSync } from 'node:fs';
import { validateCard } from '../src/lib/validate.js';

const files = { 'callit.json': 'cards', 'concepts.json': 'cards', 'spreads.json': 'cards', 'tapecheck.json': 'instruments', 'cargo.json': 'cards' };
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
console.log(Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join('  '));
console.log(bad ? `${bad} problem(s) need fixing` : 'All cards valid ✓');
process.exit(bad ? 1 : 0);
