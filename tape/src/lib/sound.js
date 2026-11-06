// Optional trading-floor sounds, synthesized with WebAudio (no audio files).
// Off by default; toggled in the ME tab.
const KEY = 'tape.sound';
let ctx = null;

export function soundOn() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setSoundOn(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
  if (on) unlock();
}

/** Browsers only allow audio after a tap; call this from any tap handler. */
export function unlock() {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}

function tone(freq, ms, { type = 'sine', gain = 0.08, slide = 0 } = {}) {
  if (!soundOn() || !ctx) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(freq * slide, t + ms / 1000);
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

/** Soft tick on every candle close. */
export const tick = () => tone(1400, 45, { gain: 0.05 });
/** Low thud when a candle costs you more than $2,000. */
export const thud = () => tone(110, 260, { type: 'triangle', gain: 0.22, slide: 0.5 });
/** Short chime for breaking news. */
export const ping = () => tone(880, 120, { gain: 0.06, slide: 1.5 });
