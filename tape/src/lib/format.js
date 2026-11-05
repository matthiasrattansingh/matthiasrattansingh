const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function decimalsFor(unit) {
  return unit === '$/gal' ? 4 : unit === '$/MMBtu' ? 3 : 2;
}

export function fmtPrice(v, unit) {
  const s = Math.abs(v).toFixed(decimalsFor(unit));
  return `${v < 0 ? '−' : ''}$${s}`;
}

export function fmtSigned(v, digits = 2) {
  const s = Math.abs(v).toFixed(digits);
  return `${v > 0 ? '+' : v < 0 ? '−' : '±'}${s}`;
}

export function fmtPct(p) {
  return `${fmtSigned(p, 1)}%`;
}

export function toneFor(v) {
  return v > 0 ? 'text-up' : v < 0 ? 'text-down' : 'text-dim';
}

/** Stable pseudo-random from a string: shuffles choices the same way per feed slot. */
export function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
