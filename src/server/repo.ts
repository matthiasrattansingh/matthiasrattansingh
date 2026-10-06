// Data-access helpers and row → DTO mapping.
import type { Db } from './db.ts';
import type {
  BriefingDto,
  EventDto,
  ExitRule,
  FxRateDto,
  InventoryDto,
  JobDto,
  LegDto,
  LegFillDto,
  MarginFigureDto,
  NoteDto,
  OrderDto,
  OrderRequestDto,
  PositionDto,
  ProviderId,
  QuoteDto,
  ReactionDto,
  UpdateReportDto,
} from '../shared/types.ts';
import { contractLabel, productOf, toPerBarrel } from '../domain/contracts.ts';

const j = <T>(s: unknown): T => (s === null || s === undefined ? (null as T) : (JSON.parse(String(s)) as T));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface AccountRow {
  id: number;
  created_at: string;
  starting_equity: number;
  peak_equity: number;
  peak_at: string;
  status: 'active' | 'halted' | 'archived';
  halted_at: string | null;
  halted_reason: string | null;
}

export function currentAccount(db: Db): AccountRow {
  const row = db.get<AccountRow>("SELECT * FROM accounts WHERE status != 'archived' ORDER BY id DESC LIMIT 1");
  if (!row) throw new Error('No paper account exists (seed has not run).');
  return row;
}

export function createAccount(db: Db, startingEquity: number, nowIso: string): number {
  return db.run(
    "INSERT INTO accounts (created_at, starting_equity, peak_equity, peak_at, status) VALUES (?, ?, ?, ?, 'active')",
    nowIso,
    startingEquity,
    startingEquity,
    nowIso,
  ).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

export function valueFormula(strategy: string, legs: LegDto[]): string {
  const parts = legs.map((l, i) => {
    const p = productOf(l.contract);
    const term = p.toBarrelFactor === 1 ? `${l.contract} ($/bbl)` : `${l.contract} ($/gal) × ${p.toBarrelFactor}`;
    const sign = l.weight === 1 ? (i === 0 ? '' : ' + ') : i === 0 ? '−' : ' − ';
    return `${sign}${term}`;
  });
  return `${strategy === 'outright' ? 'price' : 'spread'} ($/bbl) = ${parts.join('')}`;
}

export function mapPosition(r: Record<string, unknown>): PositionDto {
  const legs = j<LegDto[]>(r.legs_json);
  return {
    id: Number(r.id),
    strategy: r.strategy as PositionDto['strategy'],
    label: String(r.label),
    direction: Number(r.direction) as 1 | -1,
    legs,
    contractsPerLeg: Number(r.contracts_per_leg),
    barrels: Number(r.barrels),
    entryValue: Number(r.entry_value),
    entryFills: j<LegFillDto[] | null>(r.entry_fills_json),
    entryKind: r.entry_kind as 'seed' | 'order',
    entryNote: String(r.entry_note),
    openedAt: String(r.opened_at),
    orderId: num(r.order_id),
    rationale: str(r.rationale),
    exitRuleText: str(r.exit_rule_text),
    exitRules: j<ExitRule[]>(r.exit_rules_json) ?? [],
    entryCommission: num(r.entry_commission),
    status: r.status as PositionDto['status'],
    exitPending: j(r.exit_pending_json),
    closedAt: str(r.closed_at),
    exitValue: num(r.exit_value),
    exitFills: j<LegFillDto[] | null>(r.exit_fills_json),
    exitReason: str(r.exit_reason),
    exitKind: str(r.exit_kind),
    exitCommission: num(r.exit_commission),
    realizedGross: num(r.realized_gross),
    valueFormula: valueFormula(String(r.strategy), legs),
  };
}

export function openPositions(db: Db, accountId: number): PositionDto[] {
  return db
    .all("SELECT * FROM positions WHERE account_id = ? AND status IN ('open','exit_pending') ORDER BY id", accountId)
    .map(mapPosition);
}

export function closedPositions(db: Db, accountId: number, limit = 100): PositionDto[] {
  return db
    .all("SELECT * FROM positions WHERE account_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT ?", accountId, limit)
    .map(mapPosition);
}

export function positionById(db: Db, id: number): PositionDto | undefined {
  const r = db.get('SELECT * FROM positions WHERE id = ?', id);
  return r ? mapPosition(r) : undefined;
}

export interface NewPosition {
  accountId: number;
  strategy: PositionDto['strategy'];
  label: string;
  direction: 1 | -1;
  legs: LegDto[];
  contractsPerLeg: number;
  barrels: number;
  entryValue: number;
  entryFills: LegFillDto[] | null;
  entryKind: 'seed' | 'order';
  entryNote: string;
  openedAt: string;
  orderId: number | null;
  rationale: string | null;
  exitRuleText: string | null;
  exitRules: ExitRule[];
  entryCommission: number | null;
}

export function insertPosition(db: Db, p: NewPosition): number {
  return db.run(
    `INSERT INTO positions (account_id, strategy, label, direction, legs_json, contracts_per_leg, barrels, entry_value,
       entry_fills_json, entry_kind, entry_note, opened_at, order_id, rationale, exit_rule_text, exit_rules_json,
       entry_commission, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    p.accountId,
    p.strategy,
    p.label,
    p.direction,
    JSON.stringify(p.legs),
    p.contractsPerLeg,
    p.barrels,
    p.entryValue,
    p.entryFills ? JSON.stringify(p.entryFills) : null,
    p.entryKind,
    p.entryNote,
    p.openedAt,
    p.orderId,
    p.rationale,
    p.exitRuleText,
    JSON.stringify(p.exitRules),
    p.entryCommission,
  ).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export function mapOrder(r: Record<string, unknown>): OrderDto {
  return {
    id: Number(r.id),
    idempotencyKey: String(r.idempotency_key),
    submittedAt: String(r.submitted_at),
    tradeDate: String(r.trade_date),
    status: r.status as OrderDto['status'],
    request: j<OrderRequestDto>(r.request_json),
    reasons: j<string[]>(r.reasons_json) ?? [],
    margin: j(r.margin_json),
    positionId: num(r.position_id),
    updatedAt: String(r.updated_at),
    fill: j(r.fill_json),
  };
}

export function orderByKey(db: Db, key: string): OrderDto | undefined {
  const r = db.get('SELECT * FROM orders WHERE idempotency_key = ?', key);
  return r ? mapOrder(r) : undefined;
}

export function orderById(db: Db, id: number): OrderDto | undefined {
  const r = db.get('SELECT * FROM orders WHERE id = ?', id);
  return r ? mapOrder(r) : undefined;
}

export function workingOrders(db: Db, accountId: number): OrderDto[] {
  return db.all("SELECT * FROM orders WHERE account_id = ? AND status = 'working' ORDER BY id", accountId).map(mapOrder);
}

export function recentOrders(db: Db, accountId: number, limit = 50): OrderDto[] {
  return db.all('SELECT * FROM orders WHERE account_id = ? ORDER BY id DESC LIMIT ?', accountId, limit).map(mapOrder);
}

export function tradesOnDate(db: Db, accountId: number, tradeDate: string): number {
  return Number(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE account_id = ? AND trade_date = ? AND status IN ('working','filled')", accountId, tradeDate)?.n ?? 0,
  );
}

// ---------------------------------------------------------------------------
// Events (history)
// ---------------------------------------------------------------------------

export interface NewEvent {
  accountId?: number | null;
  ts: string;
  type: string;
  summary: string;
  detail?: unknown;
  dedupeKey?: string | null;
}

/** Inserts an event; returns false when an event with the same dedupe key already exists. */
export function addEvent(db: Db, e: NewEvent): boolean {
  const r = db.run(
    'INSERT OR IGNORE INTO events (account_id, ts, type, summary, detail_json, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)',
    e.accountId ?? null,
    e.ts,
    e.type,
    e.summary,
    e.detail === undefined ? null : JSON.stringify(e.detail),
    e.dedupeKey ?? null,
  );
  return r.changes > 0;
}

export function mapEvent(r: Record<string, unknown>): EventDto {
  return { id: Number(r.id), ts: String(r.ts), type: String(r.type), summary: String(r.summary), detail: j(r.detail_json) };
}

export function listEvents(db: Db, opts: { limit?: number; type?: string; since?: string } = {}): EventDto[] {
  const where: string[] = [];
  const params: string[] = [];
  if (opts.type) {
    where.push('type LIKE ?');
    params.push(`${opts.type}%`);
  }
  if (opts.since) {
    where.push('ts > ?');
    params.push(opts.since);
  }
  const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC LIMIT ${Math.min(opts.limit ?? 200, 2000)}`;
  return db.all(sql, ...params).map(mapEvent);
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export interface NewQuote {
  contract: string;
  price: number;
  source: string;
  sourceKind: 'manual' | 'api';
  provider: ProviderId;
  providerSymbol: string | null;
  delayMinutes: number | null;
  exchangeTs: string;
  observedAt: string;
  basis: string | null;
  note: string | null;
}

export function insertQuote(db: Db, q: NewQuote): { inserted: boolean; id: number } {
  const unit = productOf(q.contract).unit;
  const r = db.run(
    `INSERT OR IGNORE INTO quotes (contract, price, unit, source, source_kind, provider, provider_symbol, delay_minutes,
       exchange_ts, observed_at, basis, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    q.contract,
    q.price,
    unit,
    q.source,
    q.sourceKind,
    q.provider,
    q.providerSymbol,
    q.delayMinutes,
    q.exchangeTs,
    q.observedAt,
    q.basis,
    q.note,
  );
  return { inserted: r.changes > 0, id: r.lastInsertRowid };
}

export function mapQuote(r: Record<string, unknown>): QuoteDto {
  const contract = String(r.contract);
  const price = Number(r.price);
  return {
    id: Number(r.id),
    contract,
    contractLabel: contractLabel(contract),
    price,
    unit: String(r.unit),
    perBarrel: toPerBarrel(contract, price),
    source: String(r.source),
    sourceKind: r.source_kind as 'manual' | 'api',
    provider: r.provider as ProviderId,
    providerSymbol: str(r.provider_symbol),
    delayMinutes: num(r.delay_minutes),
    exchangeTs: String(r.exchange_ts),
    observedAt: String(r.observed_at),
    basis: str(r.basis),
    note: str(r.note),
  };
}

/** Latest quote for the exact contract by exchange time (never a continuous/front-month substitute). */
export function latestQuote(db: Db, contract: string, atOrBefore?: string): QuoteDto | null {
  const r = atOrBefore
    ? db.get('SELECT * FROM quotes WHERE contract = ? AND exchange_ts <= ? ORDER BY exchange_ts DESC, id DESC LIMIT 1', contract, atOrBefore)
    : db.get('SELECT * FROM quotes WHERE contract = ? ORDER BY exchange_ts DESC, id DESC LIMIT 1', contract);
  return r ? mapQuote(r) : null;
}

export function quotesBetween(db: Db, contract: string, startIso: string, endIso: string): QuoteDto[] {
  return db
    .all('SELECT * FROM quotes WHERE contract = ? AND exchange_ts > ? AND exchange_ts <= ? ORDER BY exchange_ts, id', contract, startIso, endIso)
    .map(mapQuote);
}

export function recentQuotes(db: Db, limit = 200, contract?: string): QuoteDto[] {
  return (
    contract
      ? db.all('SELECT * FROM quotes WHERE contract = ? ORDER BY exchange_ts DESC, id DESC LIMIT ?', contract, limit)
      : db.all('SELECT * FROM quotes ORDER BY observed_at DESC, id DESC LIMIT ?', limit)
  ).map(mapQuote);
}

// ---------------------------------------------------------------------------
// Margins
// ---------------------------------------------------------------------------

export function listMargins(db: Db): MarginFigureDto[] {
  return db.all('SELECT * FROM margins ORDER BY key').map((r) => ({
    key: String(r.key),
    perUnitUsd: Number(r.per_unit_usd),
    source: String(r.source),
    asOfDate: String(r.as_of_date),
    enteredAt: String(r.entered_at),
    note: str(r.note),
  }));
}

export function marginMap(db: Db): Map<string, MarginFigureDto> {
  return new Map(listMargins(db).map((m) => [m.key, m]));
}

export function upsertMargin(db: Db, m: MarginFigureDto): void {
  db.run(
    `INSERT INTO margins (key, per_unit_usd, source, as_of_date, entered_at, note) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET per_unit_usd = excluded.per_unit_usd, source = excluded.source,
       as_of_date = excluded.as_of_date, entered_at = excluded.entered_at, note = excluded.note`,
    m.key,
    m.perUnitUsd,
    m.source,
    m.asOfDate,
    m.enteredAt,
    m.note ?? null,
  );
}

// ---------------------------------------------------------------------------
// Inventories, FX, notes
// ---------------------------------------------------------------------------

export function mapInventory(r: Record<string, unknown>): InventoryDto {
  return {
    id: Number(r.id),
    series: String(r.series),
    weekEnding: String(r.week_ending),
    levelKb: num(r.level_kb),
    changeKb: num(r.change_kb),
    kind: r.kind as InventoryDto['kind'],
    source: String(r.source),
    releasedAt: str(r.released_at),
    enteredAt: String(r.entered_at),
  };
}

export function listInventories(db: Db, limitWeeks = 26): InventoryDto[] {
  return db
    .all(
      `SELECT * FROM inventories
       WHERE week_ending IN (SELECT DISTINCT week_ending FROM inventories ORDER BY week_ending DESC LIMIT ?)
       ORDER BY week_ending DESC, series, kind`,
      limitWeeks,
    )
    .map(mapInventory);
}

export function upsertInventory(db: Db, o: Omit<InventoryDto, 'id'>): boolean {
  const r = db.run(
    `INSERT INTO inventories (series, week_ending, level_kb, change_kb, kind, source, released_at, entered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(series, week_ending, kind, source) DO UPDATE SET level_kb = excluded.level_kb,
       change_kb = excluded.change_kb, released_at = COALESCE(inventories.released_at, excluded.released_at)
     WHERE inventories.level_kb IS NOT excluded.level_kb OR inventories.change_kb IS NOT excluded.change_kb`,
    o.series,
    o.weekEnding,
    o.levelKb,
    o.changeKb,
    o.kind,
    o.source,
    o.releasedAt,
    o.enteredAt,
  );
  return r.changes > 0;
}

export function upsertFx(db: Db, r: FxRateDto): void {
  db.run(
    'INSERT OR REPLACE INTO fx_rates (pair, as_of_date, rate, source, observed_at) VALUES (?, ?, ?, ?, ?)',
    r.pair,
    r.asOfDate,
    r.rate,
    r.source,
    r.observedAt,
  );
}

export function fxHistory(db: Db, pair: string, limit = 10): FxRateDto[] {
  return db
    .all(
      // Prefer API rows over manual rows when both exist for a date by taking the latest observation.
      'SELECT * FROM fx_rates WHERE pair = ? ORDER BY as_of_date DESC, observed_at DESC LIMIT ?',
      pair,
      limit * 3,
    )
    .map((r) => ({ pair: String(r.pair), asOfDate: String(r.as_of_date), rate: Number(r.rate), source: String(r.source), observedAt: String(r.observed_at) }))
    .filter((r, i, arr) => arr.findIndex((x) => x.asOfDate === r.asOfDate) === i)
    .slice(0, limit);
}

export function mapNote(r: Record<string, unknown>): NoteDto {
  return { id: Number(r.id), createdAt: String(r.created_at), kind: r.kind as NoteDto['kind'], title: String(r.title), body: str(r.body) };
}

export function listNotes(db: Db, kind?: NoteDto['kind']): NoteDto[] {
  return (
    kind
      ? db.all('SELECT * FROM notes WHERE archived = 0 AND kind = ? ORDER BY id DESC', kind)
      : db.all('SELECT * FROM notes WHERE archived = 0 ORDER BY id DESC')
  ).map(mapNote);
}

// ---------------------------------------------------------------------------
// Jobs (scheduler idempotency + status)
// ---------------------------------------------------------------------------

export function mapJob(r: Record<string, unknown> | undefined): JobDto | null {
  if (!r) return null;
  return {
    key: String(r.key),
    kind: String(r.kind),
    scheduledFor: str(r.scheduled_for),
    status: String(r.status),
    attempts: Number(r.attempts),
    startedAt: str(r.started_at),
    finishedAt: str(r.finished_at),
    detail: j(r.detail_json),
  };
}

export function getJob(db: Db, key: string): JobDto | null {
  return mapJob(db.get('SELECT * FROM jobs WHERE key = ?', key));
}

export function lastJob(db: Db, kind: string, statuses?: string[]): JobDto | null {
  if (statuses?.length) {
    return mapJob(
      db.get(
        `SELECT * FROM jobs WHERE kind = ? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY COALESCE(finished_at, started_at, scheduled_for) DESC LIMIT 1`,
        kind,
        ...statuses,
      ),
    );
  }
  return mapJob(db.get('SELECT * FROM jobs WHERE kind = ? ORDER BY COALESCE(finished_at, started_at, scheduled_for) DESC LIMIT 1', kind));
}

export function jobsOfKind(db: Db, kind: string, limit = 50, status?: string): JobDto[] {
  return (
    status
      ? db.all('SELECT * FROM jobs WHERE kind = ? AND status = ? ORDER BY scheduled_for DESC LIMIT ?', kind, status, limit)
      : db.all('SELECT * FROM jobs WHERE kind = ? ORDER BY scheduled_for DESC LIMIT ?', kind, limit)
  ).map((r) => mapJob(r)!);
}

export function upsertJob(db: Db, job: { key: string; kind: string; scheduledFor: string | null; status: string; startedAt?: string | null; finishedAt?: string | null; detail?: unknown; incrementAttempts?: boolean }): void {
  db.run(
    `INSERT INTO jobs (key, kind, scheduled_for, status, attempts, started_at, finished_at, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = excluded.status,
       attempts = jobs.attempts + ?,
       started_at = COALESCE(excluded.started_at, jobs.started_at),
       finished_at = excluded.finished_at,
       detail_json = COALESCE(excluded.detail_json, jobs.detail_json)`,
    job.key,
    job.kind,
    job.scheduledFor,
    job.status,
    job.incrementAttempts ? 1 : 0,
    job.startedAt ?? null,
    job.finishedAt ?? null,
    job.detail === undefined ? null : JSON.stringify(job.detail),
    job.incrementAttempts ? 1 : 0,
  );
}

// ---------------------------------------------------------------------------
// Briefings, updates, reactions
// ---------------------------------------------------------------------------

export function mapBriefing(r: Record<string, unknown>): BriefingDto {
  const content = j<BriefingDto['content']>(r.content_json);
  const scheduledFor = str(r.scheduled_for);
  const generatedAt = String(r.generated_at);
  return {
    key: String(r.key),
    kind: r.kind as BriefingDto['kind'],
    scheduledFor,
    generatedAt,
    late: !!scheduledFor && Date.parse(generatedAt) - Date.parse(scheduledFor) > 10 * 60_000,
    content,
  };
}

export function listBriefings(db: Db, limit = 20): BriefingDto[] {
  return db.all('SELECT * FROM briefings ORDER BY generated_at DESC LIMIT ?', limit).map(mapBriefing);
}

export function listUpdates(db: Db, limit = 48): UpdateReportDto[] {
  return db
    .all('SELECT * FROM updates ORDER BY slot_key DESC LIMIT ?', limit)
    .map((r) => ({ slotKey: String(r.slot_key), createdAt: String(r.created_at), report: j(r.report_json) }));
}

export function listReactions(db: Db, limit = 20): ReactionDto[] {
  return db.all('SELECT * FROM eia_reactions ORDER BY release_date DESC LIMIT ?', limit).map((r) => j<ReactionDto>(r.report_json));
}
