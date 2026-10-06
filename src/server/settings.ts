// App settings (non-secret) persisted in SQLite. Secrets (API keys) are read from environment
// variables only and are never stored here or sent to the browser.
import type { AppSettings } from '../shared/types.ts';
import type { Db } from './db.ts';

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'manual',
  displayTimeZone: 'auto',
  hourlyEnabled: true,
  hourlyMinuteOffset: 0,
  briefingEnabled: true,
  briefingTimeEt: '07:00',
  staleToleranceMinutes: 30,
  manualDefaultDelayMinutes: 10,
  fillPolicy: 'next_mark_after_submit',
  dailyTradeLimit: 1,
  commissionPerContractPerSide: null,
  slippageTicksPerLeg: null,
  maxDrawdownPct: 15,
  marginMaxAgeDays: 30,
  expiryGuardEnabled: true,
  expiryGuardTimeEt: '12:00',
  eiaPollEnabled: true,
  eiaOverrides: [],
  fillPollMinutes: 5,
  customHttp: {
    urlTemplate: '',
    symbolTemplate: '{root}{month}{yy}',
    pricePath: 'last',
    timestampPath: 'timestamp',
    timestampFormat: 'iso',
    symbolPath: 'symbol',
    delayMinutes: 10,
    authHeader: '',
    sourceLabel: 'Custom HTTP quote API',
  },
  databentoDataset: 'GLBX.MDP3',
  databentoDelayMinutes: 15,
  tradingViewWidgets: true,
  fxPairs: ['EURUSD', 'USDJPY', 'USDCNY', 'USDINR', 'USDCAD', 'USDNOK', 'GBPUSD'],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function loadSettings(db: Db): AppSettings {
  const row = db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'app'");
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const stored = JSON.parse(row.value) as Partial<AppSettings>;
  return { ...structuredClone(DEFAULT_SETTINGS), ...stored, customHttp: { ...DEFAULT_SETTINGS.customHttp, ...(stored.customHttp ?? {}) } };
}

function isValidTimeZone(tz: string): boolean {
  if (tz === 'auto') return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateSettings(s: AppSettings): string[] {
  const errors: string[] = [];
  if (!['manual', 'databento', 'custom-http'].includes(s.provider)) errors.push('Unknown market-data provider.');
  if (!isValidTimeZone(s.displayTimeZone)) errors.push(`Unknown time zone "${s.displayTimeZone}".`);
  if (!Number.isInteger(s.hourlyMinuteOffset) || s.hourlyMinuteOffset < 0 || s.hourlyMinuteOffset > 59) errors.push('Hourly minute offset must be 0–59.');
  if (!HHMM.test(s.briefingTimeEt)) errors.push('Briefing time must be HH:MM (ET).');
  if (!HHMM.test(s.expiryGuardTimeEt)) errors.push('Expiry guard time must be HH:MM (ET).');
  if (!(s.staleToleranceMinutes >= 1 && s.staleToleranceMinutes <= 24 * 60)) errors.push('Stale tolerance must be between 1 and 1440 minutes.');
  if (!(s.manualDefaultDelayMinutes >= 0 && s.manualDefaultDelayMinutes <= 24 * 60)) errors.push('Manual default delay must be between 0 and 1440 minutes.');
  if (!['next_mark_after_submit', 'current_valid_mark'].includes(s.fillPolicy)) errors.push('Unknown fill policy.');
  if (!Number.isInteger(s.dailyTradeLimit) || s.dailyTradeLimit < 0) errors.push('Daily trade limit must be a whole number (0 = unlimited).');
  if (s.commissionPerContractPerSide !== null && !(s.commissionPerContractPerSide >= 0)) errors.push('Commission must be ≥ 0 or blank.');
  if (s.slippageTicksPerLeg !== null && !(Number.isInteger(s.slippageTicksPerLeg) && s.slippageTicksPerLeg >= 0)) errors.push('Slippage must be a whole number of ticks ≥ 0 or blank.');
  if (!(s.maxDrawdownPct > 0 && s.maxDrawdownPct < 100)) errors.push('Max drawdown must be between 0 and 100%.');
  if (!(Number.isInteger(s.marginMaxAgeDays) && s.marginMaxAgeDays >= 1)) errors.push('Margin max age must be ≥ 1 day.');
  if (!(Number.isInteger(s.fillPollMinutes) && s.fillPollMinutes >= 1 && s.fillPollMinutes <= 60)) errors.push('Fill poll interval must be 1–60 minutes.');
  for (const o of s.eiaOverrides) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) errors.push(`EIA override date "${o.date}" must be YYYY-MM-DD.`);
    if (o.releaseDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.releaseDate)) errors.push(`EIA override release date "${o.releaseDate}" must be YYYY-MM-DD.`);
    if (!HHMM.test(o.timeEt)) errors.push(`EIA override time "${o.timeEt}" must be HH:MM.`);
  }
  const ch = s.customHttp;
  if (s.provider === 'custom-http') {
    if (!/^https:\/\//.test(ch.urlTemplate) && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(ch.urlTemplate)) {
      errors.push('Custom HTTP URL template must use https:// (http:// is allowed only for localhost).');
    }
    if (!ch.urlTemplate.includes('{symbol}')) errors.push('Custom HTTP URL template must contain {symbol}.');
    if (!ch.pricePath || !ch.timestampPath) errors.push('Custom HTTP price and timestamp paths are required.');
  }
  if (!(s.databentoDelayMinutes >= 0 && s.databentoDelayMinutes <= 24 * 60)) errors.push('Databento declared delay must be 0–1440 minutes.');
  if (!['iso', 'epoch_ms', 'epoch_s'].includes(ch.timestampFormat)) errors.push('Unknown timestamp format.');
  return errors;
}

export function saveSettings(db: Db, next: AppSettings, nowIso: string): void {
  db.run(
    "INSERT INTO settings (key, value, updated_at) VALUES ('app', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    JSON.stringify(next),
    nowIso,
  );
}

export function diffSettings(a: AppSettings, b: AppSettings): string[] {
  const changes: string[] = [];
  for (const k of Object.keys(b) as (keyof AppSettings)[]) {
    const av = JSON.stringify(a[k]);
    const bv = JSON.stringify(b[k]);
    if (av !== bv) changes.push(`${k}: ${av} → ${bv}`);
  }
  return changes;
}

export interface Env {
  databentoKey: string | null;
  customQuoteKey: string | null;
  eiaKey: string | null;
  fxBase: string;
  basicAuth: string | null;
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const v = (k: string) => (env[k] && env[k]!.trim() ? env[k]!.trim() : null);
  return {
    databentoKey: v('DATABENTO_API_KEY'),
    customQuoteKey: v('CUSTOM_QUOTE_API_KEY'),
    eiaKey: v('EIA_API_KEY'),
    fxBase: v('FX_API_BASE') ?? 'https://api.frankfurter.dev/v1',
    basicAuth: v('APP_BASIC_AUTH'),
  };
}
