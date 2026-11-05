// Checks every seed card: `npm run validate`. Run it after editing the JSON.
import { readFileSync } from 'node:fs';
import { validateCard } from '../src/lib/validate.js';

const files = { 'callit.json': 'cards', 'concepts.json': 'cards', 'spreads.json': 'cards', 'tapecheck.json': 'instruments' };
let bad = 0;
const ids = new Set();
const counts = {};
for (const [file, key] of Object.entries(files)) {
  const cards = JSON.parse(readFileSync(new URL(`../src/data/${file}`, import.meta.url)))[key];
  for (const c of cards) {
    const errors = validateCard(c);
    if (ids.has(c.id)) errors.push('duplicate id');
    ids.add(c.id);
    counts[c.type] = (counts[c.type] ?? 0) + 1;
    if (errors.length) { bad++; console.log(`✗ ${file} ${c.id ?? '(no id)'}: ${errors.join('; ')}`); }
  }
}
console.log(Object.entries(counts).map(([t, n]) => `${t}: ${n}`).join('  '));
console.log(bad ? `${bad} card(s) need fixing` : 'All cards valid ✓');
process.exit(bad ? 1 : 0);
