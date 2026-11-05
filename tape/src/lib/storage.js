// Thin, crash-proof localStorage wrapper. Private windows or blocked storage
// just mean progress lives in memory for the session.
const KEY = 'tape.progress.v1';

export function loadJSON(key = KEY, fallback = null) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(value, key = KEY) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: keep going in memory */
  }
}

export function clearJSON(key = KEY) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
