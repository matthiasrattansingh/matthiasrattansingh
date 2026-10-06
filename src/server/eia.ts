// EIA Weekly Petroleum Status Report: fetch (EIA Open Data API v2), manual entry, release
// tracking and the 0–15 minute post-release market reaction.
//
// The reaction is computed only from quotes actually recorded for the exact contracts, using
// exchange timestamps: the last quote at/before the release time versus the quote at the end of
// the 15-minute window. Nothing is estimated or pre-selected; gaps are reported as gaps.
import type { InventoryDto, ReactionDto, ReactionLegDto } from '../shared/types.ts';
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import { evaluate, iso } from './engine.ts';
import type { AppContext } from './context.ts';
import { activeContracts, toPerBarrel } from '../domain/contracts.ts';
import { addDays, eiaReleaseForWeek, etDate, type EiaRelease } from '../domain/calendar.ts';
import { loadSettings } from './settings.ts';
import { redact } from './providers/util.ts';
import { strategyValue } from '../domain/pnl.ts';

export const EIA_SERIES: Record<string, { id: string; label: string }> = {
  distillate: { id: 'WDISTUS1', label: 'U.S. distillate fuel oil stocks' },
  crude: { id: 'WCESTUS1', label: 'U.S. commercial crude oil stocks (ex-SPR)' },
  gasoline: { id: 'WGTSTUS1', label: 'U.S. total motor gasoline stocks' },
  cushing: { id: 'W_EPC0_SAX_YCUOK_MBBL', label: 'Cushing, OK crude oil stocks' },
};

export const EIA_SOURCE = 'EIA WPSR via EIA Open Data API v2';

export async function fetchEiaWeekly(ctx: AppContext, weeks = 12): Promise<{ rows: Omit<InventoryDto, 'id'>[]; errors: string[] }> {
  const key = ctx.env.eiaKey;
  if (!key) return { rows: [], errors: ['EIA_API_KEY is not set; enter WPSR figures manually on the EIA page.'] };
  const params = new URLSearchParams();
  params.set('api_key', key);
  params.set('frequency', 'weekly');
  params.append('data[0]', 'value');
  for (const s of Object.values(EIA_SERIES)) params.append('facets[series][]', s.id);
  params.set('sort[0][column]', 'period');
  params.set('sort[0][direction]', 'desc');
  params.set('offset', '0');
  params.set('length', String(weeks * Object.keys(EIA_SERIES).length));
  const url = `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?${params.toString()}`;
  try {
    const res = await ctx.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return { rows: parseEiaResponse(JSON.parse(text), iso(ctx.now())), errors: [] };
  } catch (e) {
    return { rows: [], errors: [redact(`EIA fetch failed: ${(e as Error).message}`, [key])] };
  }
}

export function parseEiaResponse(json: unknown, enteredAt: string): Omit<InventoryDto, 'id'>[] {
  const data = (json as { response?: { data?: { period: string; series: string; value: unknown }[] } }).response?.data ?? [];
  const byId = new Map(Object.entries(EIA_SERIES).map(([name, s]) => [s.id, name]));
  const rows: Omit<InventoryDto, 'id'>[] = [];
  for (const d of data) {
    const series = byId.get(d.series);
    const level = Number(d.value);
    if (!series || !/^\d{4}-\d{2}-\d{2}$/.test(d.period) || !Number.isFinite(level)) continue;
    const rel = eiaReleaseForWeek(addDays(d.period, 5));
    rows.push({
      series,
      weekEnding: d.period,
      levelKb: level,
      changeKb: null,
      kind: 'actual',
      source: `${EIA_SOURCE} (${d.series})`,
      releasedAt: rel?.releaseUtc ?? null,
      enteredAt,
    });
  }
  return rows;
}

export function ensureRelease(db: Db, rel: EiaRelease): void {
  db.run(
    "INSERT OR IGNORE INTO eia_releases (release_date, release_utc, week_ending, status) VALUES (?, ?, ?, 'scheduled')",
    rel.releaseDate,
    rel.releaseUtc,
    rel.weekEnding,
  );
}

export function releaseRow(db: Db, releaseDate: string): { release_date: string; release_utc: string; week_ending: string; data_arrived_at: string | null; arrival_source: string | null; status: string } | undefined {
  return db.get('SELECT * FROM eia_releases WHERE release_date = ?', releaseDate);
}

/** Store inventory rows; when the expected week of the current release appears, record its arrival. */
export function ingestInventories(db: Db, rows: Omit<InventoryDto, 'id'>[], nowMs: number, arrivalSource: string): { changed: number; arrived: string | null } {
  return db.tx(() => {
    let changed = 0;
    for (const r of rows) if (repo.upsertInventory(db, r)) changed++;
    let arrived: string | null = null;
    const settings = loadSettings(db);
    const rel = eiaReleaseForWeek(etDate(nowMs), settings.eiaOverrides);
    if (rel && nowMs >= Date.parse(rel.releaseUtc)) {
      ensureRelease(db, rel);
      const hasWeek = rows.some((r) => r.kind === 'actual' && r.weekEnding === rel.weekEnding && (r.series === 'distillate' || r.series === 'crude'));
      const row = releaseRow(db, rel.releaseDate);
      if (hasWeek && row && !row.data_arrived_at) {
        const at = iso(nowMs);
        db.run("UPDATE eia_releases SET data_arrived_at = ?, arrival_source = ?, status = 'arrived' WHERE release_date = ?", at, arrivalSource, rel.releaseDate);
        repo.addEvent(db, {
          ts: at,
          type: 'eia.arrived',
          summary: `EIA WPSR data for week ending ${rel.weekEnding} recorded at ${at} (${arrivalSource}); scheduled release ${rel.releaseDate} ${rel.timeEt} ET.`,
          dedupeKey: `eia-arrived:${rel.releaseDate}`,
        });
        arrived = rel.releaseDate;
      }
    }
    if (changed) evaluate(db, nowMs, 'eia-data');
    return { changed, arrived };
  });
}

export interface ManualInventoryInput {
  weekEnding: string;
  kind: 'actual' | 'estimate' | 'api';
  source?: string;
  values: { series: string; levelKb?: number | null; changeKb?: number | null }[];
}

export function manualInventoryRows(input: ManualInventoryInput, nowMs: number): { rows: Omit<InventoryDto, 'id'>[]; errors: string[] } {
  const errors: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.weekEnding)) errors.push('Week ending must be YYYY-MM-DD (a Friday).');
  else if (new Date(`${input.weekEnding}T12:00:00Z`).getUTCDay() !== 5) errors.push('EIA weeks end on a Friday.');
  if (!['actual', 'estimate', 'api'].includes(input.kind)) errors.push('Kind must be actual, estimate or api.');
  const defaultSource = input.kind === 'actual' ? 'EIA WPSR (user-entered)' : input.kind === 'api' ? 'API weekly statistics (user-entered from reports)' : 'Analyst consensus estimate (user-entered)';
  const rows: Omit<InventoryDto, 'id'>[] = [];
  for (const v of input.values ?? []) {
    if (!EIA_SERIES[v.series]) {
      errors.push(`Unknown series ${v.series}.`);
      continue;
    }
    const level = v.levelKb === null || v.levelKb === undefined || (v.levelKb as unknown) === '' ? null : Number(v.levelKb);
    const change = v.changeKb === null || v.changeKb === undefined || (v.changeKb as unknown) === '' ? null : Number(v.changeKb);
    if (level === null && change === null) continue;
    if ((level !== null && !Number.isFinite(level)) || (change !== null && !Number.isFinite(change))) {
      errors.push(`${v.series}: values must be numbers (thousand barrels).`);
      continue;
    }
    if (input.kind !== 'actual' && level !== null && change === null) {
      errors.push(`${v.series}: estimates/API figures are entered as week-over-week changes.`);
      continue;
    }
    const rel = /^\d{4}-\d{2}-\d{2}$/.test(input.weekEnding) ? eiaReleaseForWeek(addDays(input.weekEnding, 5)) : null;
    rows.push({
      series: v.series,
      weekEnding: input.weekEnding,
      levelKb: level,
      changeKb: change,
      kind: input.kind,
      source: input.source?.trim() || defaultSource,
      releasedAt: input.kind === 'actual' ? (rel?.releaseUtc ?? null) : null,
      enteredAt: iso(nowMs),
    });
  }
  if (!rows.length && !errors.length) errors.push('Enter at least one level or change.');
  return { rows, errors };
}

// ---------------------------------------------------------------------------
// 0–15 minute reaction
// ---------------------------------------------------------------------------

export const REACTION_WINDOW_MIN = 15;
const PRE_LOOKBACK_MIN = 30;
const POST_TOLERANCE_MIN = 2;

export function reactionContracts(db: Db, releaseDate: string): string[] {
  const set = new Set<string>();
  const account = repo.currentAccount(db);
  for (const p of repo.openPositions(db, account.id)) for (const l of p.legs) set.add(l.contract);
  for (const prod of ['BZ', 'HO', 'CL', 'RB'] as const) set.add(activeContracts(prod, releaseDate, 1)[0]);
  return [...set];
}

export function computeReaction(db: Db, releaseDate: string, nowMs: number): ReactionDto {
  const rel = releaseRow(db, releaseDate);
  if (!rel) throw new Error(`No EIA release recorded for ${releaseDate}`);
  const releaseMs = Date.parse(rel.release_utc);
  const windowEndMs = releaseMs + REACTION_WINDOW_MIN * 60_000;
  const releaseIso = iso(releaseMs);
  const windowEndIso = iso(windowEndMs);
  const contracts = reactionContracts(db, releaseDate);
  const legs: ReactionLegDto[] = contracts.map((c) => {
    const preQ = repo.latestQuote(db, c, releaseIso);
    const pre = preQ && releaseMs - Date.parse(preQ.exchangeTs) <= PRE_LOOKBACK_MIN * 60_000 ? preQ : null;
    const inWindow = repo.quotesBetween(db, c, releaseIso, windowEndIso);
    const lastIn = inWindow[inWindow.length - 1] ?? null;
    const post = lastIn && windowEndMs - Date.parse(lastIn.exchangeTs) <= POST_TOLERANCE_MIN * 60_000 ? lastIn : null;
    const prices = inWindow.map((q) => q.price);
    const notes: string[] = [];
    if (!pre) notes.push(preQ ? `latest pre-release quote is ${Math.round((releaseMs - Date.parse(preQ.exchangeTs)) / 60_000)} min before release (limit ${PRE_LOOKBACK_MIN})` : 'no quote at/before release');
    if (!post) notes.push(lastIn ? `latest in-window quote at +${Math.round((Date.parse(lastIn.exchangeTs) - releaseMs) / 60_000)} min; none within ${POST_TOLERANCE_MIN} min of +15` : 'no quote inside the 0–15 min window');
    const change = pre && post ? post.price - pre.price : null;
    return {
      contract: c,
      pre: pre ? { price: pre.price, exchangeTs: pre.exchangeTs, source: pre.source } : null,
      post: post ? { price: post.price, exchangeTs: post.exchangeTs, source: post.source } : null,
      inWindow: { count: inWindow.length, high: prices.length ? Math.max(...prices) : null, low: prices.length ? Math.min(...prices) : null },
      change,
      changePerBbl: change === null ? null : toPerBarrel(c, change),
      note: notes.length ? notes.join('; ') : 'pre and +15 min quotes captured',
    };
  });
  // Crack reaction for each open crack position, else HO M1 vs BZ M1.
  const account = repo.currentAccount(db);
  const crackPos = repo.openPositions(db, account.id).find((p) => p.strategy === 'crack');
  const crackLegs = crackPos?.legs ?? [
    { contract: activeContracts('HO', releaseDate, 1)[0], weight: 1 as const },
    { contract: activeContracts('BZ', releaseDate, 1)[0], weight: -1 as const },
  ];
  const legMap = new Map(legs.map((l) => [l.contract, l]));
  const pricesAt = (k: 'pre' | 'post') => Object.fromEntries(crackLegs.map((l) => [l.contract, legMap.get(l.contract)?.[k]?.price]));
  let preV: number | null = null;
  let postV: number | null = null;
  try {
    preV = strategyValue(crackLegs, pricesAt('pre'));
  } catch {
    /* missing */
  }
  try {
    postV = strategyValue(crackLegs, pricesAt('post'));
  } catch {
    /* missing */
  }
  const eiaRows = repo
    .listInventories(db, 4)
    .filter((r) => r.weekEnding === rel.week_ending);
  const eiaData = Object.keys(EIA_SERIES).map((series) => {
    const actual = eiaRows.find((r) => r.series === series && r.kind === 'actual');
    const est = eiaRows.find((r) => r.series === series && r.kind === 'estimate');
    let changeKb = actual?.changeKb ?? null;
    if (changeKb === null && actual?.levelKb !== null && actual?.levelKb !== undefined) {
      const prev = repo.listInventories(db, 6).find((r) => r.series === series && r.kind === 'actual' && r.weekEnding === addDays(rel.week_ending, -7));
      if (prev?.levelKb !== null && prev?.levelKb !== undefined) changeKb = actual.levelKb - prev.levelKb;
    }
    return { series, weekEnding: rel.week_ending, changeKb, levelKb: actual?.levelKb ?? null, estimateChangeKb: est?.changeKb ?? null };
  });

  const complete = legs.every((l) => l.pre && l.post);
  const anyData = legs.some((l) => l.pre && l.post);
  const settings = loadSettings(db);
  const providerDelay = settings.provider === 'databento' ? settings.databentoDelayMinutes : settings.provider === 'custom-http' ? settings.customHttp.delayMinutes : settings.manualDefaultDelayMinutes;
  const deadline = releaseMs + 2 * 3600_000;
  const arrived = !!rel.data_arrived_at;
  let status: ReactionDto['status'];
  if (!arrived) status = 'pending';
  else if (complete) status = 'complete';
  else if (nowMs < deadline) status = 'pending';
  else status = anyData ? 'partial' : 'missing';
  const notes = [
    'Reaction is measured on exchange timestamps: last quote at/before the release time vs. the quote at the end of the 15-minute window.',
    `With a ~${providerDelay}-minute delayed source the +15 min quote is observable from about +${15 + providerDelay} min.`,
    arrived ? `EIA data recorded in-app at ${rel.data_arrived_at} (${rel.arrival_source}).` : 'Awaiting EIA data in the app (API poll or manual entry) — the report is finalised only after the data arrives.',
  ];
  if (!anyData) notes.push('No complete pre/post quote pairs have been recorded. Nothing is inferred.');
  return {
    releaseDate,
    releaseUtc: rel.release_utc,
    windowEndUtc: windowEndIso,
    status,
    updatedAt: iso(nowMs),
    finalizedAt: status === 'complete' || status === 'partial' || status === 'missing' ? iso(nowMs) : null,
    eiaArrivedAt: rel.data_arrived_at,
    eiaData,
    legs,
    crack: {
      contracts: crackLegs.map((l) => l.contract),
      pre: preV,
      post: postV,
      change: preV !== null && postV !== null ? postV - preV : null,
      note: preV !== null && postV !== null ? `${repo.valueFormula('crack', crackLegs)}` : 'Crack reaction unavailable: missing pre or +15 min quote for a leg.',
    },
    notes,
  };
}

export function storeReaction(db: Db, r: ReactionDto): void {
  const existing = db.get<{ finalized_at: string | null; report_json: string }>('SELECT finalized_at, report_json FROM eia_reactions WHERE release_date = ?', r.releaseDate);
  const keepFinal = existing?.finalized_at && r.finalizedAt ? existing.finalized_at : r.finalizedAt;
  const report = { ...r, finalizedAt: keepFinal };
  db.run(
    `INSERT INTO eia_reactions (release_date, release_utc, status, updated_at, finalized_at, report_json) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(release_date) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at,
       finalized_at = COALESCE(eia_reactions.finalized_at, excluded.finalized_at), report_json = excluded.report_json`,
    r.releaseDate,
    r.releaseUtc,
    r.status,
    r.updatedAt,
    keepFinal,
    JSON.stringify(report),
  );
  if (r.status !== 'pending' && (!existing || !existing.finalized_at)) {
    repo.addEvent(db, {
      ts: r.updatedAt,
      type: 'eia.reaction',
      summary: `EIA ${r.releaseDate} 0–15 min reaction ${r.status}: ${r.legs
        .map((l) => `${l.contract} ${l.change === null ? 'n/a' : (l.change >= 0 ? '+' : '') + l.change.toFixed(l.contract.startsWith('HO') || l.contract.startsWith('RB') ? 4 : 2)}`)
        .join(', ')}${r.crack?.change !== null && r.crack?.change !== undefined ? `; crack ${(r.crack.change >= 0 ? '+' : '') + r.crack.change.toFixed(3)} $/bbl` : ''}.`,
      detail: r,
      dedupeKey: `eia-reaction:${r.releaseDate}`,
    });
  }
}
