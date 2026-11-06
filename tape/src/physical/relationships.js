// Relationship memory per counterparty (persisted in the physical ledger), and the
// NEGOTIATION EDGE career stat.
export const emptyRel = () => ({ deals_closed: 0, rounds_stalled_on_them: 0, walk_aways_after_3plus_rounds: 0 });

/**
 * Record a finished negotiation (deal or not).
 * outcome: { parties: [{ id, rounds, stalled, status }], deal?: { party }, edge?: number }
 */
export function recordNegotiation(p, outcome) {
  const rel = { ...(p.phys.relationships ?? {}) };
  for (const x of outcome.parties) {
    const r = { ...emptyRel(), ...rel[x.id] };
    r.rounds_stalled_on_them += x.stalled ?? 0;
    if (outcome.deal?.party === x.id) r.deals_closed += 1;
    if (x.status === 'walked' && (x.rounds ?? 0) + (x.stalled ?? 0) >= 3) r.walk_aways_after_3plus_rounds += 1;
    rel[x.id] = r;
  }
  const pulled = outcome.parties.filter((x) => x.status === 'pulled').length;
  const nego = { ...p.phys.negotiation };
  nego.pulled += pulled;
  if (outcome.deal) { nego.deals += 1; nego.edge += Math.round(outcome.edge ?? 0); }
  return { ...p, phys: { ...p.phys, relationships: rel, negotiation: nego } };
}
