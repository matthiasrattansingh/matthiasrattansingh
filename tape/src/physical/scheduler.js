// SCHEDULER decisions inside cargo and tank sessions: physical trading is logistics.
// A decision books its immediate cost now; its consequence lands on a later day (or week),
// in dollars, in the log and the P&L, without a lecture.
//
// Card data:  scheduler: [{ id, day, title, prompt, options: [{ label, now?: { usd, text },
//             later?: { day, usd, text, calc } }] }]
// State keys: sched (landed [{ day, usd, text }]), pending (not yet landed), decided ({ id: option }).

export const schedState = () => ({ sched: [], pending: [], decided: {} });

/** The decision due now that hasn't been made (one at a time). */
export function dueDecision(card, st, now) {
  return (card.scheduler ?? []).find((x) => x.day <= now && st.decided?.[x.id] == null) ?? null;
}

const usdText = (u) => `${u >= 0 ? '+' : '−'}$${Math.abs(Math.round(u)).toLocaleString()}`;

export function decideSched(st, decision, optIdx, now) {
  const o = decision.options[optIdx];
  const out = { ...st, decided: { ...(st.decided ?? {}), [decision.id]: optIdx }, sched: [...(st.sched ?? [])], pending: [...(st.pending ?? [])], log: [...st.log] };
  out.log.push({ day: now, text: `${decision.title}: ${o.label}`, type: 'decision' });
  if (o.now && o.now.usd) {
    out.sched.push({ day: now, usd: o.now.usd, text: o.now.text });
    out.log.push({ day: now, text: `${o.now.text} ${usdText(o.now.usd)}`, type: 'sched' });
  }
  if (o.later) out.pending.push({ ...o.later, day: Math.max(now + 1, o.later.day) });
  return out;
}

/** Land every consequence due by `now`. */
export function landSched(st, now) {
  const due = (st.pending ?? []).filter((x) => x.day <= now);
  if (!due.length) return st;
  return {
    ...st,
    pending: st.pending.filter((x) => x.day > now),
    sched: [...st.sched, ...due],
    log: [...st.log, ...due.map((x) => ({ day: x.day, text: `${x.text} ${usdText(x.usd)}`, type: 'sched' }))],
  };
}

/** Landed scheduler dollars; `all` also counts what's still pending (it lands at settlement). */
export const schedUsd = (st, all = false) =>
  (st.sched ?? []).reduce((s, x) => s + x.usd, 0) + (all ? (st.pending ?? []).reduce((s, x) => s + x.usd, 0) : 0);

/** Best hindsight value of the scheduler choices on a card. */
export const bestSched = (card) => (card.scheduler ?? []).reduce((s, x) => s + Math.max(...x.options.map((o) => (o.now?.usd ?? 0) + (o.later?.usd ?? 0))), 0);
