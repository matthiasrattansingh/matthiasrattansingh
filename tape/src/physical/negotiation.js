// NEGOTIATION: selling a cargo (or buying spot barrels) is a haggle, not a price.
// Pure functions, seeded and deterministic, so sequences can be tested exactly.
//
// Each counterparty has hidden state: reservation (their walk-away differential to the
// index, $/bbl; can be positive), patience (rounds), desperation (0-1, set by scenario
// events, visible only through their chat tells), bluff (gap between opening and
// reservation) and a preferred pricing term (NOW = today's settle, AVG5 = 5-day average).
// Every counter or stall burns half a day of the voyage clock.
import { seeded } from '../lib/format.js';

export const TERMS = ['NOW', 'AVG5'];
export const TERM_CONCESSION = 0.1; // $/bbl a counterparty values getting its preferred term
const r05 = (v) => Math.round(v * 20) / 20;

/**
 * Open a negotiation.
 * opts: { side: 'sell'|'buy', fair (fair differential to the index, $/bbl), roster (agents),
 *         seed, desperation (0-1 from events), count (1-3), relationships, econ,
 *         distressDays (days your demurrage meter has been red), theirClock (seller distress) }
 */
export function openNegotiation(opts) {
  const { side = 'sell', fair, roster, seed = '', desperation = 0.3, relationships = {}, econ, distressDays = 0 } = opts;
  const rand = seeded(`nego|${seed}`);
  const count = opts.count ?? 1 + Math.floor(rand() * 3);
  const pool = [...roster];
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  const shading = (econ?.negotiation?.distress_shading_usd_bbl_day?.value ?? 0.05) * distressDays;
  const parties = pool.slice(0, Math.max(1, Math.min(3, count))).map((a) => {
    const desp = Math.max(0, Math.min(1, desperation + (rand() - 0.5) * 0.3));
    // Sell side: they're buyers, reservation is the most they'll pay. Buy side: sellers, the least they'll take.
    const dir = side === 'sell' ? 1 : -1;
    const reservation = r05(fair + dir * (desp * 1.2 - 0.2 + (rand() - 0.5) * 0.4));
    const bluff = r05(0.3 + rand() * 0.8 + (1 - desp) * 0.3);
    const rel = relationAdjust(relationships[a.id], econ);
    // Buyers shade their opening down (sellers up) once your demurrage meter is red.
    const opening = r05(reservation - dir * bluff + dir * rel - dir * shading);
    return {
      id: a.id, name: a.name, emoji: a.emoji, color: a.color,
      reservation, bid: opening, first: opening, bluff, desperation: desp,
      patience: 2 + Math.floor(rand() * 4) + (desp > 0.6 ? 0 : 1), // 2-6 rounds; desperate ones are shorter
      term: rand() < 0.5 ? 'NOW' : 'AVG5', prefers: rand() < 0.5 ? 'NOW' : 'AVG5',
      status: 'live', rounds: 0, stalled: 0, final: false, rel,
    };
  });
  return { side, parties, round: 0, halfDays: 0, log: [], deal: null, opening: opts.indexNow ?? 0, theirClock: opts.theirClock ?? null };
}

/** Relationship history moves opening bids by $0.03-0.08 either way. */
export function relationAdjust(rel, econ) {
  if (!rel) return 0;
  const [lo, hi] = econ?.negotiation?.relationship_adjust_usd_bbl?.value ?? [0.03, 0.08];
  const good = rel.deals ?? 0;
  const bad = (rel.stalled ?? 0) / 3 + (rel.walkaways ?? 0) * 2;
  const net = good - bad;
  if (net === 0) return 0;
  return Math.sign(net) * Math.min(hi, lo + Math.abs(net) * 0.01);
}

export const liveParties = (n) => n.parties.filter((p) => p.status === 'live');

/** Competing-bid leverage: 2+ live bids make counters land more often. */
export const leverage = (n) => liveParties(n).length >= 2;

function tick(n, who, kind) {
  // Time passes for everyone still at the table.
  const parties = n.parties.map((p) => {
    if (p.status !== 'live') return p;
    const patience = p.patience - 1;
    const q = { ...p, patience, rounds: p.rounds + (p.id === who ? 1 : 0), stalled: p.stalled + (kind === 'stall' ? 1 : 0) };
    if (patience <= 0 && !p.final) return { ...q, status: 'pulled' };
    return q;
  });
  return { ...n, parties, round: n.round + 1, halfDays: n.halfDays + 1 };
}

/**
 * One round. action: { type: 'ACCEPT'|'COUNTER'|'STALL'|'WALK', party, ask?, flipTerm? }
 * Returns { n, outcome } where outcome is 'deal' | 'final' | 'improved' | 'pulled' | 'checking' | 'walked' | 'stalled'.
 * rand() decides "check with the desk" acceptances (seeded per negotiation round).
 */
export function respond(n, action, seed = '') {
  const party = n.parties.find((p) => p.id === action.party);
  if (action.type === 'ACCEPT') {
    if (!party || party.status !== 'live') return { n, outcome: 'none' };
    return { n: { ...n, deal: { party: party.id, diff: party.bid, term: party.term, first: party.first, reservation: party.reservation } }, outcome: 'deal' };
  }
  if (action.type === 'WALK') {
    if (!party) return { n, outcome: 'none' };
    const parties = n.parties.map((p) => (p.id === party.id ? { ...p, status: 'walked' } : p));
    return { n: { ...n, parties, log: [...n.log, { who: party.id, text: 'walked' }] }, outcome: 'walked' };
  }
  if (action.type === 'STALL') {
    const out = tick(n, null, 'stall');
    // Desperate counterparties sweeten a little while they wait.
    out.parties = out.parties.map((p) => (p.status === 'live' && p.desperation > 0.6 && !p.final
      ? { ...p, bid: r05(p.bid + (n.side === 'sell' ? 0.05 : -0.05)) } : p));
    const pulled = out.parties.some((p, i) => p.status === 'pulled' && n.parties[i].status === 'live');
    return { n: out, outcome: pulled ? 'pulled' : 'stalled' };
  }
  // COUNTER
  if (!party || party.status !== 'live') return { n, outcome: 'none' };
  const dir = n.side === 'sell' ? 1 : -1;
  const nextTerm = action.flipTerm ? (party.term === 'NOW' ? 'AVG5' : 'NOW') : party.term;
  const concession = action.flipTerm && nextTerm === party.prefers ? TERM_CONCESSION : 0;
  const effRes = party.reservation + dir * concession; // flipping to their preferred term is a concession
  let out = tick(n, party.id, 'counter');
  const me = out.parties.find((p) => p.id === party.id);
  const rand = seeded(`resp|${seed}|${n.round}|${party.id}`);
  const lev = leverage(n) ? 0.12 : 0;
  // An ask at or inside their reservation goes to "the desk"; above it, they meet you partway.
  if (dir * (effRes - action.ask) >= -1e-9) {
    const accept = rand() < 0.8 + lev;
    const updated = accept
      ? { ...me, bid: action.ask, term: nextTerm, status: 'live' }
      : { ...me, bid: r05(effRes), term: nextTerm, final: true, status: 'live' };
    out = { ...out, parties: out.parties.map((p) => (p.id === party.id ? updated : p)) };
    if (accept) out = { ...out, deal: { party: party.id, diff: action.ask, term: nextTerm, first: party.first, reservation: party.reservation } };
    return { n: out, outcome: accept ? 'deal' : 'final', checking: true };
  }
  if (me.status === 'pulled') return { n: out, outcome: 'pulled' };
  // Meet partway: concede half the gap to their reservation (more with leverage).
  const step = (party.reservation - party.bid) * (0.5 + lev);
  const bid = r05(party.bid + step);
  const last = Math.abs(party.reservation - bid) < 0.051;
  out = { ...out, parties: out.parties.map((p) => (p.id === party.id ? { ...me, bid, term: nextTerm, final: last } : p)) };
  return { n: out, outcome: last ? 'final' : 'improved' };
}

/** A counterparty's chat tell: desperation and patience leak through what they say. */
export function tell(p, side = 'sell', history = null, name = '') {
  const who = name ? `, ${name}` : '';
  if (p.status === 'pulled') return side === 'sell' ? 'We’re out. Found barrels elsewhere.' : 'Sold it to someone else. Too slow.';
  if (p.status === 'walked') return 'Your loss.';
  if (history?.stalled >= 4) return `Last time you stalled me ${history.stalled} rounds${who}. Not again.`;
  if (history?.walkaways >= 1) return `You walked on me last time${who}. Prove you're serious.`;
  if (history?.deals >= 2) return `Good to trade with you again${who}.`;
  if (p.final) return 'That’s my final number.';
  if (p.patience <= 1) return 'I need an answer now.';
  if (p.desperation > 0.65) return side === 'sell' ? 'We need barrels this week. Can you do it?' : 'I have a cargo arriving and no tank. Help me out.';
  if (p.desperation < 0.3) return side === 'sell' ? 'No rush on our side.' : 'I can sit on these.';
  return 'Let’s find a number.';
}

/**
 * Negotiation edge: agreed value minus the value of accepting that party's first bid.
 * For a sale, value = (index + differential) * bbl - extra costs burned while haggling.
 */
export function edgeOf({ side = 'sell', bbl, indexAtOpen, indexAtDeal, diff, first, extraCosts = 0 }) {
  const dir = side === 'sell' ? 1 : -1;
  return Math.round(dir * ((indexAtDeal + diff) - (indexAtOpen + first)) * bbl - extraCosts);
}

/** NEGOTIATION grade: edge captured vs the theoretical max (their reservation), less days burned. */
export function negotiationGrade({ side = 'sell', diff, first, reservation, halfDays, pulled = 0 }) {
  const dir = side === 'sell' ? 1 : -1;
  const room = Math.max(0.05, dir * (reservation - first));
  const captured = (dir * (diff - first)) / room;
  const burned = halfDays * 0.04 + pulled * 0.1;
  const score = captured - burned;
  return { grade: score >= 0.8 ? 'S' : score >= 0.55 ? 'A' : score >= 0.3 ? 'B' : score > 0 ? 'C' : 'D', captured, score };
}
