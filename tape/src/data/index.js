// Loads every seed card from JSON and drops (with a console warning) any card
// missing required fields, so a typo in your own card never crashes the app.
// To add cards: edit the JSON files in this folder. No code changes needed.
import callit from './callit.json';
import concepts from './concepts.json';
import spreads from './spreads.json';
import tapecheck from './tapecheck.json';
import cargo from './cargo.json';
import tank from './tank.json';
import economics from './economics.json';
import agents from './agents.json';
import { validateCard } from '../lib/validate.js';

function clean(list) {
  const seen = new Set();
  return list.filter((c) => {
    const errors = validateCard(c);
    if (seen.has(c?.id)) errors.push('duplicate id');
    seen.add(c?.id);
    if (errors.length) console.warn(`[TAPE] skipping card ${c?.id ?? '(no id)'}: ${errors.join('; ')}`);
    return errors.length === 0;
  });
}

export const FEED_CARDS = clean([...callit.cards, ...concepts.cards, ...spreads.cards]);
export const TAPE_CARDS = clean(tapecheck.instruments);
export const ALL_CARDS = [...FEED_CARDS, ...TAPE_CARDS];

// TRADE sessions: CALL IT and SPREAD SNAP cards that have candles.
export const PAPER_SESSION_CARDS = FEED_CARDS.filter((c) => c.session?.candles?.length);
export const CARGO_CARDS = clean(cargo.cards);
export const TANK_CARDS = clean(tank.cards);
export const ECON = economics;
// Everything TRADE can play and the Library collects.
export const AGENTS = agents.agents;
// Two-book variants: paper sessions with a physical leg (unlocked after 5 cargoes).
export const INTEGRATED_CARDS = PAPER_SESSION_CARDS.filter((c) => c.session.physical)
  .map((c) => ({ ...c, id: `int-${c.id}`, mode: 'integrated', baseId: c.id }));
export const SESSION_CARDS = [...PAPER_SESSION_CARDS, ...CARGO_CARDS, ...TANK_CARDS, ...INTEGRATED_CARDS];
export const CONCEPT_CARDS = FEED_CARDS.filter((c) => c.type === 'concept');
