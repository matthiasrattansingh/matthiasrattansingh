// Canvas candlestick chart. It is handed ONLY revealed bars and indicator values
// computed from them. The x axis is the fixed session clock (07:00-14:30), and the
// y range is fitted to revealed prices only, so the chart leaks nothing about the future.
import { SESSION } from './config.js';
import { addMinutes } from './session.js';

export function sessionSlots() {
  const out = [];
  for (let t = SESSION.open; t < SESSION.close; t = addMinutes(t, SESSION.barMinutes)) out.push(t);
  return out;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function drawChart(canvas, d) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const C = { line: css('--line'), muted: css('--muted'), up: css('--up'), down: css('--down'),
    vwap: css('--vwap'), e9: css('--e9'), e21: css('--e21'), text: css('--text'), accent: css('--accent'), warn: css('--warn') };
  const padL = 6, padR = 64, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slots = sessionSlots();
  const slotIdx = new Map(slots.map((t, i) => [t, i]));
  const n = slots.length;
  const xw = plotW / n;
  const xOf = (i) => padL + i * xw + xw / 2;

  if (!d || !d.bars.length) return;
  // y range: revealed bars + indicators + user's own order/entry levels
  let lo = Infinity, hi = -Infinity;
  for (const b of d.bars) { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); }
  for (const arr of [d.vwap, d.e9, d.e21]) for (const v of arr) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const v of [d.quote.bid, d.quote.ask, ...d.levels.map((l) => l.price)]) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.max(hi - lo, d.tick * 10);
  lo -= span * 0.08; hi += span * 0.08;
  const yOf = (p) => padT + (hi - p) / (hi - lo) * plotH;

  // grid + price labels
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.textBaseline = 'middle';
  const steps = 6;
  for (let i = 0; i <= steps; i++) {
    const p = lo + (hi - lo) * i / steps;
    const y = yOf(p);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = C.muted;
    ctx.fillText(p.toFixed(d.decimals), padL + plotW + 6, y);
  }
  // hour lines
  ctx.textBaseline = 'alphabetic';
  slots.forEach((t, i) => {
    if (!t.endsWith(':00')) return;
    const x = padL + i * xw;
    ctx.strokeStyle = C.line; ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = C.muted; ctx.fillText(t, x + 2, H - 6);
  });
  // event markers (headlines already printed)
  for (const m of d.markers) {
    const i = slotIdx.get(m.slot);
    if (i == null) continue;
    const x = padL + i * xw;
    ctx.strokeStyle = C.warn; ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
  }

  // candles
  const bodyW = Math.max(1, xw * 0.65);
  d.bars.forEach((b) => {
    const i = slotIdx.get(b.time);
    if (i == null) return;
    const x = xOf(i);
    const col = b.c >= b.o ? C.up : C.down;
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yOf(b.h)); ctx.lineTo(x, yOf(b.l)); ctx.stroke();
    const y1 = yOf(Math.max(b.o, b.c)), y2 = yOf(Math.min(b.o, b.c));
    ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
  });

  const line = (vals, color) => {
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
    vals.forEach((v, k) => {
      const i = slotIdx.get(d.bars[k].time);
      const x = xOf(i), y = yOf(v);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  line(d.vwap, C.vwap); line(d.e9, C.e9); line(d.e21, C.e21);

  // levels: bid / ask / orders / entry
  const level = (price, color, label, dash = [4, 3]) => {
    const y = yOf(price);
    ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.fillRect(padL + plotW + 1, y - 8, padR - 2, 16);
    ctx.fillStyle = '#0b0f14'; ctx.textBaseline = 'middle';
    ctx.fillText(price.toFixed(d.decimals), padL + plotW + 4, y);
    if (label) { ctx.fillStyle = color; ctx.textAlign = 'right'; ctx.fillText(label, padL + plotW - 4, y - 8); ctx.textAlign = 'left'; }
  };
  for (const l of d.levels) level(l.price, l.side === 'BUY' ? C.up : l.side === 'SELL' ? C.down : C.accent, l.label, [6, 4]);
  level(d.quote.ask, C.down, '', [2, 2]);
  level(d.quote.bid, C.up, '', [2, 2]);

  // hover crosshair (revealed bars only)
  if (d.hover != null && d.bars[d.hover]) {
    const i = slotIdx.get(d.bars[d.hover].time);
    ctx.strokeStyle = C.muted; ctx.globalAlpha = 0.6;
    ctx.beginPath(); ctx.moveTo(xOf(i), padT); ctx.lineTo(xOf(i), padT + plotH); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  return { slotFromX: (x) => Math.floor((x - padL) / xw), slots };
}
