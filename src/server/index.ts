// Entry point: open the ledger, seed on first run, start the in-process scheduler and serve the
// API + dashboard. This app never connects to a broker and never sends a real order.
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { Db } from './db.ts';
import { readEnv } from './settings.ts';
import { seedIfEmpty } from './seed.ts';
import { Scheduler } from './scheduler.ts';
import { createHttpApp } from './http.ts';
import type { AppContext } from './context.ts';

const log = (msg: string, extra?: unknown) => console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? '');
const dataDir = resolve(process.env.DATA_DIR ?? 'data');
mkdirSync(dataDir, { recursive: true });

// One process per ledger: a second instance would run a second scheduler against the same data.
const lockPath = join(dataDir, 'paper-trading.lock');
try {
  const other = Number(readFileSync(lockPath, 'utf8'));
  if (other && other !== process.pid) {
    process.kill(other, 0); // throws if that process no longer exists
    console.error(`Another instance (pid ${other}) is already using ${dataDir}. Stop it first, or set DATA_DIR to a different directory.`);
    process.exit(1);
  }
} catch {
  /* no lock, or a stale lock from a process that has exited */
}
writeFileSync(lockPath, String(process.pid));
const releaseLock = () => {
  try {
    if (Number(readFileSync(lockPath, 'utf8')) === process.pid) rmSync(lockPath);
  } catch {
    /* already gone */
  }
};

const db = new Db(join(dataDir, 'paper-trading.sqlite'));
const env = readEnv();
const app: AppContext = { db, env, now: () => Date.now(), fetchImpl: globalThis.fetch, scheduler: null, log };

if (seedIfEmpty(db, app.now())) log('Seeded paper account ($100,000) and the HOX2026/BZZ2026 crack position.');

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !env.basicAuth) {
  log(`WARNING: listening on ${host} without APP_BASIC_AUTH. Anyone who can reach this port can change the paper ledger.`);
}

const scheduler = new Scheduler(app);
app.scheduler = scheduler;

// Express 5 passes listen errors (e.g. EADDRINUSE) to this callback.
const server = createHttpApp(app).listen(port, host, (err?: Error) => {
  if (err) {
    console.error(`Could not listen on ${host}:${port}: ${err.message}`);
    releaseLock();
    db.close();
    process.exit(1);
  }
  log(`Paper trader listening on http://${host}:${port} (data: ${dataDir})`);
  if (process.env.DISABLE_SCHEDULER !== '1') scheduler.start();
  else log('Scheduler disabled via DISABLE_SCHEDULER=1 — no hourly marks, briefings or EIA captures will run.');
});

const shutdown = () => {
  scheduler.stop();
  server.close(() => {
    db.close();
    releaseLock();
    process.exit(0);
  });
  setTimeout(() => {
    releaseLock();
    process.exit(0);
  }, 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
