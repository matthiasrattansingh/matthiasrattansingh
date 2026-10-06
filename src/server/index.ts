// Entry point: open the ledger, seed on first run, start the in-process scheduler and serve the
// API + dashboard. This app never connects to a broker and never sends a real order.
import { join, resolve } from 'node:path';
import { Db } from './db.ts';
import { readEnv } from './settings.ts';
import { seedIfEmpty } from './seed.ts';
import { Scheduler } from './scheduler.ts';
import { createHttpApp } from './http.ts';
import type { AppContext } from './context.ts';

const dataDir = resolve(process.env.DATA_DIR ?? 'data');
const db = new Db(join(dataDir, 'paper-trading.sqlite'));
const env = readEnv();
const log = (msg: string, extra?: unknown) => console.log(`[${new Date().toISOString()}] ${msg}`, extra ?? '');

const app: AppContext = { db, env, now: () => Date.now(), fetchImpl: globalThis.fetch, scheduler: null, log };

if (seedIfEmpty(db, app.now())) log('Seeded paper account ($100,000) and the HOX2026/BZZ2026 crack position.');

const scheduler = new Scheduler(app);
app.scheduler = scheduler;
if (process.env.DISABLE_SCHEDULER !== '1') scheduler.start();
else log('Scheduler disabled via DISABLE_SCHEDULER=1 — no hourly marks, briefings or EIA captures will run.');

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !env.basicAuth) {
  log(`WARNING: listening on ${host} without APP_BASIC_AUTH. Anyone who can reach this port can change the paper ledger.`);
}
const server = createHttpApp(app).listen(port, host, () => log(`Paper trader listening on http://${host}:${port} (data: ${dataDir})`));

const shutdown = () => {
  scheduler.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
