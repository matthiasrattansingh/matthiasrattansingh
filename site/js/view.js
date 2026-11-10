// LAYER 1, THE VIEW (see BEST_TRADE_SPEC.md). A running fundamental bias built only from
// real headlines that have already printed. Pure and incremental: feed it events and bar
// closes in time order and it never sees anything later.
export const VIEW = { neutralBand: 1, holdBars: 3 };
export const PRINT_TYPES = ['EIA', 'EIA-NG', 'API', 'MACRO'];

/** Bias of a headline for an instrument's legs. Red herrings never move the view. */
export function biasOf(item, legs = []) {
  if (item.class !== 'real') return 0;
  const bp = item.bias_by_product;
  if (bp) for (const p of legs) if (p in bp) return bp[p];
  return item.bias ?? 0;
}

export const viewLabel = (dir) => (dir > 0 ? 'LONG' : dir < 0 ? 'SHORT' : 'NEUTRAL');

export class View {
  constructor({ legs = [], band = VIEW.neutralBand, holdBars = VIEW.holdBars } = {}) {
    this.legs = legs; this.band = band; this.holdBars = holdBars;
    this.events = [];    // accepted: { clock, time, type, headline, bias, weight, px, bar, prior, overruled, viaHierarchy }
    this.pending = [];   // scheduled prints held back by the thesis hierarchy
  }

  get sum() { return this.events.reduce((s, e) => s + (e.overruled ? 0 : e.bias * e.weight), 0); }
  get dir() { const s = this.sum; return s > this.band ? 1 : s < -this.band ? -1 : 0; }
  get label() { return viewLabel(this.dir); }

  /** Is the current view carried by a weight-3 regime driver? */
  regimeSet() { const d = this.dir; return d !== 0 && this.events.some((e) => !e.overruled && e.weight === 3 && e.bias === d); }

  /** Last accepted event on the side of the current view. */
  lastSupport() { const d = this.dir; return d === 0 ? null : [...this.events].reverse().find((e) => !e.overruled && e.bias === d) || null; }

  /**
   * Add a printed headline. px = last traded price when it printed, bar = bar index.
   * Returns { status: 'ignored' | 'added' | 'pending', event }.
   */
  add(entry, px, bar) {
    const h = entry.item;
    const bias = biasOf(h, this.legs);
    if (bias === 0) return { status: 'ignored' };
    const ev = { clock: entry.clock, time: h.time, type: h.type, headline: h.headline, bias, weight: h.weight ?? 1, px, bar,
      prior: Boolean(entry.prior), overruled: false, viaHierarchy: false };
    const scheduledPrint = !entry.prior && h.time_precision === 'exact' && PRINT_TYPES.includes(h.type);
    // THESIS HIERARCHY: one scheduled print cannot flip a view set by a weight-3 driver
    if (scheduledPrint && ev.weight < 3 && bias === -this.dir && this.regimeSet()) {
      this.pending.push({ ...ev, count: 0 });
      return { status: 'pending', event: ev };
    }
    this.events.push(ev);
    return { status: 'added', event: ev };
  }

  /**
   * Feed one new bar close. A held-back print is accepted only when price holds beyond the
   * pre-print level for `holdBars` consecutive closes: the market overruled the hierarchy.
   * Returns the prints accepted on this bar.
   */
  onBar(close, bar) {
    const flipped = [];
    for (const p of [...this.pending]) {
      p.count = (close - p.px) * p.bias > 0 ? p.count + 1 : 0;
      if (p.count >= this.holdBars) {
        for (const e of this.events) if (e.weight === 3 && e.bias === -p.bias) e.overruled = true;
        const { count, ...ev } = p;
        this.events.push({ ...ev, viaHierarchy: true, acceptedBar: bar });
        this.pending.splice(this.pending.indexOf(p), 1);
        flipped.push(ev);
      }
    }
    return flipped;
  }

  snapshot() {
    return { dir: this.dir, sum: this.sum, label: this.label,
      events: this.events.map((e) => ({ ...e })), pending: this.pending.map((p) => ({ ...p })) };
  }
}
