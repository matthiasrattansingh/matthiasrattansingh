// Weekly inventory logic for the thesis exit:
// "close both legs when EIA data confirms distillate stocks have increased for three
//  consecutive weeks".
//
// Only EIA actuals count (never API survey numbers or analyst estimates). A week-over-week
// change comes from the reported change when present, otherwise from consecutive weekly levels.
// Weeks must be contiguous (exactly 7 days apart) — a gap breaks the streak.
import { addDays, type IsoDate } from './calendar.ts';

export type InventoryKind = 'actual' | 'estimate' | 'api';

export interface InventoryObs {
  series: string; // 'distillate' | 'crude' | 'gasoline' | 'cushing'
  weekEnding: IsoDate;
  levelKb: number | null; // thousand barrels
  changeKb: number | null; // reported week-over-week change, thousand barrels
  kind: InventoryKind;
  source: string;
  releasedAt: string | null;
}

export interface WeeklyChange {
  weekEnding: IsoDate;
  changeKb: number;
  derivedFrom: 'reported-change' | 'levels';
  releasedAt: string | null;
}

/** Week-over-week changes for EIA actuals of a series, ascending by week. */
export function weeklyChanges(obs: InventoryObs[], series: string): WeeklyChange[] {
  const actual = obs
    .filter((o) => o.series === series && o.kind === 'actual')
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
  const byWeek = new Map<IsoDate, InventoryObs>();
  for (const o of actual) byWeek.set(o.weekEnding, o); // last write wins (revisions)
  const out: WeeklyChange[] = [];
  for (const [week, o] of byWeek) {
    if (o.changeKb !== null && Number.isFinite(o.changeKb)) {
      out.push({ weekEnding: week, changeKb: o.changeKb, derivedFrom: 'reported-change', releasedAt: o.releasedAt });
      continue;
    }
    const prev = byWeek.get(addDays(week, -7));
    if (o.levelKb !== null && prev && prev.levelKb !== null) {
      out.push({ weekEnding: week, changeKb: o.levelKb - prev.levelKb, derivedFrom: 'levels', releasedAt: o.releasedAt });
    }
  }
  return out;
}

export interface BuildStreak {
  streak: number; // consecutive weekly increases ending at the latest week
  latestWeek: IsoDate | null;
  weeks: WeeklyChange[]; // the weeks in the streak, ascending
  note: string;
}

export function consecutiveBuilds(obs: InventoryObs[], series = 'distillate'): BuildStreak {
  const changes = weeklyChanges(obs, series);
  if (!changes.length) return { streak: 0, latestWeek: null, weeks: [], note: 'No EIA actual week-over-week change available.' };
  const latest = changes[changes.length - 1];
  const streakWeeks: WeeklyChange[] = [];
  let expectedWeek = latest.weekEnding;
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.weekEnding !== expectedWeek) break; // gap in weekly data
    if (!(c.changeKb > 0)) break;
    streakWeeks.unshift(c);
    expectedWeek = addDays(expectedWeek, -7);
  }
  const note =
    streakWeeks.length === 0
      ? `Latest EIA week (ending ${latest.weekEnding}) shows no increase (${latest.changeKb >= 0 ? '+' : ''}${latest.changeKb.toFixed(0)} kb).`
      : `${streakWeeks.length} consecutive weekly increase(s) through week ending ${latest.weekEnding}.`;
  return { streak: streakWeeks.length, latestWeek: latest.weekEnding, weeks: streakWeeks, note };
}

export interface ThesisExitEvaluation {
  met: boolean;
  streak: BuildStreak;
  required: number;
  reason: string;
}

/**
 * The rule triggers when the latest EIA actual completes N consecutive weekly builds and that
 * confirming data was released after the position was opened (so pre-entry history alone does
 * not close a position the moment it is opened).
 */
export function evaluateDistillateExit(obs: InventoryObs[], requiredWeeks: number, positionOpenedAt: string): ThesisExitEvaluation {
  const streak = consecutiveBuilds(obs, 'distillate');
  if (streak.streak < requiredWeeks) {
    return { met: false, streak, required: requiredWeeks, reason: `${streak.note} Rule needs ${requiredWeeks}.` };
  }
  const confirming = streak.weeks[streak.weeks.length - 1];
  const releasedAt = confirming.releasedAt;
  if (releasedAt && Date.parse(releasedAt) < Date.parse(positionOpenedAt)) {
    return {
      met: false,
      streak,
      required: requiredWeeks,
      reason: `${streak.note} The confirming release (${releasedAt}) predates the position entry; waiting for a new EIA release.`,
    };
  }
  return {
    met: true,
    streak,
    required: requiredWeeks,
    reason: `EIA actuals confirm ${streak.streak} consecutive weekly distillate builds: ${streak.weeks
      .map((w) => `${w.weekEnding} +${w.changeKb.toFixed(0)} kb`)
      .join(', ')}.`,
  };
}
