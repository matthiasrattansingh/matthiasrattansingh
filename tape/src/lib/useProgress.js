import { useCallback, useEffect, useRef, useState } from 'react';
import { loadJSON, saveJSON, clearJSON } from './storage.js';
import { emptyProgress, hydrate, recordResult, recordView, recordBell } from './progress.js';

// React hook around the pure progress model. Session P&L lives in memory;
// everything else persists to localStorage (same key; old saves are migrated by hydrate).
export default function useProgress() {
  const [progress, setProgress] = useState(() => hydrate(loadJSON()));
  const [session, setSession] = useState({ pnl: 0, answered: 0, right: 0 });
  const ref = useRef(progress);
  ref.current = progress;

  useEffect(() => saveJSON(progress), [progress]);

  const record = useCallback((result) => {
    setProgress((p) => recordResult(p, result));
    setSession((s) => ({
      pnl: s.pnl + (result.trade?.pnl ?? 0),
      answered: s.answered + 1,
      right: s.right + (result.correct ? 1 : 0),
    }));
  }, []);

  /**
   * Apply a pure step to the latest progress synchronously and return its events:
   * fn(progress) -> { progress, events }. Consecutive calls compose.
   */
  const apply = useCallback((fn) => {
    const out = fn(ref.current);
    ref.current = out.progress;
    setProgress(out.progress);
    return out.events ?? [];
  }, []);

  /** Record a result through `apply` (so it composes with other pure steps). */
  const recordNow = useCallback((result) => {
    apply((p) => ({ progress: recordResult(p, result) }));
    setSession((s) => ({
      pnl: s.pnl + (result.trade?.account === 'eval' ? 0 : result.trade?.pnl ?? 0),
      answered: s.answered + 1,
      right: s.right + (result.correct ? 1 : 0),
    }));
  }, [apply]);

  useEffect(() => {
    setProgress((p) => (session.pnl > p.bestSession ? { ...p, bestSession: session.pnl } : p));
  }, [session.pnl]);

  const view = useCallback((cardId, xp) => setProgress((p) => recordView(p, cardId, xp)), []);
  const saveBell = useCallback((date, key, saved) => setProgress((p) => recordBell(p, date, key, saved)), []);
  const clearMarginCall = useCallback(() => setProgress((p) => ({ ...p, marginCall: false })), []);

  const reset = useCallback(() => {
    clearJSON();
    const fresh = emptyProgress();
    ref.current = fresh;
    setProgress(fresh);
    setSession({ pnl: 0, answered: 0, right: 0 });
  }, []);

  return { progress, session, record: recordNow, apply, view, saveBell, clearMarginCall, reset, ref };
}
