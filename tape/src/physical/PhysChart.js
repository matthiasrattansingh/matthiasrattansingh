// Canvas chart for physical sessions: two or more lines over day-steps (e.g. the
// benchmark flat price and your cargo's delivered price), drawn only up to the
// current step and animated when a new step arrives. 60fps.
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

export class PhysChart {
  constructor(canvas, { steps, labelOf, decimals = 2 }) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.steps = steps;
    this.labelOf = labelOf;
    this.decimals = decimals;
    this.series = []; // [{ name, color, values: [] (only known steps), dash }]
    this.shown = 0; // fractional number of steps drawn (animates toward target)
    this.target = 0;
    this.markers = []; // [{ step, color }]
    this.range = null;
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() { cancelAnimationFrame(this.raf); }

  set(series, target, markers = []) {
    this.series = series;
    this.target = target;
    this.markers = markers;
  }

  frame = () => {
    this.raf = requestAnimationFrame(this.frame);
    const { cv, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    this.shown += (this.target - this.shown) * 0.12;
    if (Math.abs(this.target - this.shown) < 0.002) this.shown = this.target;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = Math.floor(this.shown) + 1;
    const frac = this.shown - Math.floor(this.shown);
    const vis = this.series.map((s) => s.values.slice(0, Math.min(s.values.length, n + 1)));
    const vals = vis.flat().filter(Number.isFinite);
    if (!vals.length) return;
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 0.01, 0.05);
    lo -= pad; hi += pad;
    if (!this.range) this.range = { lo, hi };
    this.range.lo += (lo - this.range.lo) * 0.15;
    this.range.hi += (hi - this.range.hi) * 0.15;
    const R = this.range;
    const axisW = 44;
    const plotW = w - axisW;
    const x = (i) => 6 + (i / Math.max(1, this.steps - 1)) * (plotW - 12);
    const y = (v) => 10 + (1 - (v - R.lo) / (R.hi - R.lo)) * (h - 30);

    // grid + labels
    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = 'middle';
    const step = nice((R.hi - R.lo) / 4);
    for (let v = Math.ceil(R.lo / step) * step; v <= R.hi; v += step) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.moveTo(0, Math.round(y(v)) + 0.5); ctx.lineTo(plotW, Math.round(y(v)) + 0.5); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText(v.toFixed(this.decimals), plotW + 4, y(v));
    }
    // day ticks
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < this.steps; i += Math.ceil(this.steps / 5)) ctx.fillText(this.labelOf(i), x(i) - 8, h - 2);
    // markers (events)
    for (const m of this.markers) {
      if (m.step > this.shown) continue;
      ctx.strokeStyle = m.color; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x(m.step), 4); ctx.lineTo(x(m.step), h - 16); ctx.stroke();
      ctx.setLineDash([]);
    }
    // lines (the last segment grows smoothly)
    for (let k = 0; k < this.series.length; k++) {
      const s = this.series[k];
      const v = vis[k];
      if (!v.length) continue;
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width ?? 2; ctx.setLineDash(s.dash ?? []);
      ctx.beginPath();
      let lastX = x(0);
      let lastY = y(v[0]);
      ctx.moveTo(lastX, lastY);
      for (let i = 1; i < v.length; i++) {
        const t = i < n ? 1 : frac;
        if (t <= 0) break;
        lastX = x(i - 1) + (x(i) - x(i - 1)) * t;
        lastY = y(v[i - 1]) + (y(v[i]) - y(v[i - 1])) * t;
        ctx.lineTo(lastX, lastY);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(lastX, lastY, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = `bold 9px ${MONO}`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(s.name, Math.min(lastX + 4, plotW - 60), lastY - 3);
    }
  };
}

function nice(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const r = raw / p;
  return (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * p;
}
