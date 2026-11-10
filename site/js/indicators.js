// Indicators. Every function takes ONLY the bars it is allowed to see (the revealed
// bars) and returns one value per input bar. Nothing here can reach other data.

/** Session VWAP on typical price (h+l+c)/3, volume weighted. Falls back to equal weights if volume is 0. */
export function vwap(bars) {
  const out = [];
  let pv = 0, vol = 0, sumTp = 0;
  bars.forEach((b, i) => {
    const tp = (b.h + b.l + b.c) / 3;
    pv += tp * (b.v || 0);
    vol += b.v || 0;
    sumTp += tp;
    out.push(vol > 0 ? pv / vol : sumTp / (i + 1));
  });
  return out;
}

/** Exponential moving average of closes, seeded with the first close. */
export function ema(bars, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (const b of bars) {
    prev = prev === undefined ? b.c : b.c * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}
