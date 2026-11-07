// SCORE CARD: a 1200×1200 image for a LinkedIn post (square shows full-width in the feed):
// scenario, your P&L, the desk standings, the three win checks, and a QR code of the
// challenge link. Drawn on a canvas; shared as a PNG file or downloaded.
import qrcode from 'qrcode-generator';

export const CARD_SIZE = 1200;

const C = { bg: '#050505', panel: '#111317', line: '#23262d', up: '#22c55e', down: '#ff4d5e', amber: '#ffb000', dim: '#8b9099', white: '#f5f5f5' };
const money = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

/** QR modules for a string (error correction M; version picked to fit). */
export function qrMatrix(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => q.isDark(r, c)));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fit(ctx, text, max) {
  let t = text;
  while (ctx.measureText(t).width > max && t.length > 4) t = `${t.slice(0, -2)}…`;
  return t;
}

/**
 * card: { title, date, kind, name, pnl, standings: [{ name, emoji, pnl, me }], checks: [{label, pass}],
 *         url, hard, versus?: { name, pnl } }
 */
export function drawScoreCard(canvas, card) {
  const S = CARD_SIZE;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');
  const font = (w, px) => `${w} ${px}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, S, S);

  // Header.
  ctx.fillStyle = C.amber;
  ctx.font = font(800, 40);
  ctx.fillText('TAPE', 64, 100);
  ctx.fillStyle = C.dim;
  ctx.font = font(600, 26);
  ctx.fillText(`${card.kind.toUpperCase()} CHALLENGE${card.hard ? ' · HARD' : ''}`, 190, 100);
  ctx.fillStyle = C.white;
  ctx.font = font(800, 54);
  ctx.fillText(fit(ctx, card.title, S - 128), 64, 188);
  ctx.fillStyle = C.dim;
  ctx.font = font(500, 28);
  ctx.fillText(card.date ?? '', 64, 232);

  // Score.
  ctx.font = font(600, 30);
  ctx.fillStyle = C.dim;
  ctx.fillText(card.name && card.name !== 'A trader' ? `${card.name} · P&L` : 'P&L', 64, 320);
  ctx.font = font(800, 140);
  ctx.fillStyle = card.pnl > 0 ? C.up : card.pnl < 0 ? C.down : C.white;
  ctx.fillText(money(card.pnl), 56, 460);
  if (card.versus) {
    ctx.font = font(700, 32);
    const won = card.pnl > card.versus.pnl;
    ctx.fillStyle = won ? C.up : C.down;
    ctx.fillText(`${won ? 'BEAT' : 'LOST TO'} ${card.versus.name} (${money(card.versus.pnl)})`, 64, 512);
  }

  // Standings.
  const top = 560;
  roundRect(ctx, 48, top, 640, 420, 28);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.fillStyle = C.dim;
  ctx.font = font(700, 24);
  ctx.fillText('DESK STANDINGS', 80, top + 52);
  card.standings.slice(0, 5).forEach((r, k) => {
    const y = top + 112 + k * 64;
    ctx.font = font(r.me ? 800 : 600, 34);
    ctx.fillStyle = r.me ? C.amber : C.white;
    ctx.fillText(`${k + 1}. ${fit(ctx, r.name, 330)}`, 80, y);
    ctx.fillStyle = r.pnl >= 0 ? C.up : C.down;
    ctx.textAlign = 'right';
    ctx.fillText(money(r.pnl), 656, y);
    ctx.textAlign = 'left';
  });

  // Win checks.
  (card.checks ?? []).slice(0, 3).forEach((c, k) => {
    const y = 1036 + k * 42;
    ctx.font = font(700, 28);
    ctx.fillStyle = c.pass ? C.up : C.down;
    ctx.fillText(`${c.pass ? '✓' : '✗'} ${fit(ctx, c.label, 600)}`, 64, y);
  });

  // QR code of the challenge link.
  const m = qrMatrix(card.url);
  const box = 400;
  const qx = S - box - 64;
  const qy = top;
  roundRect(ctx, qx - 20, qy - 20, box + 40, box + 40, 24);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  const cell = box / m.length;
  ctx.fillStyle = '#000000';
  m.forEach((row, r) => row.forEach((dark, c) => { if (dark) ctx.fillRect(qx + c * cell, qy + r * cell, Math.ceil(cell), Math.ceil(cell)); }));
  ctx.fillStyle = C.white;
  ctx.font = font(800, 34);
  ctx.textAlign = 'center';
  ctx.fillText('BEAT MY RUN', qx + box / 2, qy + box + 72);
  ctx.fillStyle = C.dim;
  ctx.font = font(500, 22);
  ctx.fillText('same tape · same bots · same seed', qx + box / 2, qy + box + 108);
  ctx.textAlign = 'left';
  return canvas;
}

/** PNG blob of the card. */
export const cardBlob = (canvas) => new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));

/**
 * Share the image + link where the OS supports file sharing (phones), else download the PNG
 * and copy the link. Returns 'shared' | 'downloaded'.
 */
export async function shareCard(canvas, { url, text, filename = 'tape-challenge.png' }) {
  const blob = await cardBlob(canvas);
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: `${text}\n${url}` });
      return 'shared';
    } catch { /* cancelled: fall through to download */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  try { await navigator.clipboard?.writeText(url); } catch { /* clipboard blocked */ }
  return 'downloaded';
}
