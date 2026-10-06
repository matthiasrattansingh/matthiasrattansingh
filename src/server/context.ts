import type { Db } from './db.ts';
import type { Env } from './settings.ts';

export interface SchedulerHandle {
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
}

export interface AppContext {
  db: Db;
  env: Env;
  now: () => number;
  fetchImpl: typeof fetch;
  scheduler: SchedulerHandle | null;
  log: (msg: string, extra?: unknown) => void;
}
