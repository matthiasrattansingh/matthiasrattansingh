import { useEffect, useState } from 'react';
import { fetchQuotes } from './yahoo.js';

// Fetches live quotes once on load. status: 'loading' | 'live' | 'fallback'.
export default function useLiveQuotes(symbols) {
  const [state, setState] = useState({ quotes: {}, status: 'loading' });
  const key = symbols.join(',');

  useEffect(() => {
    let alive = true;
    fetchQuotes(key.split(','))
      .then((quotes) => {
        if (!alive) return;
        const any = Object.values(quotes).some(Boolean);
        setState({ quotes, status: any ? 'live' : 'fallback' });
      })
      .catch(() => alive && setState({ quotes: {}, status: 'fallback' }));
    return () => { alive = false; };
  }, [key]);

  return state;
}
