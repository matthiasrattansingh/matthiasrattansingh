// Physical IDEA cards in the main TRADE feed. A RUN IT position stays open across swipes:
// every new feed item moves its scenario clock one day; at its horizon it settles to the
// desk ledger (never the $100k paper account). PASS reveals what it would have done.
import { ideaPnl, settle } from './econ.js';
import { buildDesk } from './scenario.js';

/** One feed item in four is a physical idea card. */
export const IDEA_EVERY = 4;
export const isIdeaSlot = (n) => n % IDEA_EVERY === IDEA_EVERY - 1;

const scen = (scenarios, id) => buildDesk(scenarios.find((s) => s.id === id));
export const ideaOf = (scenarios, card) => {
  const sc = scen(scenarios, card.scenarioId);
  return { sc, step: sc.steps[card.stepIdx], idea: sc.steps[card.stepIdx] };
};

/** Next idea card: unseen first, then the longest since seen; never one that's open. */
export function pickIdea(p, ideaCards, salt = 0) {
  const ideas = p.phys.ideas;
  const open = new Set(ideas.open.map((o) => o.cardId));
  const pool = ideaCards.filter((c) => !open.has(c.id));
  if (!pool.length) return null;
  const unseen = pool.filter((c) => !ideas.seen[c.id]);
  const list = unseen.length ? unseen : [...pool].sort((a, b) => ideas.seen[a.id] - ideas.seen[b.id]);
  return list[unseen.length ? salt % list.length : 0];
}

const withIdeas = (p, ideas, phys = {}) => ({ ...p, phys: { ...p.phys, ...phys, ideas: { ...p.phys.ideas, ...ideas } } });

export function runIdea(p, card, scenarios, now = Date.now()) {
  const { step } = ideaOf(scenarios, card);
  const pos = { cardId: card.id, scenarioId: card.scenarioId, stepIdx: card.stepIdx, entry: step.day, day: step.day, title: step.title };
  const ideas = p.phys.ideas;
  return withIdeas(p, { open: [...ideas.open, pos], run: ideas.run + 1, seen: { ...ideas.seen, [card.id]: now } });
}

/** PASS: the outcome is revealed right away (it's history), and the call is scored. */
export function passIdea(p, card, scenarios, now = Date.now()) {
  const { sc, step } = ideaOf(scenarios, card);
  const out = settle(sc, step, step.day);
  const ideas = p.phys.ideas;
  const right = out.pnl <= 0;
  return {
    progress: withIdeas(p, { passed: ideas.passed + 1, calls: ideas.calls + 1, right: ideas.right + (right ? 1 : 0), seen: { ...ideas.seen, [card.id]: now } }),
    outcome: { ...out, right },
  };
}

/** Live marks for the open positions (the strip that stays on screen across swipes). */
export function ideaMarks(p, scenarios) {
  return p.phys.ideas.open.map((o) => {
    const sc = scen(scenarios, o.scenarioId);
    const step = sc.steps[o.stepIdx];
    const end = Math.min(o.entry + step.horizon, sc.D - 1);
    return { ...o, mtm: ideaPnl(sc, step, o.entry, o.day), left: Math.max(0, end - o.day) };
  });
}

/**
 * A swipe: every open position's clock moves one scenario day. Positions at their horizon
 * settle to the desk ledger. Returns { progress, events }.
 */
export function tickIdeas(p, scenarios) {
  const ideas = p.phys.ideas;
  if (!ideas.open.length) return { progress: p, events: [] };
  const open = [];
  const events = [];
  let { pnl, calls, right } = ideas;
  let deskPnl = p.phys.pnl;
  for (const o of ideas.open) {
    const sc = scen(scenarios, o.scenarioId);
    const step = sc.steps[o.stepIdx];
    const end = Math.min(o.entry + step.horizon, sc.D - 1);
    const day = Math.min(o.day + 1, end);
    if (day >= end) {
      const out = settle(sc, step, o.entry).pnl;
      pnl += out; deskPnl += out; calls += 1; right += out > 0 ? 1 : 0;
      events.push({ type: 'phys', text: `📦 ${o.title}: closed ${out >= 0 ? '+' : '−'}$${Math.abs(Math.round(out)).toLocaleString()} to the desk book` });
    } else {
      open.push({ ...o, day });
    }
  }
  return { progress: withIdeas(p, { open, pnl: Math.round(pnl), calls, right }, { pnl: Math.round(deskPnl) }), events };
}
