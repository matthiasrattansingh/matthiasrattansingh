// In-process scheduler. It runs only while the server process is running; there is no external
// cron or push notification. Each scheduled unit of work has a deterministic job key (e.g.
// "hourly:2026-10-06T14:00:00.000Z") so retries and restarts never duplicate an update, and
// slots that passed while the app was not running are recorded as "missed" — never backfilled.
import type { BriefingDto, SchedulerStatusDto, UpdateReportDto } from '../shared/types.ts';
import type { AppContext, SchedulerHandle } from './context.ts';
import * as repo from './repo.ts';
import { loadSettings } from './settings.ts';
import { getProvider } from './providers/index.ts';
import { ingestProviderQuotes } from './quotes.ts';
import { evaluate, iso } from './engine.ts';
import { snapshotContracts, valuate, type Valuation } from './valuation.ts';
import { buildBriefingContent, storeBriefing } from './market.ts';
import { fetchFx } from './fx.ts';
import { computeReaction, ensureRelease, fetchEiaWeekly, ingestInventories, reactionContracts, releaseRow, storeReaction, REACTION_WINDOW_MIN } from './eia.ts';
import {
  addDays,
  eiaReleaseForWeek,
  etDate,
  etWallClockToUtc,
  hourlySlotsBetween,
  isMarketOpen,
  isWeekday,
  nextEiaRelease,
  nextHourlySlot,
  nextSessionOpen,
  sessionTradeDate,
} from '../domain/calendar.ts';
import type { AppSettings } from '../shared/types.ts';

export interface RefreshResult {
  attempted: boolean;
  ok: boolean;
  errors: string[];
  fetched: number;
  inserted: number;
  note: string | null;
  at: string;
}

export function neededContracts(app: AppContext): string[] {
  const { db } = app;
  const account = repo.currentAccount(db);
  const set = new Set<string>();
  for (const p of repo.openPositions(db, account.id)) for (const l of p.legs) set.add(l.contract);
  for (const o of repo.workingOrders(db, account.id)) for (const l of o.request.legs) set.add(l.contract);
  for (const s of snapshotContracts(app.now())) set.add(s.contract);
  return [...set];
}

export function providerDelayMinutes(settings: AppSettings): number {
  if (settings.provider === 'databento') return settings.databentoDelayMinutes;
  if (settings.provider === 'custom-http') return settings.customHttp.delayMinutes;
  return settings.manualDefaultDelayMinutes;
}

export async function refreshQuotes(app: AppContext, trigger: string): Promise<RefreshResult> {
  const settings = loadSettings(app.db);
  const provider = getProvider(settings.provider);
  const at = iso(app.now());
  if (provider.kind === 'manual') {
    return { attempted: false, ok: true, errors: [], fetched: 0, inserted: 0, note: 'Manual quote source: nothing to fetch. Enter quotes on the Market page.', at };
  }
  const status = provider.status(app.env, settings);
  let result: RefreshResult;
  if (!status.configured) {
    result = { attempted: false, ok: false, errors: [status.reason ?? 'Provider not configured.'], fetched: 0, inserted: 0, note: null, at };
  } else {
    try {
      const res = await provider.fetchLatest(neededContracts(app), { env: app.env, settings, fetchImpl: app.fetchImpl, nowMs: app.now() });
      const ing = ingestProviderQuotes(app.db, provider.id, res.quotes, app.now());
      const errors = [...res.errors, ...ing.rejected];
      result = { attempted: true, ok: res.quotes.length > 0, errors, fetched: res.quotes.length, inserted: ing.inserted, note: null, at };
    } catch (e) {
      result = { attempted: true, ok: false, errors: [(e as Error).message], fetched: 0, inserted: 0, note: null, at };
    }
  }
  app.db.setMeta('lastFetch', JSON.stringify({ ...result, trigger, provider: provider.id }));
  if (result.ok) app.db.setMeta('lastSuccessfulFetch', JSON.stringify({ at, trigger, provider: provider.id, fetched: result.fetched }));
  else app.log(`quote refresh (${trigger}) failed: ${result.errors.join('; ')}`);
  return result;
}

const REPORT_EVENT_TYPES = ['order.rejected', 'order.filled', 'order.expired', 'position.exit_triggered', 'position.closed', 'risk.'];

export function buildUpdateReport(app: AppContext, v: Valuation, trigger: string, fetch: RefreshResult, sinceIso: string): UpdateReportDto['report'] {
  const settings = v.settings;
  const legs = [...v.contractCache.values()].filter((m) => v.positions.some((p) => p.legs.some((l) => l.contract === m.contract)));
  const events = repo
    .listEvents(app.db, { since: sinceIso, limit: 200 })
    .filter((e) => REPORT_EVENT_TYPES.some((t) => e.type.startsWith(t)))
    .map((e) => ({ ts: e.ts, type: e.type, summary: e.summary }));
  const a = v.accountDto;
  return {
    trigger,
    provider: settings.provider,
    fetch: { attempted: fetch.attempted, ok: fetch.ok, errors: fetch.errors, fetched: fetch.fetched },
    legs: legs.map((m) => ({
      contract: m.contract,
      label: m.label,
      price: m.quote?.price ?? null,
      unit: m.unit,
      perBarrel: m.quote?.perBarrel ?? null,
      exchangeTs: m.quote?.exchangeTs ?? null,
      observedAt: m.quote?.observedAt ?? null,
      source: m.quote?.source ?? null,
      status: m.freshness.status,
      reason: m.freshness.reason,
    })),
    positions: v.positions.map((p) => ({ id: p.id, label: p.label, entryValue: p.entryValue, value: p.mark?.value ?? null, unrealized: p.mark?.unrealized ?? null, valid: p.mark?.valid ?? false, missing: p.mark?.missing ?? [] })),
    account: {
      realized: a.realizedGross,
      unrealized: a.unrealized ?? a.unrealizedProvisional,
      fees: a.fees,
      totalPnl: a.totalPnl,
      equity: a.equity,
      equityValid: a.equityValid,
      peakEquity: a.peakEquity,
      drawdownPct: a.drawdownPct,
      reservedMargin: a.buyingPower.reservedMargin,
      buyingPower: a.buyingPower.buyingPower,
      buyingPowerVerified: a.buyingPower.verified,
      distanceToLimitUsd: a.distanceToLimitUsd,
      grossBeforeCosts: !a.costsConfigured,
    },
    events,
  };
}

export async function runHourly(app: AppContext, slotIso: string): Promise<void> {
  const { db } = app;
  const key = `hourly:${slotIso}`;
  const existing = repo.getJob(db, key);
  if (existing && ['ok', 'partial', 'missed'].includes(existing.status)) return; // idempotent retry
  repo.upsertJob(db, { key, kind: 'hourly', scheduledFor: slotIso, status: 'running', startedAt: iso(app.now()), incrementAttempts: true });
  try {
    const fetch = await refreshQuotes(app, 'hourly');
    const evalRes = evaluate(db, app.now(), 'hourly');
    const prev = db.get<{ created_at: string }>('SELECT created_at FROM updates ORDER BY slot_key DESC LIMIT 1');
    const since = prev?.created_at ?? iso(Date.parse(slotIso) - 3600_000);
    const report = buildUpdateReport(app, evalRes.valuation, 'hourly', fetch, since);
    db.run('INSERT OR IGNORE INTO updates (slot_key, account_id, created_at, report_json) VALUES (?, ?, ?, ?)', key, evalRes.valuation.account.id, iso(app.now()), JSON.stringify(report));
    const status = fetch.attempted && !fetch.ok ? 'failed' : fetch.errors.length ? 'partial' : 'ok';
    repo.upsertJob(db, {
      key,
      kind: 'hourly',
      scheduledFor: slotIso,
      status,
      finishedAt: iso(app.now()),
      detail: { fetch, equityValid: evalRes.valuation.equityValid, actions: evalRes.actions, note: fetch.note },
    });
    repo.addEvent(db, {
      accountId: evalRes.valuation.account.id,
      ts: iso(app.now()),
      type: 'update.hourly',
      summary: `Hourly mark (${status}) for slot ${slotIso}: equity ${evalRes.valuation.equity.toFixed(2)}${evalRes.valuation.equityValid ? '' : ' (provisional)'}${fetch.errors.length ? `; fetch issues: ${fetch.errors.join('; ')}` : ''}${fetch.note ? `; ${fetch.note}` : ''}`,
      dedupeKey: `${key}:${status}`,
    });
  } catch (e) {
    repo.upsertJob(db, { key, kind: 'hourly', scheduledFor: slotIso, status: 'failed', finishedAt: iso(app.now()), detail: { error: (e as Error).message } });
    app.log(`hourly ${slotIso} failed: ${(e as Error).message}`);
  }
}

export async function runBriefing(app: AppContext, kind: 'scheduled' | 'adhoc'): Promise<BriefingDto> {
  const { db } = app;
  const settings = loadSettings(db);
  const nowMs = app.now();
  const today = etDate(nowMs);
  const scheduledFor = kind === 'scheduled' ? etWallClockToUtc(today, settings.briefingTimeEt) : null;
  const key = kind === 'scheduled' ? `briefing:${today}` : `adhoc:${iso(nowMs)}`;
  if (kind === 'scheduled') {
    const done = db.get('SELECT key FROM briefings WHERE key = ?', key);
    if (done) return repo.mapBriefing(db.get('SELECT * FROM briefings WHERE key = ?', key)!);
    repo.upsertJob(db, { key, kind: 'briefing', scheduledFor, status: 'running', startedAt: iso(nowMs), incrementAttempts: true });
  }
  const fetchIssues: string[] = [];
  const fx = await fetchFx(app, settings.fxPairs);
  fetchIssues.push(...fx.errors);
  if (app.env.eiaKey) {
    const eia = await fetchEiaWeekly(app, 12);
    fetchIssues.push(...eia.errors);
    if (eia.rows.length) ingestInventories(db, eia.rows, app.now(), 'EIA API (briefing refresh)');
  }
  const q = await refreshQuotes(app, 'briefing');
  fetchIssues.push(...q.errors);
  evaluate(db, app.now(), 'briefing');
  const content = buildBriefingContent(db, app.now(), { eia: !!app.env.eiaKey });
  content.dataQuality.unshift(...fetchIssues.map((e) => `Fetch issue: ${e}`));
  const briefing = storeBriefing(db, key, kind, scheduledFor, app.now(), content);
  if (kind === 'scheduled') {
    repo.upsertJob(db, { key, kind: 'briefing', scheduledFor, status: fetchIssues.length ? 'partial' : 'ok', finishedAt: iso(app.now()), detail: { late: briefing.late, issues: fetchIssues } });
  }
  repo.addEvent(db, {
    ts: iso(app.now()),
    type: 'briefing.generated',
    summary: `${kind === 'scheduled' ? `Scheduled ${settings.briefingTimeEt} ET briefing` : 'Ad-hoc briefing'} generated${briefing.late ? ' late (app was not running at the scheduled time)' : ''}.`,
    dedupeKey: `briefing-event:${key}`,
  });
  return briefing;
}

export class Scheduler implements SchedulerHandle {
  running = false;
  startedAt: string | null = null;
  lastTickAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastFillPoll = 0;
  private lastEiaPoll = 0;
  private lastWindowPoll = 0;
  private lastReactionAttempt = 0;
  private app: AppContext;

  constructor(app: AppContext) {
    this.app = app;
  }

  start(intervalMs = 20_000): void {
    const { db } = this.app;
    // Jobs left "running" by a crash are marked failed so they can be retried inside their window.
    db.run("UPDATE jobs SET status = 'failed', finished_at = ?, detail_json = COALESCE(detail_json, '{\"error\":\"interrupted (process stopped)\"}') WHERE status = 'running'", iso(this.app.now()));
    this.running = true;
    this.startedAt = iso(this.app.now());
    this.timer = setInterval(() => void this.tick(), intervalMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = loadSettings(this.app.db);
      await this.hourly(settings);
      await this.briefing(settings);
      await this.eia(settings);
      await this.fillPoll(settings);
      // Expire day orders / re-check rules even when nothing else ran (no mark row recorded).
      evaluate(this.app.db, this.app.now(), 'scheduler-tick', { recordMark: false });
    } catch (e) {
      this.app.log(`scheduler tick error: ${(e as Error).stack ?? e}`);
    } finally {
      this.lastTickAt = iso(this.app.now());
      this.busy = false;
    }
  }

  private async hourly(settings: AppSettings): Promise<void> {
    if (!settings.hourlyEnabled) return;
    const { db } = this.app;
    const now = this.app.now();
    const createdAt = Date.parse(db.getMeta('created_at') ?? iso(now));
    const lastRecorded = db.get<{ s: string }>("SELECT MAX(scheduled_for) AS s FROM jobs WHERE kind = 'hourly'")?.s;
    const from = Math.max(now - 48 * 3600_000, lastRecorded ? Date.parse(lastRecorded) - 3 * 3600_000 : 0);
    for (const slot of hourlySlotsBetween(from, now, settings.hourlyMinuteOffset)) {
      // Slots whose 50-minute run window closed before this ledger existed are not "missed".
      if (Date.parse(slot) + 50 * 60_000 < createdAt) continue;
      const key = `hourly:${slot}`;
      const job = repo.getJob(db, key);
      if (job && ['ok', 'partial', 'missed', 'running'].includes(job.status)) continue;
      if (job && job.status === 'failed' && job.attempts >= 3) continue;
      if (now - Date.parse(slot) > 50 * 60_000) {
        if (!job) {
          repo.upsertJob(db, {
            key,
            kind: 'hourly',
            scheduledFor: slot,
            status: 'missed',
            finishedAt: iso(now),
            detail: { reason: 'The app/scheduler was not running during this slot. Not backfilled.' },
          });
          repo.addEvent(db, { ts: iso(now), type: 'update.missed', summary: `Hourly update for ${slot} was missed (app not running). Not backfilled.`, dedupeKey: `missed:${key}` });
        }
        continue;
      }
      await runHourly(this.app, slot);
    }
  }

  private async briefing(settings: AppSettings): Promise<void> {
    if (!settings.briefingEnabled) return;
    const { db } = this.app;
    const now = this.app.now();
    const today = etDate(now);
    if (!isWeekday(today)) return;
    const scheduled = Date.parse(etWallClockToUtc(today, settings.briefingTimeEt));
    if (now < scheduled) return;
    const key = `briefing:${today}`;
    const job = repo.getJob(db, key);
    if (job && ['ok', 'partial', 'missed', 'running'].includes(job.status)) return;
    if (job && job.status === 'failed' && job.attempts >= 3) return;
    const createdAt = Date.parse(db.getMeta('created_at') ?? iso(now));
    // Generate late (clearly labeled) until 17:00 ET; after that the day's briefing is not generated
    // (recorded as missed if the ledger already existed at the scheduled time).
    if (now > Date.parse(etWallClockToUtc(today, '17:00'))) {
      if (createdAt < scheduled) {
        repo.upsertJob(db, { key, kind: 'briefing', scheduledFor: iso(scheduled), status: 'missed', finishedAt: iso(now), detail: { reason: 'App was not running between the briefing time and 17:00 ET.' } });
      }
      return;
    }
    try {
      await runBriefing(this.app, 'scheduled');
    } catch (e) {
      repo.upsertJob(db, { key, kind: 'briefing', scheduledFor: iso(scheduled), status: 'failed', finishedAt: iso(now), detail: { error: (e as Error).message } });
      this.app.log(`briefing failed: ${(e as Error).message}`);
    }
  }

  private async eia(settings: AppSettings): Promise<void> {
    const { db, env } = this.app;
    const now = this.app.now();
    const rel = eiaReleaseForWeek(etDate(now), settings.eiaOverrides);
    if (!rel) return;
    const relMs = Date.parse(rel.releaseUtc);
    if (now < relMs - 30 * 60_000 || now > relMs + 6 * 3600_000) return;
    ensureRelease(db, rel);
    const delay = providerDelayMinutes(settings);
    // Poll quotes every minute around the release window for latest-quote APIs so that quotes
    // with exchange times near +0 and +15 minutes are captured.
    if (settings.provider === 'custom-http' && now >= relMs - 10 * 60_000 && now <= relMs + (REACTION_WINDOW_MIN + delay + 15) * 60_000) {
      if (now - this.lastWindowPoll >= 60_000) {
        this.lastWindowPoll = now;
        await refreshQuotes(this.app, 'eia-window');
        evaluate(db, this.app.now(), 'eia-window');
      }
    }
    const row = releaseRow(db, rel.releaseDate);
    if (now >= relMs && row && !row.data_arrived_at && env.eiaKey && settings.eiaPollEnabled && now <= relMs + 3 * 3600_000) {
      if (now - this.lastEiaPoll >= 2 * 60_000) {
        this.lastEiaPoll = now;
        const r = await fetchEiaWeekly(this.app, 6);
        if (r.rows.length) ingestInventories(db, r.rows, this.app.now(), 'EIA API poll');
        repo.upsertJob(db, { key: `eia-poll:${rel.releaseDate}`, kind: 'eia-poll', scheduledFor: rel.releaseUtc, status: r.errors.length ? 'partial' : 'ok', finishedAt: iso(this.app.now()), detail: { errors: r.errors, rows: r.rows.length }, incrementAttempts: true });
      }
    }
    const reaction = db.get<{ finalized_at: string | null }>('SELECT finalized_at FROM eia_reactions WHERE release_date = ?', rel.releaseDate);
    if (now >= relMs + (REACTION_WINDOW_MIN + delay) * 60_000 && !reaction?.finalized_at && now - this.lastReactionAttempt >= 2 * 60_000) {
      this.lastReactionAttempt = now;
      if (settings.provider === 'databento' && env.databentoKey) {
        const provider = getProvider('databento');
        try {
          const res = await provider.fetchWindow!(reactionContracts(db, rel.releaseDate), new Date(relMs - 30 * 60_000).toISOString(), new Date(relMs + REACTION_WINDOW_MIN * 60_000 + 60_000).toISOString(), {
            env,
            settings,
            fetchImpl: this.app.fetchImpl,
            nowMs: this.app.now(),
          });
          ingestProviderQuotes(db, 'databento', res.quotes, this.app.now());
        } catch (e) {
          this.app.log(`EIA window fetch failed: ${(e as Error).message}`);
        }
      }
      storeReaction(db, computeReaction(db, rel.releaseDate, this.app.now()));
    }
  }

  private async fillPoll(settings: AppSettings): Promise<void> {
    if (getProvider(settings.provider).kind !== 'api') return;
    const now = this.app.now();
    if (!isMarketOpen(now) || now - this.lastFillPoll < settings.fillPollMinutes * 60_000) return;
    const { db } = this.app;
    const account = repo.currentAccount(db);
    const pendingExits = repo.openPositions(db, account.id).some((p) => p.status === 'exit_pending');
    if (!pendingExits && !repo.workingOrders(db, account.id).length) return;
    this.lastFillPoll = now;
    await refreshQuotes(this.app, 'fill-poll');
    evaluate(db, this.app.now(), 'fill-poll');
  }
}

function nextBriefing(nowMs: number, timeEt: string): string {
  let d = etDate(nowMs);
  for (let i = 0; i < 8; i++) {
    if (isWeekday(d)) {
      const t = etWallClockToUtc(d, timeEt);
      if (Date.parse(t) > nowMs) return t;
    }
    d = addDays(d, 1);
  }
  return etWallClockToUtc(d, timeEt);
}

export function schedulerStatus(app: AppContext): SchedulerStatusDto {
  const { db } = app;
  const settings = loadSettings(db);
  const now = app.now();
  const next = nextEiaRelease(now, settings.eiaOverrides);
  const limitations = [
    'Scheduling runs inside the server process. Hourly marks, the weekday briefing and EIA captures happen only while the server is running; slots missed while it was stopped are recorded as missed and not backfilled.',
    'No push, email or SMS notifications are sent. Updates are recorded in the app (History → Hourly updates) and shown on the dashboard.',
  ];
  if (settings.provider === 'manual') limitations.push('Quote source is manual: scheduled updates re-mark the last entered quotes, which turn stale unless new quotes are entered.');
  if (!app.scheduler?.running) limitations.unshift('The scheduler is NOT running in this process.');
  return {
    running: !!app.scheduler?.running,
    startedAt: app.scheduler?.startedAt ?? null,
    lastTickAt: app.scheduler?.lastTickAt ?? null,
    marketOpen: isMarketOpen(now),
    tradeDate: sessionTradeDate(now),
    nextSessionOpen: isMarketOpen(now) ? null : nextSessionOpen(now),
    hourly: {
      enabled: settings.hourlyEnabled,
      lastSuccess: repo.lastJob(db, 'hourly', ['ok', 'partial']),
      lastAttempt: repo.lastJob(db, 'hourly'),
      next: settings.hourlyEnabled ? nextHourlySlot(now, settings.hourlyMinuteOffset) : null,
      recentMissed: repo.jobsOfKind(db, 'hourly', 10, 'missed'),
    },
    briefing: { enabled: settings.briefingEnabled, next: settings.briefingEnabled ? nextBriefing(now, settings.briefingTimeEt) : null, last: repo.lastJob(db, 'briefing') },
    eia: { next: next ? { releaseDate: next.releaseDate, releaseUtc: next.releaseUtc, timeEt: next.timeEt, weekEnding: next.weekEnding, source: next.source } : null },
    limitations,
  };
}

export function lastValuation(app: AppContext): Valuation {
  return valuate(app.db, app.now());
}
