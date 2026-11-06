// Canvas chart for TRADE mode, animated at display refresh rate (60fps).
// It owns the animation clock: call play(i) to draw candle i over `ms`; it
// reports the live price every frame (onTick) and when the candle is done.
import { seeded } from '../lib/format.js';

const COLORS = {
  up: '#22e584', down: '#ff4d5e', amber: '#ffb000', grid: 'rgba(255,255,255,0.07)',
  label: 'rgba(255,255,255,0.45)', hist: 'rgba(255,255,255,0.35)', zero: 'rgba(255,255,255,0.35)',
};
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

/** The price path inside one candle: open -> first extreme -> second extreme -> close. */
function microPath(c, seed) {
  const rand = seeded(seed);
  const [e1, e2] = c.c >= c.o ? [c.l, c.h] : [c.h, c.l];
  const t1 = 0.2 + rand() * 0.25;
  const t2 = 0.55 + rand() * 0.25;
  const knots = [[0, c.o], [t1, e1], [t2, e2], [1, c.c]];
  const wobble = (c.h - c.l) * 0.05;
  return (u) => {
    let k = 0;
    while (k < knots.length - 2 && u > knots[k + 1][0]) k++;
    const [ta, va] = knots[k];
    const [tb, vb] = knots[k + 1];
    const f = tb === ta ? 1 : (u - ta) / (tb - ta);
    const base = va + (vb - va) * ease(Math.min(1, Math.max(0, f)));
    const w = Math.sin(u * 37 + t1 * 11) * Math.sin(u * 13) * wobble * Math.sin(Math.PI * f);
    return Math.min(c.h, Math.max(c.l, base + w));
  };
}

export class TradeChart {
  constructor(canvas, session, { decimals = 2 } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.s = session;
    this.decimals = decimals;
    this.drawn = 0; // fully drawn candles
    this.anim = null; // { i, start, ms, path, hi, lo }
    this.entry = null; // { price, label, side }
    this.intro = { start: performance.now(), ms: 700 };
    this.range = null;
    this.markers = [];
    this.onTick = null;
    this.onDone = null;
    this.price = session.p0;
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
  }

  setEntry(entry) {
    this.entry = entry;
  }

  play(i, ms = 2000) {
    const c = this.s.candles[i];
    this.anim = { i, start: performance.now(), ms, path: microPath(c, `${this.s.id}|${i}`), hi: c.o, lo: c.o, cur: c.o };
  }

  /** Jump straight to `n` drawn candles (used when re-opening a finished session). */
  setDrawn(n) {
    this.drawn = n;
    this.anim = null;
    this.price = n ? this.s.candles[n - 1].c : this.s.p0;
  }

  frame = (now) => {
    this.raf = requestAnimationFrame(this.frame);
    const { cv } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const a = this.anim;
    let u = 0;
    if (a) {
      u = Math.min(1, (now - a.start) / a.ms);
      a.cur = a.path(u);
      a.hi = Math.max(a.hi, a.cur);
      a.lo = Math.min(a.lo, a.cur);
      this.price = a.cur;
      this.onTick?.(a.cur, a.i + u);
      if (u >= 1) {
        this.anim = null;
        this.drawn = a.i + 1;
        this.price = this.s.candles[a.i].c;
        this.onDone?.(a.i);
      }
    }
    this.draw(w, h, dpr, now, a, u);
  };

  draw(w, h, dpr, now, a) {
    const { ctx, s } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const introK = Math.min(1, (now - this.intro.start) / this.intro.ms);
    const hist = s.history;
    const histN = Math.max(2, Math.ceil(hist.length * ease(introK)));
    const shownHist = hist.slice(0, histN);
    const done = s.candles.slice(0, this.drawn);

    // Y range follows what's visible (never what's coming), eased so it doesn't jump.
    const vals = [...shownHist, ...done.flatMap((c) => [c.h, c.l])];
    if (a) vals.push(a.hi, a.lo);
    if (this.entry) vals.push(this.entry.price);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.12, Math.abs(hi) * 0.004, 0.0001);
    lo -= pad; hi += pad;
    if (!this.range) this.range = { lo, hi };
    this.range.lo += (lo - this.range.lo) * 0.12;
    this.range.hi += (hi - this.range.hi) * 0.12;
    const R = this.range;
    const axisW = 46;
    const plotW = w - axisW;
    const y = (v) => 8 + (1 - (v - R.lo) / (R.hi - R.lo)) * (h - 16);

    // Grid + price labels.
    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = 'middle';
    const step = niceStep((R.hi - R.lo) / 4);
    for (let v = Math.ceil(R.lo / step) * step; v <= R.hi; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = Math.abs(v) < step / 1000 ? COLORS.zero : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillStyle = COLORS.label;
      ctx.fillText(fmt(v, this.decimals), plotW + 5, yy);
    }

    // Layout: history line on the left quarter, candle slots on the right.
    const histW = plotW * 0.24;
    const slotW = (plotW - histW) / s.C;
    const xh = (i) => (i / (hist.length - 1)) * histW;
    ctx.strokeStyle = COLORS.hist;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    shownHist.forEach((v, i) => (i ? ctx.lineTo(xh(i), y(v)) : ctx.moveTo(xh(i), y(v))));
    ctx.stroke();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = 'rgba(255,176,0,0.35)';
    ctx.beginPath(); ctx.moveTo(histW + 0.5, 0); ctx.lineTo(histW + 0.5, h); ctx.stroke();
    ctx.setLineDash([]);

    const body = Math.max(2, slotW * 0.62);
    const drawCandle = (i, o, hiV, loV, c) => {
      const cx = histW + slotW * (i + 0.5);
      const col = c >= o ? COLORS.up : COLORS.down;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(cx, y(hiV)); ctx.lineTo(cx, y(loV)); ctx.stroke();
      const top = y(Math.max(o, c));
      ctx.fillRect(cx - body / 2, top, body, Math.max(1.5, y(Math.min(o, c)) - top));
    };
    done.forEach((c, i) => drawCandle(i, c.o, c.h, c.l, c.c));
    if (a) drawCandle(a.i, s.candles[a.i].o, a.hi, a.lo, a.cur);

    // Best/worst markers (debrief).
    for (const m of this.markers) {
      const cx = histW + slotW * (m.i + 0.5);
      ctx.fillStyle = m.good ? COLORS.up : COLORS.down;
      ctx.beginPath(); ctx.arc(cx, y(m.price), 5, 0, Math.PI * 2); ctx.fill();
    }

    // Entry line.
    if (this.entry) {
      const ey = Math.round(y(this.entry.price)) + 0.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = COLORS.amber; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(0, ey); ctx.lineTo(plotW, ey); ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = `bold 10px ${MONO}`;
      ctx.fillStyle = COLORS.amber;
      ctx.textBaseline = ey < 16 ? 'top' : 'bottom';
      ctx.fillText(this.entry.label, 4, ey + (ey < 16 ? 3 : -3));
    }

    // Live price tag.
    const py = Math.round(y(this.price)) + 0.5;
    const last = a ? a.cur : this.price;
    const ref = a ? s.candles[a.i].o : (this.drawn ? s.candles[this.drawn - 1].o : hist[hist.length - 2]);
    const tagCol = last >= ref ? COLORS.up : COLORS.down;
    ctx.strokeStyle = tagCol; ctx.globalAlpha = 0.5; ctx.setLineDash([1, 3]);
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(plotW, py); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.fillStyle = tagCol;
    ctx.fillRect(plotW, py - 8, axisW, 16);
    ctx.fillStyle = '#000';
    ctx.font = `bold 10px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(fmt(this.price, this.decimals), plotW + 4, py);
  }
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
}

function fmt(v, d) {
  const s = Math.abs(v).toFixed(d);
  return v < 0 ? `−${s}` : s;
}
