// Event-tape rendering for headlines (pure string builder, no DOM, so tests can run it).
//
// NO-LEAK CONTRACT: during a session a headline is rendered from exactly these fields:
// type, date, time, time_precision, headline (+ whether it printed before the open).
// `class`, `implies`, `herring_type`, `autopsy_note`, `source` and `url` are never read
// here, so a red herring is indistinguishable from a real item on screen.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function headlineHtml(entry) {
  const h = entry.item;
  const tag = `<span class="tag tag-${esc(h.type)}">${esc(h.type)}</span>`;
  const when = entry.prior ? `<span class="muted">${esc(h.date.slice(5))} ${esc(h.time)} · since prior close · </span>` : '';
  const approx = h.time_precision === 'approx' ? ' <span class="muted">(time approx.)</span>' : '';
  return `<li class="${entry.prior ? 'prior' : ''}"><span class="t">${esc(entry.clock)}</span><span>${tag}${when}${esc(h.headline)}${approx}</span></li>`;
}
