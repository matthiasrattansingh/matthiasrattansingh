// HTTP API + static dashboard.
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import type { AppSettings, MarkPointDto, OrderRequestDto, StateDto } from '../shared/types.ts';
import type { AppContext } from './context.ts';
import * as repo from './repo.ts';
import { diffSettings, loadSettings, saveSettings, validateSettings } from './settings.ts';
import { cancelOrder, evaluate, HttpError, iso, requestClose } from './engine.ts';
import { previewOrder, recordPass, submitOrder } from './orders.ts';
import { enterManualQuotes, type ManualQuoteInput } from './quotes.ts';
import { getProvider } from './providers/index.ts';
import { buildSnapshot, inventorySummary } from './market.ts';
import { captureReaction, refreshQuotes, runBriefing, schedulerStatus } from './scheduler.ts';
import { valuate } from './valuation.ts';
import { ensureRelease, fetchEiaWeekly, ingestInventories, manualInventoryRows, type ManualInventoryInput } from './eia.ts';
import { FX_META, fetchFx, fxRows } from './fx.ts';
import { startNewAccount } from './seed.ts';
import { activeContracts, contractLabel, isContractCode, lastTradingDay, PRODUCTS, tradingViewSymbol, type ProductCode } from '../domain/contracts.ts';
import { eiaReleaseForWeek, etDate } from '../domain/calendar.ts';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(here, '..', '..', 'web', 'dist');

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res))
      .then((out) => {
        if (!res.headersSent) res.json(out ?? { ok: true });
      })
      .catch(next);
  };

export function buildState(app: AppContext): StateDto {
  const { db } = app;
  const nowMs = app.now();
  const settings = loadSettings(db);
  const v = valuate(db, nowMs, settings);
  const provider = getProvider(settings.provider);
  const pStatus = provider.status(app.env, settings);
  const lastMarkRow = db.get<{ ts: string; trigger: string; valid: number }>('SELECT ts, trigger, valid FROM marks ORDER BY id DESC LIMIT 1');
  const lastFetch = db.getMeta('lastFetch');
  const lastOk = db.getMeta('lastSuccessfulFetch');
  const today = etDate(nowMs);
  const decision = repo.listEvents(db, { limit: 50 }).find((e) => (e.type === 'decision.pass' || e.type === 'order.accepted') && etDate(e.ts) === today);
  const warnings: string[] = [];
  if (v.account.status === 'halted') warnings.push(`Trading halted: ${v.account.halted_reason}`);
  if (v.accountDto.provisionalBreach) warnings.push('Provisional equity is at/below the drawdown floor; liquidation waits for valid marks on every leg.');
  if (!v.accountDto.buyingPower.verified) warnings.push('Buying power unverified — new orders are blocked until marks are valid and margin figures are entered.');
  if (!pStatus.configured) warnings.push(`Market-data provider not ready: ${pStatus.reason}`);
  else if (pStatus.reason) warnings.push(pStatus.reason);
  const contracts = new Map<string, NonNullable<StateDto['contracts']>[number]>();
  for (const m of v.contractCache.values()) contracts.set(m.contract, m);
  return {
    now: iso(nowMs),
    account: v.accountDto,
    positions: v.positions,
    closedPositions: repo.closedPositions(db, v.account.id, 50),
    workingOrders: v.workingOrders,
    contracts: [...contracts.values()],
    settings,
    secrets: { databento: !!app.env.databentoKey, customHttp: !!app.env.customQuoteKey, eia: !!app.env.eiaKey, basicAuth: !!app.env.basicAuth },
    provider: {
      id: provider.id,
      label: provider.label,
      configured: pStatus.configured,
      reason: pStatus.reason,
      kind: provider.kind,
      lastFetch: lastFetch
        ? (() => {
            const f = JSON.parse(lastFetch);
            return { key: 'lastFetch', kind: 'fetch', scheduledFor: f.at, status: f.ok ? 'ok' : 'failed', attempts: 1, startedAt: f.at, finishedAt: f.at, detail: f };
          })()
        : null,
    },
    scheduler: schedulerStatus(app),
    lastMark: lastMarkRow ? { ts: lastMarkRow.ts, trigger: lastMarkRow.trigger, valid: !!lastMarkRow.valid } : null,
    lastSuccessfulRefresh: lastOk ? JSON.parse(lastOk).at : null,
    warnings,
    tradesToday: repo.tradesOnDate(db, v.account.id, today),
    decisionToday: decision ? { type: decision.type, ts: decision.ts, summary: decision.summary } : null,
    watchItems: repo.listNotes(db, 'watch-only'),
  };
}

function basicAuth(expected: string) {
  const want = Buffer.from(expected);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const got = header.startsWith('Basic ') ? Buffer.from(Buffer.from(header.slice(6), 'base64').toString()) : Buffer.alloc(0);
    if (got.length === want.length && timingSafeEqual(got, want)) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="paper-trader"');
    res.status(401).send('Authentication required');
  };
}

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);

export function createHttpApp(app: AppContext): express.Express {
  const { db } = app;
  const server = express();
  server.disable('x-powered-by');
  if (app.env.basicAuth) server.use(basicAuth(app.env.basicAuth));
  server.use(express.json({ limit: '200kb' }));

  server.get('/api/health', h(() => ({ ok: true, now: iso(app.now()) })));
  server.get('/api/state', h(() => buildState(app)));
  server.get('/api/snapshot', h(() => buildSnapshot(db, app.now(), { eia: !!app.env.eiaKey })));

  server.get(
    '/api/contracts',
    h(() => {
      const asOf = etDate(app.now());
      return (Object.keys(PRODUCTS) as ProductCode[]).map((p) => ({
        product: p,
        name: PRODUCTS[p].name,
        unit: PRODUCTS[p].unit,
        kind: PRODUCTS[p].kind,
        contractSize: `${PRODUCTS[p].contractSize.toLocaleString('en-US')} ${PRODUCTS[p].contractSizeUnit}`,
        tickSize: PRODUCTS[p].tickSize,
        expiryRule: PRODUCTS[p].expiryRule,
        contracts: activeContracts(p, asOf, 12).map((c, i) => ({ code: c, label: contractLabel(c), lastTradingDay: lastTradingDay(c), position: `M${i + 1}`, tradingView: tradingViewSymbol(c) })),
      }));
    }),
  );

  // --- Quotes -------------------------------------------------------------
  server.get('/api/quotes', h((req) => repo.recentQuotes(db, num(req.query.limit, 100), typeof req.query.contract === 'string' ? req.query.contract.toUpperCase() : undefined)));
  server.post(
    '/api/quotes',
    h((req, res) => {
      const body = req.body as { quotes: ManualQuoteInput[]; dryRun?: boolean; confirmLargeMoves?: boolean };
      const out = enterManualQuotes(db, body.quotes, app.now(), { dryRun: !!body.dryRun, confirmLargeMoves: !!body.confirmLargeMoves });
      if (out.issues.length) res.status(422);
      return { ...out, evaluation: out.evaluation ? { actions: out.evaluation.actions } : null };
    }),
  );
  server.post(
    '/api/refresh',
    h(async () => {
      const fetch = await refreshQuotes(app, 'manual-refresh');
      const ev = evaluate(db, app.now(), 'manual-refresh');
      return { fetch, actions: ev.actions };
    }),
  );

  // --- Orders & positions ---------------------------------------------------
  server.post('/api/orders/preview', h((req) => previewOrder(db, req.body as OrderRequestDto, app.now()).preview));
  server.post(
    '/api/orders',
    h((req, res) => {
      const out = submitOrder(db, req.body as OrderRequestDto, app.now());
      if (!out.duplicate) res.status(out.order.status === 'rejected' ? 422 : 201);
      return out;
    }),
  );
  server.get('/api/orders', h(() => repo.recentOrders(db, repo.currentAccount(db).id, 100)));
  server.post('/api/orders/:id/cancel', h((req) => cancelOrder(db, Number(req.params.id), app.now())));
  server.post(
    '/api/positions/:id/close',
    h((req) => {
      const ev = requestClose(db, Number(req.params.id), app.now(), String((req.body as { note?: string })?.note ?? '').slice(0, 500));
      return { actions: ev.actions, position: repo.positionById(db, Number(req.params.id)) };
    }),
  );
  server.post('/api/decisions/pass', h((req) => recordPass(db, String((req.body as { note?: string })?.note ?? '').slice(0, 500), app.now())));

  // --- History ------------------------------------------------------------------
  server.get('/api/history', h((req) => repo.listEvents(db, { limit: num(req.query.limit, 300), type: typeof req.query.type === 'string' ? req.query.type : undefined })));
  server.get('/api/updates', h((req) => repo.listUpdates(db, num(req.query.limit, 48))));
  server.get(
    '/api/marks',
    h((req) => {
      const rows = db.all<{ ts: string; trigger: string; valid: number; equity: number; drawdown_pct: number; detail_json: string }>(
        'SELECT ts, trigger, valid, equity, drawdown_pct, detail_json FROM marks WHERE account_id = ? ORDER BY id DESC LIMIT ?',
        repo.currentAccount(db).id,
        num(req.query.limit, 500),
      );
      return rows.reverse().map<MarkPointDto>((r) => {
        const d = JSON.parse(r.detail_json) as { positions: { id: number; value: number | null }[] };
        return { ts: r.ts, trigger: r.trigger, valid: !!r.valid, equity: r.equity, drawdownPct: r.drawdown_pct, values: Object.fromEntries(d.positions.map((p) => [String(p.id), p.value])) };
      });
    }),
  );
  server.get('/api/jobs', h((req) => db.all('SELECT * FROM jobs ORDER BY COALESCE(finished_at, started_at, scheduled_for) DESC LIMIT ?', num(req.query.limit, 100)).map((r) => repo.mapJob(r))));

  // --- Briefings ----------------------------------------------------------------
  server.get('/api/briefings', h((req) => repo.listBriefings(db, num(req.query.limit, 10))));
  server.post('/api/briefings', h(() => runBriefing(app, 'adhoc')));

  // --- Settings & margins ----------------------------------------------------------
  server.get('/api/settings', h(() => ({ settings: loadSettings(db), secrets: buildState(app).secrets })));
  server.put(
    '/api/settings',
    h((req, res) => {
      const current = loadSettings(db);
      const next = { ...current, ...(req.body as Partial<AppSettings>), customHttp: { ...current.customHttp, ...((req.body as Partial<AppSettings>).customHttp ?? {}) } };
      const errors = validateSettings(next);
      if (errors.length) {
        res.status(422);
        return { errors };
      }
      const changes = diffSettings(current, next);
      if (changes.length) {
        db.tx(() => {
          saveSettings(db, next, iso(app.now()));
          repo.addEvent(db, { ts: iso(app.now()), type: 'settings.changed', summary: `Settings changed: ${changes.join('; ')}`, detail: { changes } });
        });
      }
      return { settings: next, changes };
    }),
  );
  server.get('/api/margins', h(() => repo.listMargins(db)));
  server.put(
    '/api/margins',
    h((req, res) => {
      const b = req.body as { key: string; perUnitUsd: number; source: string; asOfDate: string; note?: string };
      const key = String(b.key ?? '').trim().toUpperCase();
      const errors: string[] = [];
      const isSpread = /^SPREAD:[A-Z0-9]+(\+[A-Z0-9]+)+$/.test(key);
      if (!isContractCode(key) && !isSpread) errors.push('Key must be an exact contract (e.g. HOX2026) or a spread key such as SPREAD:BZZ2026+HOX2026.');
      if (!(Number(b.perUnitUsd) > 0)) errors.push('Initial margin must be a positive dollar amount per contract (or per spread unit).');
      if (!b.source || String(b.source).trim().length < 3) errors.push('Source is required (e.g. "CME Group margins page" or "Broker margin schedule").');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.asOfDate ?? ''))) errors.push('As-of date must be YYYY-MM-DD.');
      else if (b.asOfDate > etDate(app.now())) errors.push('As-of date cannot be in the future.');
      if (errors.length) {
        res.status(422);
        return { errors };
      }
      db.tx(() => {
        repo.upsertMargin(db, { key, perUnitUsd: Number(b.perUnitUsd), source: String(b.source).trim(), asOfDate: b.asOfDate, enteredAt: iso(app.now()), note: b.note ?? null });
        repo.addEvent(db, { ts: iso(app.now()), type: 'margin.updated', summary: `Initial margin for ${key}: $${Number(b.perUnitUsd).toLocaleString('en-US')} (source: ${b.source}, as of ${b.asOfDate}).` });
        evaluate(db, app.now(), 'margin-update', { recordMark: false });
      });
      return repo.listMargins(db);
    }),
  );
  server.delete(
    '/api/margins/:key',
    h((req) => {
      const key = String(req.params.key).toUpperCase();
      db.tx(() => {
        db.run('DELETE FROM margins WHERE key = ?', key);
        repo.addEvent(db, { ts: iso(app.now()), type: 'margin.removed', summary: `Initial margin figure removed for ${key}.` });
      });
      return repo.listMargins(db);
    }),
  );

  // --- EIA ------------------------------------------------------------------------
  server.get(
    '/api/eia',
    h(() => {
      const settings = loadSettings(db);
      const rel = eiaReleaseForWeek(etDate(app.now()), settings.eiaOverrides);
      if (rel) ensureRelease(db, rel);
      return {
        summary: inventorySummary(db, app.now(), settings),
        inventories: repo.listInventories(db, 16),
        releases: db.all('SELECT * FROM eia_releases ORDER BY release_date DESC LIMIT 12'),
        reactions: repo.listReactions(db, 12),
        apiKeyConfigured: !!app.env.eiaKey,
      };
    }),
  );
  server.post(
    '/api/eia/inventories',
    h((req, res) => {
      const { rows, errors } = manualInventoryRows(req.body as ManualInventoryInput, app.now());
      if (errors.length) {
        res.status(422);
        return { errors };
      }
      const out = ingestInventories(db, rows, app.now(), 'manual entry');
      repo.addEvent(db, { ts: iso(app.now()), type: 'eia.manual', summary: `Inventory figures entered (${rows[0].kind}) for week ending ${rows[0].weekEnding}: ${rows.map((r) => `${r.series} ${r.levelKb ?? ''}${r.changeKb !== null ? ` Δ${r.changeKb}` : ''}`).join(', ')}.` });
      return out;
    }),
  );
  server.post(
    '/api/eia/refresh',
    h(async (req, res) => {
      const r = await fetchEiaWeekly(app, 12);
      if (r.errors.length && !r.rows.length) {
        res.status(502);
        return { errors: r.errors };
      }
      return { ...ingestInventories(db, r.rows, app.now(), 'EIA API (manual refresh)'), errors: r.errors };
    }),
  );
  server.post(
    '/api/eia/reactions/:date/recompute',
    h(async (req) => {
      const date = String(req.params.date);
      const settings = loadSettings(db);
      const rel = eiaReleaseForWeek(date, settings.eiaOverrides);
      if (!rel) throw new HttpError(404, 'No EIA release that week.');
      ensureRelease(db, rel);
      if (app.now() < Date.parse(rel.releaseUtc) + 15 * 60_000) throw new HttpError(409, 'The 15-minute reaction window has not closed yet.');
      return (await captureReaction(app, rel.releaseDate)).reaction;
    }),
  );

  // --- FX ---------------------------------------------------------------------------
  server.get('/api/fx', h(() => fxRows(db, loadSettings(db).fxPairs)));
  server.post('/api/fx/refresh', h(() => fetchFx(app, loadSettings(db).fxPairs)));
  server.post(
    '/api/fx',
    h((req, res) => {
      const b = req.body as { pair: string; asOfDate: string; rate: number; source: string };
      const errors: string[] = [];
      if (!FX_META[b.pair]) errors.push('Unknown pair.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.asOfDate ?? ''))) errors.push('As-of date must be YYYY-MM-DD.');
      if (!(Number(b.rate) > 0)) errors.push('Rate must be positive.');
      if (!b.source) errors.push('Source is required.');
      if (errors.length) {
        res.status(422);
        return { errors };
      }
      repo.upsertFx(db, { pair: b.pair, asOfDate: b.asOfDate, rate: Number(b.rate), source: `${b.source} (manual)`, observedAt: iso(app.now()) });
      return fxRows(db, loadSettings(db).fxPairs);
    }),
  );

  // --- Notes & watch-only items -------------------------------------------------------
  server.get('/api/notes', h(() => repo.listNotes(db)));
  server.post(
    '/api/notes',
    h((req, res) => {
      const b = req.body as { kind?: string; title?: string; body?: string };
      const kind = b.kind === 'watch-only' ? 'watch-only' : 'note';
      if (!b.title || !String(b.title).trim()) {
        res.status(422);
        return { errors: ['Title is required.'] };
      }
      db.run('INSERT INTO notes (created_at, kind, title, body) VALUES (?, ?, ?, ?)', iso(app.now()), kind, String(b.title).slice(0, 200), b.body ? String(b.body).slice(0, 4000) : null);
      return repo.listNotes(db);
    }),
  );
  server.put(
    '/api/notes/:id',
    h((req) => {
      const b = req.body as { title?: string; body?: string };
      db.run('UPDATE notes SET title = COALESCE(?, title), body = ? WHERE id = ?', b.title ? String(b.title).slice(0, 200) : null, b.body ? String(b.body).slice(0, 4000) : null, Number(req.params.id));
      return repo.listNotes(db);
    }),
  );
  server.delete(
    '/api/notes/:id',
    h((req) => {
      db.run('UPDATE notes SET archived = 1 WHERE id = ?', Number(req.params.id));
      return repo.listNotes(db);
    }),
  );

  // --- Account ------------------------------------------------------------------------
  server.post(
    '/api/account/new',
    h((req) => {
      if ((req.body as { confirm?: string })?.confirm !== 'START NEW ACCOUNT') throw new HttpError(400, 'Type START NEW ACCOUNT to confirm.');
      try {
        return { accountId: startNewAccount(db, app.now()) };
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    }),
  );

  server.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (existsSync(WEB_DIST)) {
    server.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    server.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(join(WEB_DIST, 'index.html')));
  } else {
    server.get('/', (_req, res) => res.type('text').send('Dashboard not built. Run `npm run build` (or `npm run dev` for development).'));
  }

  server.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, details: err.details });
      return;
    }
    if (err instanceof SyntaxError && 'body' in (err as object)) {
      res.status(400).json({ error: 'Malformed JSON body.' });
      return;
    }
    app.log(`unhandled error: ${(err as Error)?.stack ?? err}`);
    res.status(500).json({ error: (err as Error)?.message ?? 'Internal error' });
  });

  return server;
}
