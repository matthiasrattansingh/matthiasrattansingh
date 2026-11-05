import { useCallback, useEffect, useState } from 'react';
import { loadJSON, saveJSON, clearJSON } from './storage.js';
import { emptyProgress, hydrate, recordResult, recordView } from './progress.js';

// React hook around the pure progress model. Session score lives in memory;
// everything else persists to localStorage.
export default function useProgress() {
  const [progress, setProgress] = useState(() => hydrate(loadJSON()));
  const [session, setSession] = useState({ score: 0, answered: 0, right: 0 });

  useEffect(() => saveJSON(progress), [progress]);

  const record = useCallback((result) => {
    setProgress((p) => recordResult(p, result));
    setSession((s) => ({
      score: s.score + result.points,
      answered: s.answered + 1,
      right: s.right + (result.correct ? 1 : 0),
    }));
  }, []);

  useEffect(() => {
    setProgress((p) => (session.score > p.bestSession ? { ...p, bestSession: session.score } : p));
  }, [session.score]);

  const view = useCallback((cardId, xp) => setProgress((p) => recordView(p, cardId, xp)), []);

  const reset = useCallback(() => {
    clearJSON();
    setProgress(emptyProgress());
    setSession({ score: 0, answered: 0, right: 0 });
  }, []);

  return { progress, session, record, view, reset };
}
