// Durable ledger storage on Node's built-in SQLite (node:sqlite). Every trade, quote, mark,
// order and history event is persisted so restarts never erase state. Uniqueness constraints
// (idempotency keys, job keys, dedupe keys) make retried work a no-op instead of a duplicate.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  starting_equity REAL NOT NULL,
  peak_equity REAL NOT NULL,
  peak_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','halted','archived')),
  halted_at TEXT,
  halted_reason TEXT
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract TEXT NOT NULL,
  price REAL NOT NULL,
  unit TEXT NOT NULL,
  source TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('manual','api')),
  provider TEXT NOT NULL,
  provider_symbol TEXT,
  delay_minutes REAL,
  exchange_ts TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  basis TEXT,
  note TEXT,
  UNIQUE (contract, provider, exchange_ts, price)
);
CREATE INDEX IF NOT EXISTS quotes_contract_ts ON quotes(contract, exchange_ts);

CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  strategy TEXT NOT NULL,
  label TEXT NOT NULL,
  direction INTEGER NOT NULL CHECK (direction IN (1,-1)),
  legs_json TEXT NOT NULL,
  contracts_per_leg INTEGER NOT NULL CHECK (contracts_per_leg > 0),
  barrels REAL NOT NULL,
  entry_value REAL NOT NULL,
  entry_fills_json TEXT,
  entry_kind TEXT NOT NULL CHECK (entry_kind IN ('seed','order')),
  entry_note TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  order_id INTEGER UNIQUE,
  rationale TEXT,
  exit_rule_text TEXT,
  exit_rules_json TEXT NOT NULL,
  entry_commission REAL,
  status TEXT NOT NULL CHECK (status IN ('open','exit_pending','closed')),
  exit_pending_json TEXT,
  closed_at TEXT,
  exit_value REAL,
  exit_fills_json TEXT,
  exit_reason TEXT,
  exit_kind TEXT,
  exit_commission REAL,
  realized_gross REAL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  submitted_at TEXT NOT NULL,
  trade_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('rejected','working','filled','cancelled','expired')),
  request_json TEXT NOT NULL,
  reasons_json TEXT,
  margin_json TEXT,
  position_id INTEGER,
  expires_at TEXT,
  updated_at TEXT NOT NULL,
  fill_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT,
  dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

CREATE TABLE IF NOT EXISTS marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  ts TEXT NOT NULL,
  trigger TEXT NOT NULL,
  valid INTEGER NOT NULL,
  equity REAL NOT NULL,
  unrealized REAL,
  realized REAL NOT NULL,
  fees REAL NOT NULL,
  peak_equity REAL NOT NULL,
  drawdown_pct REAL NOT NULL,
  reserved_margin REAL,
  buying_power REAL,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS marks_ts ON marks(ts);

CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scheduled_for TEXT,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS jobs_kind ON jobs(kind, scheduled_for);

CREATE TABLE IF NOT EXISTS updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_key TEXT NOT NULL UNIQUE,
  account_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS margins (
  key TEXT PRIMARY KEY,
  per_unit_usd REAL NOT NULL CHECK (per_unit_usd > 0),
  source TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  entered_at TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS inventories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series TEXT NOT NULL,
  week_ending TEXT NOT NULL,
  level_kb REAL,
  change_kb REAL,
  kind TEXT NOT NULL CHECK (kind IN ('actual','estimate','api')),
  source TEXT NOT NULL,
  released_at TEXT,
  entered_at TEXT NOT NULL,
  UNIQUE (series, week_ending, kind, source)
);

CREATE TABLE IF NOT EXISTS eia_releases (
  release_date TEXT PRIMARY KEY,
  release_utc TEXT NOT NULL,
  week_ending TEXT NOT NULL,
  data_arrived_at TEXT,
  arrival_source TEXT,
  status TEXT NOT NULL,
  detail_json TEXT
);

CREATE TABLE IF NOT EXISTS eia_reactions (
  release_date TEXT PRIMARY KEY,
  release_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finalized_at TEXT,
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS briefings (
  key TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scheduled_for TEXT,
  generated_at TEXT NOT NULL,
  content_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fx_rates (
  pair TEXT NOT NULL,
  as_of_date TEXT NOT NULL,
  rate REAL NOT NULL,
  source TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (pair, as_of_date, source)
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('watch-only','note')),
  title TEXT NOT NULL,
  body TEXT,
  archived INTEGER NOT NULL DEFAULT 0
);
`;

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  /** Run fn atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const name = `sp${this.depth}`;
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE');
    else this.raw.exec(`SAVEPOINT ${name}`);
    this.depth++;
    try {
      const out = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec('COMMIT');
      else this.raw.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      this.depth--;
      if (this.depth === 0) this.raw.exec('ROLLBACK');
      else this.raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
      throw err;
    }
  }

  getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  }

  close(): void {
    this.raw.close();
  }
}
