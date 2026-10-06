// Display helpers. Timestamps show in the user's chosen zone (default: the browser's zone);
// exchange and EIA times are always also available explicitly in ET.

export const ET = 'America/New_York';

export function resolveZone(setting: string | undefined): string {
  if (!setting || setting === 'auto') return Intl.DateTimeFormat().resolvedOptions().timeZone;
  return setting;
}

function fmt(iso: string | number | null | undefined, zone: string, opts: Intl.DateTimeFormatOptions): string {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: zone, ...opts }).format(d);
}

/** e.g. "Tue, Oct 6, 9:42:13 AM CDT" in the display zone. */
export function fmtLocal(iso: string | number | null | undefined, zone: string, withSeconds = false): string {
  return fmt(iso, zone, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, timeZoneName: 'short' });
}

export function fmtLocalTime(iso: string | number | null | undefined, zone: string, withSeconds = false): string {
  return fmt(iso, zone, { hour: 'numeric', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, timeZoneName: 'short' });
}

/** e.g. "Tue, Oct 6, 10:42 AM ET". */
export function fmtEt(iso: string | number | null | undefined, withDate = true): string {
  const s = fmt(iso, ET, withDate ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
  return s === '—' ? s : `${s} ET`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function fmtUsd(n: number | null | undefined, opts: { sign?: boolean; compact?: boolean } = {}): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const body = opts.compact && abs >= 10_000 ? `${(abs / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })}K` : abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = n < 0 ? '−' : opts.sign && n > 0 ? '+' : '';
  return `${sign}$${body}`;
}

export function fmtNum(n: number | null | undefined, decimals: number, sign = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}${s}`;
}

export function priceDecimals(contractOrUnit: string): number {
  return contractOrUnit.startsWith('HO') || contractOrUnit.startsWith('RB') || contractOrUnit === '$/gal' ? 4 : 2;
}

export function fmtPrice(contract: string, price: number | null | undefined): string {
  return fmtNum(price ?? null, priceDecimals(contract));
}

export function fmtAge(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
  if (minutes < 1) return '<1 min';
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${Math.round(minutes / 1440)} d`;
}

export function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || Math.abs(n) < 0.005) return '';
  return n > 0 ? 'pos' : 'neg';
}

export function etNowParts(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
}
