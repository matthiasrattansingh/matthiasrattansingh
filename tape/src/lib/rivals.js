// The desk: four simulated rival traders with fixed styles. They trade every
// CALL IT and SPREAD SNAP card alongside you, so each card is a head-to-head.
// They're bots (labelled as such in the UI), with no hidden knowledge beyond
// Quinn's stated ~60% hit rate.
import { seeded } from './format.js';

export const BOTS = [
  { id: 'mo', name: 'Momentum Mo', emoji: '🏄', style: 'Rides the trend: buys what went up last week, sells what went down. Always 2 lots.' },
  { id: 'carla', name: 'Contrarian Carla', emoji: '🦊', style: 'Fades every move. Sells rallies, buys dips. Always 2 lots.' },
  { id: 'quinn', name: 'Quant Quinn', emoji: '🤖', style: 'A model that calls ~60% of cards right. Sizes 1, 2 or 5 lots by confidence.' },
  { id: 'dan', name: 'Degen Dan', emoji: '🎰', style: 'Flips a coin, then goes max size. 5 lots, every time.' },
];

function trendUp(card) {
  const s = card.type === 'spread' ? card.spread.series : card.series;
  const last = s[s.length - 1];
  const ref = s[Math.max(0, s.length - 6)];
  return last >= ref;
}

const LONG_OF = { spread: 'WIDEN', callit: 'LONG' };
const SHORT_OF = { spread: 'NARROW', callit: 'SHORT' };

/** A bot's call on a card. Deterministic for the same card + salt. */
export function botCall(bot, card, best, salt = '') {
  const rand = seeded(`${bot.id}|${card.id}|${salt}`);
  const up = LONG_OF[card.type];
  const down = SHORT_OF[card.type];
  const options = card.type === 'spread' ? [up, down] : [up, down, 'FLAT'];
  switch (bot.id) {
    case 'mo':
      return { call: trendUp(card) ? up : down, lots: 2 };
    case 'carla':
      return { call: trendUp(card) ? down : up, lots: 2 };
    case 'quinn': {
      const right = rand() < 0.6;
      const call = right ? best : options.filter((o) => o !== best)[Math.floor(rand() * (options.length - 1))];
      const r = rand();
      return { call, lots: r < 0.4 ? 1 : r < 0.85 ? 2 : 5 };
    }
    default:
      return { call: rand() < 0.5 ? up : down, lots: 5 };
  }
}

export const botById = Object.fromEntries(BOTS.map((b) => [b.id, b]));
