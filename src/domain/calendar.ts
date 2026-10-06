// Exchange calendar helpers. All exchange logic runs in US Eastern time (America/New_York),
// which is how NYMEX/CME Globex publishes energy trading hours and how EIA publishes the WPSR.
//
// Holiday handling is an approximation of the CME Group holiday calendar (full-day closures
// only; early-halt sessions are treated as closed). The UI labels anything derived from it as
// "computed — verify against the exchange calendar".
import { DateTime } from 'luxon';

export const ET = 'America/New_York';

export type IsoDate = string; // YYYY-MM-DD (calendar date in ET)

export function toEt(instant: Date | string | number): DateTime {
  const dt =
    instant instanceof Date
      ? DateTime.fromJSDate(instant)
      : typeof instant === 'number'
        ? DateTime.fromMillis(instant)
        : DateTime.fromISO(instant, { setZone: true });
  return dt.setZone(ET);
}

export function etDate(instant: Date | string | number): IsoDate {
  return toEt(instant).toISODate() as IsoDate;
}

/** Convert an ET wall-clock time on a given ET date to a UTC ISO instant. */
export function etWallClockToUtc(date: IsoDate, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const dt = DateTime.fromISO(date, { zone: ET }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  return dt.toUTC().toISO() as string;
}

function nthWeekday(year: number, month: number, weekday: number, n: number): DateTime {
  // weekday: 1=Mon..7=Sun (luxon). n>=1
  let d = DateTime.fromObject({ year, month, day: 1 }, { zone: ET });
  while (d.weekday !== weekday) d = d.plus({ days: 1 });
  return d.plus({ weeks: n - 1 });
}

function lastWeekday(year: number, month: number, weekday: number): DateTime {
  let d = DateTime.fromObject({ year, month, day: 1 }, { zone: ET }).endOf('month').startOf('day');
  while (d.weekday !== weekday) d = d.minus({ days: 1 });
  return d;
}

function easterSunday(year: number): DateTime {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher).
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return DateTime.fromObject({ year, month, day }, { zone: ET });
}

function observed(d: DateTime, saturdayToFriday = true): DateTime {
  if (d.weekday === 6) return saturdayToFriday ? d.minus({ days: 1 }) : d;
  if (d.weekday === 7) return d.plus({ days: 1 });
  return d;
}

const holidayCache = new Map<number, Map<IsoDate, string>>();

/** Approximate CME Group full-day holidays for energy (no settlement on these trade dates). */
export function cmeHolidays(year: number): Map<IsoDate, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const list: [DateTime, string][] = [
    [observed(DateTime.fromObject({ year, month: 1, day: 1 }, { zone: ET }), false), "New Year's Day"],
    [nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day'],
    [nthWeekday(year, 2, 1, 3), "Presidents' Day"],
    [easterSunday(year).minus({ days: 2 }), 'Good Friday'],
    [lastWeekday(year, 5, 1), 'Memorial Day'],
    [observed(DateTime.fromObject({ year, month: 6, day: 19 }, { zone: ET })), 'Juneteenth'],
    [observed(DateTime.fromObject({ year, month: 7, day: 4 }, { zone: ET })), 'Independence Day'],
    [nthWeekday(year, 9, 1, 1), 'Labor Day'],
    [nthWeekday(year, 11, 4, 4), 'Thanksgiving'],
    [observed(DateTime.fromObject({ year, month: 12, day: 25 }, { zone: ET })), 'Christmas'],
  ];
  const map = new Map<IsoDate, string>();
  for (const [d, name] of list) map.set(d.toISODate() as IsoDate, name);
  holidayCache.set(year, map);
  return map;
}

export function holidayName(date: IsoDate): string | undefined {
  return cmeHolidays(Number(date.slice(0, 4))).get(date);
}

export function isWeekday(date: IsoDate): boolean {
  const wd = DateTime.fromISO(date, { zone: ET }).weekday;
  return wd >= 1 && wd <= 5;
}

export function isBusinessDay(date: IsoDate): boolean {
  return isWeekday(date) && !holidayName(date);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return DateTime.fromISO(date, { zone: ET }).plus({ days }).toISODate() as IsoDate;
}

/** Last business day of a calendar month. */
export function lastBusinessDayOfMonth(year: number, month: number): IsoDate {
  let d = DateTime.fromObject({ year, month, day: 1 }, { zone: ET }).endOf('month').startOf('day');
  while (!isBusinessDay(d.toISODate() as IsoDate)) d = d.minus({ days: 1 });
  return d.toISODate() as IsoDate;
}

/** The n-th business day strictly before `date`. */
export function businessDaysBefore(date: IsoDate, n: number): IsoDate {
  let d = date;
  let count = 0;
  while (count < n) {
    d = addDays(d, -1);
    if (isBusinessDay(d)) count++;
  }
  return d;
}

/** Number of business days from `from` (exclusive) to `to` (inclusive). 0 if to <= from. */
export function businessDaysBetween(from: IsoDate, to: IsoDate): number {
  if (to <= from) return 0;
  let d = from;
  let count = 0;
  while (d < to) {
    d = addDays(d, 1);
    if (isBusinessDay(d)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// CME Globex energy trading hours: Sunday–Friday 6:00 p.m. – 5:00 p.m. ET with a daily
// 60-minute maintenance break from 5:00 p.m. ET. A session that opens at 18:00 ET belongs
// to the next trade date.
// ---------------------------------------------------------------------------

export const SESSION_OPEN_ET = '18:00';
export const SESSION_CLOSE_ET = '17:00';

/** Trade date the instant belongs to if the market is in session, otherwise null. */
export function sessionTradeDate(instant: Date | string | number): IsoDate | null {
  const et = toEt(instant);
  const minutes = et.hour * 60 + et.minute;
  const wd = et.weekday; // 1=Mon .. 7=Sun
  let tradeDate: DateTime | null = null;
  if (wd === 6) return null; // Saturday
  if (wd === 7) {
    if (minutes >= 18 * 60) tradeDate = et.plus({ days: 1 });
    else return null;
  } else if (minutes >= 17 * 60 && minutes < 18 * 60) {
    return null; // daily maintenance break
  } else if (minutes >= 18 * 60) {
    if (wd === 5) return null; // Friday evening: weekend
    tradeDate = et.plus({ days: 1 });
  } else {
    tradeDate = et;
  }
  const iso = tradeDate.toISODate() as IsoDate;
  if (holidayName(iso)) return null;
  return iso;
}

export function isMarketOpen(instant: Date | string | number): boolean {
  return sessionTradeDate(instant) !== null;
}

/** UTC ISO instant at which the session for `tradeDate` ends (17:00 ET on the trade date). */
export function sessionEndUtc(tradeDate: IsoDate): string {
  return etWallClockToUtc(tradeDate, SESSION_CLOSE_ET);
}

/** UTC ISO instant at which the session for `tradeDate` opens (18:00 ET on the prior calendar day). */
export function sessionStartUtc(tradeDate: IsoDate): string {
  return etWallClockToUtc(addDays(tradeDate, -1), SESSION_OPEN_ET);
}

/** Most recent session (trade date + bounds) whose end is at or before `instant`. */
export function previousSession(instant: Date | string | number): { tradeDate: IsoDate; startUtc: string; endUtc: string } {
  const ms = toEt(instant).toMillis();
  let d = etDate(instant);
  for (let i = 0; i < 15; i++) {
    if (isBusinessDay(d)) {
      const end = sessionEndUtc(d);
      if (Date.parse(end) <= ms) return { tradeDate: d, startUtc: sessionStartUtc(d), endUtc: end };
    }
    d = addDays(d, -1);
  }
  throw new Error('No previous session found within 15 days');
}

/** Next instant (>= from) at which the market opens. */
export function nextSessionOpen(from: Date | string | number): string {
  const startEt = toEt(from);
  if (isMarketOpen(from)) return startEt.toUTC().toISO() as string;
  let d = startEt.toISODate() as IsoDate;
  for (let i = 0; i < 15; i++) {
    const tradeDate = addDays(d, 1);
    if (isBusinessDay(tradeDate)) {
      const open = sessionStartUtc(tradeDate);
      if (Date.parse(open) >= startEt.toMillis()) return open;
    }
    d = addDays(d, 1);
  }
  throw new Error('No session open found within 15 days');
}

/**
 * Hourly mark slots: top of each ET hour (+ minute offset) while the market is in session.
 * Returns UTC ISO instants within [fromMs, toMs].
 */
export function hourlySlotsBetween(fromMs: number, toMs: number, minuteOffset = 0): string[] {
  const out: string[] = [];
  let t = DateTime.fromMillis(fromMs).setZone(ET).startOf('hour').plus({ minutes: minuteOffset });
  if (t.toMillis() < fromMs) t = t.plus({ hours: 1 });
  while (t.toMillis() <= toMs) {
    if (isMarketOpen(t.toMillis())) out.push(t.toUTC().toISO() as string);
    t = t.plus({ hours: 1 });
  }
  return out;
}

/** The hourly slot that is current at `nowMs` (latest slot <= now), or null if not in session. */
export function currentHourlySlot(nowMs: number, minuteOffset = 0): string | null {
  let t = DateTime.fromMillis(nowMs).setZone(ET).startOf('hour').plus({ minutes: minuteOffset });
  if (t.toMillis() > nowMs) t = t.minus({ hours: 1 });
  return isMarketOpen(t.toMillis()) ? (t.toUTC().toISO() as string) : null;
}

export function nextHourlySlot(nowMs: number, minuteOffset = 0): string | null {
  const slots = hourlySlotsBetween(nowMs + 1000, nowMs + 4 * 24 * 3600_000, minuteOffset);
  return slots[0] ?? null;
}

// ---------------------------------------------------------------------------
// EIA Weekly Petroleum Status Report: default Wednesday 10:30 ET for the week ending the
// prior Friday. Holiday weeks shift; users can override specific dates in Settings.
// ---------------------------------------------------------------------------

export interface EiaOverride {
  date: IsoDate; // the date of the default (Wednesday) release this override replaces, or any date in that week
  releaseDate: IsoDate | null; // null = no release that week
  timeEt: string; // HH:MM
}

export interface EiaRelease {
  releaseDate: IsoDate;
  timeEt: string;
  releaseUtc: string;
  weekEnding: IsoDate;
  source: 'default-rule' | 'user-override';
}

function weekKey(date: IsoDate): string {
  const d = DateTime.fromISO(date, { zone: ET });
  return `${d.weekYear}-W${d.weekNumber}`;
}

export function eiaReleaseForWeek(anyDateInWeek: IsoDate, overrides: EiaOverride[] = []): EiaRelease | null {
  const d = DateTime.fromISO(anyDateInWeek, { zone: ET });
  const wednesday = d.minus({ days: d.weekday - 3 }); // Monday-based week
  const wedIso = wednesday.toISODate() as IsoDate;
  const weekEnding = wednesday.minus({ days: 5 }).toISODate() as IsoDate; // prior Friday
  const ov = overrides.find((o) => weekKey(o.date) === weekKey(wedIso));
  if (ov) {
    if (!ov.releaseDate) return null;
    return {
      releaseDate: ov.releaseDate,
      timeEt: ov.timeEt,
      releaseUtc: etWallClockToUtc(ov.releaseDate, ov.timeEt),
      weekEnding,
      source: 'user-override',
    };
  }
  return { releaseDate: wedIso, timeEt: '10:30', releaseUtc: etWallClockToUtc(wedIso, '10:30'), weekEnding, source: 'default-rule' };
}

export function nextEiaRelease(nowMs: number, overrides: EiaOverride[] = []): EiaRelease | null {
  let d = DateTime.fromMillis(nowMs).setZone(ET).toISODate() as IsoDate;
  for (let i = 0; i < 5; i++) {
    const r = eiaReleaseForWeek(d, overrides);
    // Treat a release as "next" until its 0–15 minute reaction window has closed.
    if (r && Date.parse(r.releaseUtc) + 15 * 60_000 >= nowMs) return r;
    d = addDays(d, 7);
  }
  return null;
}

export function mostRecentEiaRelease(nowMs: number, overrides: EiaOverride[] = []): EiaRelease | null {
  let d = DateTime.fromMillis(nowMs).setZone(ET).toISODate() as IsoDate;
  for (let i = 0; i < 5; i++) {
    const r = eiaReleaseForWeek(d, overrides);
    if (r && Date.parse(r.releaseUtc) <= nowMs) return r;
    d = addDays(d, -7);
  }
  return null;
}
