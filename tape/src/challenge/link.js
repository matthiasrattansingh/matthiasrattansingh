// CHALLENGE LINKS: one URL carries everything needed to replay your exact run on static
// hosting: the scenario, the seed (live ticks, fills, bots, hard-mode tape), the mode, and
// your final score. No accounts, no server.
//
//   https://…/matthiasrattansingh/?c=<payload>
//   payload = base64url(JSON) + '.' + checksum
//
// The checksum only catches truncated/garbled links. A score in a link is self-reported:
// anyone can edit a URL. A future leaderboard (see leaderboard.js) should re-verify runs.

export const CHALLENGE_VERSION = 1;

const b64url = {
  enc: (str) => {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach((b) => { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec: (s) => {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b + '==='.slice((b.length + 3) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

/** FNV-1a 32-bit, base36: a short integrity check. */
export function checksum(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

/** A fresh seed for a run (8 base36 chars). */
export const newSeed = (rand = Math.random) => Array.from({ length: 8 }, () => Math.floor(rand() * 36).toString(36)).join('');

/**
 * The run as data. Short keys keep the URL (and the QR code) small.
 * run: { id (scenario/card id), kind, seed, hard, name, pnl, win, bots: [{id,pnl}], title }
 */
export function toPayload(run) {
  return {
    v: CHALLENGE_VERSION,
    i: run.id, k: run.kind, s: run.seed, h: run.hard ? 1 : 0,
    n: (run.name || 'A trader').slice(0, 24), p: Math.round(run.pnl), w: run.win ? 1 : 0,
    b: (run.bots ?? []).map((b) => [b.id, Math.round(b.pnl)]),
    ...(run.fade ? { x: run.fade } : {}), // cargo: the port rivals pre-positioned at, so the tape matches
  };
}

export function fromPayload(o) {
  return {
    v: o.v, id: o.i, kind: o.k, seed: o.s, hard: o.h === 1, name: o.n, pnl: o.p, win: o.w === 1,
    bots: (o.b ?? []).map(([id, pnl]) => ({ id, pnl })),
    fade: o.x ?? null,
  };
}

export function encodeChallenge(run) {
  const json = JSON.stringify(toPayload(run));
  const body = b64url.enc(json);
  return `${body}.${checksum(json)}`;
}

/** Returns the run, or null if the code is malformed, garbled or from an unknown version. */
export function decodeChallenge(code) {
  try {
    const [body, sum] = String(code).split('.');
    if (!body || !sum) return null;
    const json = b64url.dec(body);
    if (checksum(json) !== sum) return null;
    const o = JSON.parse(json);
    if (o.v !== CHALLENGE_VERSION || typeof o.i !== 'string' || typeof o.s !== 'string' || !Number.isFinite(o.p)) return null;
    return fromPayload(o);
  } catch {
    return null;
  }
}

/** The shareable URL for a run (base = where the app is hosted). */
export function challengeUrl(run, base = `${location.origin}${location.pathname}`) {
  return `${base.replace(/\?.*$/, '')}?c=${encodeChallenge(run)}`;
}

/** Read a challenge from a URL's query string. */
export function challengeFromSearch(search = location.search) {
  const c = new URLSearchParams(search).get('c');
  return c ? decodeChallenge(c) : null;
}

/** Stable id for "this exact scenario" (what a leaderboard groups scores by). */
export const challengeKey = (run) => `${run.id}:${run.seed}:${run.hard ? 'h' : 'n'}`;

/** Head to head on the end screen. */
export function compare(mine, theirs) {
  const diff = Math.round(mine - theirs);
  return { diff, outcome: diff > 0 ? 'win' : diff < 0 ? 'lose' : 'tie' };
}
