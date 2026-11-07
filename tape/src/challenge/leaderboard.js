// LEADERBOARD: score submission behind a small adapter, so a backend (e.g. Supabase) can be
// added later without touching challenge links or the end screen. This pass ships only the
// local adapter (scores played on this device); no network calls.
//
// Entry shape (what any backend should store), keyed by challengeKey(run):
//   { key, id, kind, seed, hard, name, pnl, win, checks, at, v }
//
// To add Supabase later:
//   1. create table scores (key text, id text, kind text, seed text, hard bool, name text,
//      pnl int, win bool, checks jsonb, at timestamptz default now(), v int)
//      with an index on (key, pnl desc) and an insert-only RLS policy for anon;
//   2. write { submit(entry), top(key, n) } using @supabase/supabase-js against that table;
//   3. setAdapter(supabaseAdapter) at startup. Nothing else changes.
// Scores in links are self-reported; a backend should re-simulate the run from
// (id, seed, hard, decisions) before trusting a pnl.
import { challengeKey, CHALLENGE_VERSION } from './link.js';

const KEY = 'tape.scores.v1';

export const localAdapter = {
  name: 'local',
  async submit(entry) {
    const all = readLocal();
    all.push(entry);
    try { localStorage.setItem(KEY, JSON.stringify(all.slice(-500))); } catch { /* storage full or blocked */ }
    return { ok: true, stored: 'local' };
  },
  async top(key, n = 10) {
    return readLocal().filter((e) => e.key === key).sort((a, b) => b.pnl - a.pnl).slice(0, n);
  },
};

function readLocal() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}

let adapter = localAdapter;
export const setAdapter = (a) => { adapter = a; };
export const currentAdapter = () => adapter;

/** Normalize a finished run into a leaderboard entry. */
export function toEntry(run, now = Date.now()) {
  return {
    key: challengeKey(run), id: run.id, kind: run.kind, seed: run.seed, hard: Boolean(run.hard),
    name: run.name || 'A trader', pnl: Math.round(run.pnl), win: Boolean(run.win),
    checks: run.checks ?? null, at: now, v: CHALLENGE_VERSION,
  };
}

export const submitScore = (run) => adapter.submit(toEntry(run));
export const topScores = (run, n) => adapter.top(challengeKey(run), n);
