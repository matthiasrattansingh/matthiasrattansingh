import { useCallback, useEffect, useState } from 'react';
import { loadJSON, saveJSON, clearJSON } from './storage.js';
import { emptyProgress, hydrate, recordResult, recordView, recordBell } from './progress.js';

// React hook around the pure progress model. Session P&L lives in memory;
// everything else persists to localStorage.
export default function useProgress() {
  const [progress, setProgress] = useState(() => hydrate(loadJSON()));
  const [session, setSession] = useState({ pnl: 0, answered: 0, right: 0 });

  useEffect(() => saveJSON(progress), [progress]);

  const record = useCallback((result) => {
    setProgress((p) => recordResult(p, result));
    setSession((s) => ({
      pnl: s.pnl + (result.trade?.pnl ?? 0),
      answered: s.answered + 1,
      right: s.right + (result.correct ? 1 : 0),
    }));
  }, []);

  useEffect(() => {
    setProgress((p) => (session.pnl > p.bestSession ? { ...p, bestSession: session.pnl } : p));
  }, [session.pnl]);

  const view = useCallback((cardId, xp) => setProgress((p) => recordView(p, cardId, xp)), []);
  const saveBell = useCallback((date, key, saved) => setProgress((p) => recordBell(p, date, key, saved)), []);
  const clearMarginCall = useCallback(() => setProgress((p) => ({ ...p, marginCall: false })), []);

  const reset = useCallback(() => {
    clearJSON();
    setProgress(emptyProgress());
    setSession({ pnl: 0, answered: 0, right: 0 });
  }, []);

  return { progress, session, record, view, saveBell, clearMarginCall, reset };
}
