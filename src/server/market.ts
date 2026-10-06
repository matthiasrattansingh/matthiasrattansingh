// Market snapshot and the weekday 7:00 ET briefing.
//
// Everything here is descriptive and derived from data recorded in the app (quotes, EIA rows,
// FX fixings, contract calendars, user notes). No item expresses a directional view or a trade
// recommendation; generated text passes through the neutrality guard. When an input is missing
// the text says so instead of filling the gap.
import type { BriefingDto, BulletDto, ContractMarkDto, FxRowDto, InventorySummaryDto, LegDto, SnapshotDto, SpreadDto } from '../shared/types.ts';
import type { AppSettings } from '../shared/types.ts';
import type { Db } from './db.ts';
import * as repo from './repo.ts';
import { loadSettings } from './settings.ts';
import { markContract, snapshotContracts } from './valuation.ts';
import { classifyQuote } from '../domain/freshness.ts';
import { strategyValue } from '../domain/pnl.ts';
import { activeContracts, contractLabel, lastTradingDay, productOf, businessDaysToExpiry, PRODUCTS } from '../domain/contracts.ts';
import { addDays, cmeHolidays, etDate, isBusinessDay, isMarketOpen, nextEiaRelease, previousSession, sessionEndUtc, sessionTradeDate, toEt } from '../domain/calendar.ts';
import { consecutiveBuilds, weeklyChanges } from '../domain/inventory.ts';
import { assertNeutral } from '../domain/neutrality.ts';
import { EIA_SERIES } from './eia.ts';
import { fxRows } from './fx.ts';
import { iso } from './engine.ts';

const DISCLAIMER =
  'Descriptive only: no directional view and no trade recommendation. Quotes are delayed or stale exactly as labeled; P/L is simulated.';

const fmtEt = (ts: string | number) => toEt(ts).toFormat("ccc d LLL HH:mm 'ET'");
const signed = (n: number, d: number) => `${n >= 0 ? '+' : ''}${n.toFixed(d)}`;
const kb = (n: number | null) => (n === null ? 'n/a' : `${n >= 0 ? '+' : ''}${Math.round(n).toLocaleString('en-US')} kb`);

function bullet(text: string, basis: string): BulletDto {
  return { text: assertNeutral(text), basis };
}

/** Strategy value from quotes that were valid at `atMs` (for historical comparisons). */
export function valueAt(db: Db, legs: LegDto[], atMs: number, settings: AppSettings): { value: number; ts: string } | null {
  const prices: Record<string, number> = {};
  let oldest: string | null = null;
  for (const l of legs) {
    const q = repo.latestQuote(db, l.contract, iso(atMs));
    if (!q || !classifyQuote(q, atMs, settings.staleToleranceMinutes).valid) return null;
    prices[l.contract] = q.price;
    if (!oldest || q.exchangeTs < oldest) oldest = q.exchangeTs;
  }
  return { value: strategyValue(legs, prices), ts: oldest! };
}

export function buildSpread(db: Db, key: string, label: string, legs: LegDto[], nowMs: number, settings: AppSettings, cache: Map<string, ContractMarkDto>): SpreadDto {
  const marks = legs.map((l) => {
    let m = cache.get(l.contract);
    if (!m) {
      m = markContract(db, l.contract, nowMs, settings);
      cache.set(l.contract, m);
    }
    return m;
  });
  const prices: Record<string, number | undefined> = {};
  for (const m of marks) if (m.quote) prices[m.contract] = m.quote.price;
  let value: number | null = null;
  try {
    value = strategyValue(legs, prices);
  } catch {
    value = null;
  }
  const missing = marks.filter((m) => !m.freshness.valid).map((m) => `${m.contract}: ${m.freshness.status}`);
  const valid = missing.length === 0 && value !== null;
  const asOf = marks.reduce<string | null>((acc, m) => (m.quote && (!acc || m.quote.exchangeTs < acc) ? m.quote.exchangeTs : acc), null);
  const ago = valueAt(db, legs, nowMs - 48 * 3600_000, settings);
  let change48h: SpreadDto['change48h'] = null;
  let change48hNote: string | null = null;
  if (!ago) change48hNote = 'No valid quotes for these exact contracts as of 48 hours ago.';
  else if (!valid || value === null) change48hNote = 'Current value is provisional (stale or missing leg); 48-hour change not computed.';
  else change48h = { from: ago.value, fromTs: ago.ts, abs: value - ago.value };
  return { key, label, formula: repo.valueFormula(legs.length === 1 ? 'outright' : 'spread', legs), contracts: legs.map((l) => l.contract), value, valid, unit: '$/bbl', asOf, missing, change48h, change48hNote };
}

function m1(product: 'BZ' | 'HO' | 'CL' | 'RB', nowMs: number, n = 0): string {
  return activeContracts(product, etDate(nowMs), 2)[n];
}

export function buildSpreads(db: Db, nowMs: number, settings: AppSettings, cache: Map<string, ContractMarkDto>): SpreadDto[] {
  const bz1 = m1('BZ', nowMs);
  const bz2 = m1('BZ', nowMs, 1);
  const ho1 = m1('HO', nowMs);
  const ho2 = m1('HO', nowMs, 1);
  const rb1 = m1('RB', nowMs);
  const cl1 = m1('CL', nowMs);
  const spreads: SpreadDto[] = [
    buildSpread(db, 'brent-m1m2', `Brent M1–M2 (${bz1} − ${bz2})`, [{ contract: bz1, weight: 1 }, { contract: bz2, weight: -1 }], nowMs, settings, cache),
    buildSpread(db, 'ulsd-brent', `NY Harbor ULSD vs Brent crack (${ho1} × 42 − ${bz1})`, [{ contract: ho1, weight: 1 }, { contract: bz1, weight: -1 }], nowMs, settings, cache),
  ];
  const account = repo.currentAccount(db);
  for (const p of repo.openPositions(db, account.id)) {
    if (p.strategy !== 'crack') continue;
    const key = `pos-${p.id}`;
    const sameAsM1 = p.legs[0].contract === ho1 && p.legs[1].contract === bz1;
    if (!sameAsM1) spreads.push(buildSpread(db, key, `Position #${p.id} crack (${p.legs.map((l) => l.contract).join(' / ')})`, p.legs, nowMs, settings, cache));
  }
  spreads.push(
    buildSpread(db, 'rbob-brent', `RBOB vs Brent crack (${rb1} × 42 − ${bz1})`, [{ contract: rb1, weight: 1 }, { contract: bz1, weight: -1 }], nowMs, settings, cache),
    buildSpread(db, 'brent-wti', `Brent − WTI (${bz1} − ${cl1})`, [{ contract: bz1, weight: 1 }, { contract: cl1, weight: -1 }], nowMs, settings, cache),
    buildSpread(db, 'ho-m1m2', `ULSD M1–M2 (${ho1} − ${ho2}) in $/bbl`, [{ contract: ho1, weight: 1 }, { contract: ho2, weight: -1 }], nowMs, settings, cache),
  );
  return spreads;
}

export function snapshotMarks(db: Db, nowMs: number, settings: AppSettings, cache: Map<string, ContractMarkDto>): ContractMarkDto[] {
  const seen = new Set<string>();
  const out: ContractMarkDto[] = [];
  const account = repo.currentAccount(db);
  for (const p of repo.openPositions(db, account.id)) {
    for (const l of p.legs) {
      if (seen.has(l.contract)) continue;
      seen.add(l.contract);
      const m = markContract(db, l.contract, nowMs, settings, `Position #${p.id} leg`);
      cache.set(l.contract, m);
      out.push(m);
    }
  }
  for (const { contract, role } of snapshotContracts(nowMs)) {
    if (seen.has(contract)) {
      const existing = out.find((m) => m.contract === contract)!;
      existing.role = `${existing.role} · ${role}`;
      continue;
    }
    seen.add(contract);
    const m = markContract(db, contract, nowMs, settings, role);
    cache.set(contract, m);
    out.push(m);
  }
  return out;
}

export function inventorySummary(db: Db, nowMs: number, settings: AppSettings): InventorySummaryDto {
  const rows = repo.listInventories(db, 16);
  const obs = rows.map((r) => ({ ...r }));
  const out: InventorySummaryDto['rows'] = Object.entries(EIA_SERIES).map(([series, meta]) => {
    const actualRows = rows.filter((r) => r.series === series && r.kind === 'actual');
    const latest = actualRows[0];
    const changes = weeklyChanges(obs, series);
    const latestChange = latest ? changes.find((c) => c.weekEnding === latest.weekEnding)?.changeKb ?? null : null;
    const est = rows.find((r) => r.series === series && r.kind === 'estimate');
    const api = rows.find((r) => r.series === series && r.kind === 'api');
    return {
      series,
      label: meta.label,
      actual: latest ? { weekEnding: latest.weekEnding, levelKb: latest.levelKb, changeKb: latestChange, source: latest.source, releasedAt: latest.releasedAt } : null,
      estimate: est ? { weekEnding: est.weekEnding, changeKb: est.changeKb, source: est.source } : null,
      api: api ? { weekEnding: api.weekEnding, changeKb: api.changeKb, source: api.source } : null,
    };
  });
  const streak = consecutiveBuilds(obs, 'distillate');
  const next = nextEiaRelease(nowMs, settings.eiaOverrides);
  return {
    latestWeek: rows.find((r) => r.kind === 'actual')?.weekEnding ?? null,
    rows: out,
    distillateStreak: { streak: streak.streak, latestWeek: streak.latestWeek, note: streak.note, weeks: streak.weeks.map((w) => ({ weekEnding: w.weekEnding, changeKb: w.changeKb })) },
    nextRelease: next ? { releaseDate: next.releaseDate, timeEt: next.timeEt, releaseUtc: next.releaseUtc, weekEnding: next.weekEnding, source: next.source } : null,
  };
}

function sourceConflicts(db: Db, contracts: string[], nowMs: number): string[] {
  const notes: string[] = [];
  for (const c of contracts) {
    const recent = repo.recentQuotes(db, 40, c).filter((q) => nowMs - Date.parse(q.exchangeTs) < 6 * 3600_000);
    const tick = productOf(c).tickSize;
    const bySource = new Map<string, (typeof recent)[number]>();
    for (const q of recent) if (!bySource.has(q.source)) bySource.set(q.source, q);
    const latest = [...bySource.values()];
    for (let i = 0; i < latest.length; i++) {
      for (let k = i + 1; k < latest.length; k++) {
        const a = latest[i];
        const b = latest[k];
        if (Math.abs(Date.parse(a.exchangeTs) - Date.parse(b.exchangeTs)) <= 10 * 60_000 && Math.abs(a.price - b.price) > 5 * tick + 1e-12) {
          notes.push(`Sources disagree on ${c}: ${a.source} ${a.price} (${fmtEt(a.exchangeTs)}) vs ${b.source} ${b.price} (${fmtEt(b.exchangeTs)}). The latest exchange time is used for marks.`);
        }
      }
    }
  }
  return notes;
}

export function dataQualityNotes(db: Db, nowMs: number, settings: AppSettings, marks: ContractMarkDto[], fx: FxRowDto[], inv: InventorySummaryDto, envFlags: { eia: boolean }): string[] {
  const notes: string[] = [];
  for (const m of marks) if (!m.freshness.valid) notes.push(`${m.contract} (${m.role ?? 'snapshot'}): ${m.freshness.status} — ${m.freshness.reason}`);
  notes.push(...sourceConflicts(db, marks.map((m) => m.contract), nowMs));
  if (settings.provider === 'manual') notes.push('Quote source is manual entry: marks only update when quotes are entered.');
  const fxLatest = fx.map((r) => r.asOfDate).filter(Boolean).sort().pop();
  if (!fxLatest) notes.push('No FX reference rates recorded.');
  else if (fxLatest < addDays(etDate(nowMs), -4)) notes.push(`Latest FX fixing is ${fxLatest}; FX values are older than 4 days.`);
  if (!inv.latestWeek) notes.push(`No EIA actual inventory data loaded${envFlags.eia ? '' : ' (EIA_API_KEY not set — enter WPSR figures manually)'}.`);
  else if (inv.nextRelease && inv.latestWeek < addDays(inv.nextRelease.weekEnding, -7)) notes.push(`Latest EIA actual week (${inv.latestWeek}) is older than the most recent published week.`);
  const account = repo.currentAccount(db);
  const unknownMargin = repo
    .openPositions(db, account.id)
    .flatMap((p) => p.legs.map((l) => l.contract))
    .filter((c) => !repo.marginMap(db).has(c));
  if (unknownMargin.length) notes.push(`Initial margin not verified for ${[...new Set(unknownMargin)].join(', ')}: reserved margin and buying power are unknown, so new orders are blocked.`);
  notes.push('Contract last-trading days and exchange holidays are computed from CME rules; verify against the official calendar.');
  return notes;
}

function fxBullets(fx: FxRowDto[], linked: boolean): FxRowDto[] {
  const oilLinked = new Set(['USDCAD', 'USDNOK', 'USDCNY', 'USDINR', 'EURUSD']);
  return fx.filter((r) => r.change2d && (linked ? oilLinked.has(r.pair) : !oilLinked.has(r.pair))).sort((a, b) => Math.abs(b.change2d!.pct) - Math.abs(a.change2d!.pct));
}

interface Lists {
  investigate: BulletDto[];
  redHerrings: BulletDto[];
}

export function investigateAndRedHerrings(db: Db, nowMs: number, settings: AppSettings, spreads: SpreadDto[], fx: FxRowDto[], inv: InventorySummaryDto): Lists {
  const investigate: BulletDto[] = [];
  const red: BulletDto[] = [];
  const asOf = etDate(nowMs);
  const account = repo.currentAccount(db);
  const positions = repo.openPositions(db, account.id);
  const eiaPos = positions.filter((p) => p.exitRules.some((r) => r.type === 'eia_distillate_builds'));
  const next = inv.nextRelease;
  if (eiaPos.length || inv.latestWeek) {
    const need = eiaPos[0]?.exitRules.find((r) => r.type === 'eia_distillate_builds');
    investigate.push(
      bullet(
        `U.S. distillate stocks: ${inv.distillateStreak.streak} consecutive weekly build(s) in EIA actuals${inv.distillateStreak.latestWeek ? ` through week ending ${inv.distillateStreak.latestWeek}` : ' (no EIA actuals loaded)'}${need && need.type === 'eia_distillate_builds' ? `; position #${eiaPos[0].id}'s thesis exit needs ${need.weeks}` : ''}.${next ? ` Next WPSR: ${next.releaseDate} ${next.timeEt} ET (week ending ${next.weekEnding}${next.source === 'user-override' ? ', user override' : ''}).` : ''}`,
        'EIA actuals recorded in app; release calendar',
      ),
    );
  }
  const dist = inv.rows.find((r) => r.series === 'distillate');
  if (dist?.estimate) {
    investigate.push(bullet(`Distillate consensus for week ending ${dist.estimate.weekEnding}: ${kb(dist.estimate.changeKb)} (estimate — not EIA data; source: ${dist.estimate.source}).`, 'User-entered estimate'));
  }
  if (dist?.api) {
    investigate.push(bullet(`API survey, distillates, week ending ${dist.api.weekEnding}: ${kb(dist.api.changeKb)} (API figure — not EIA data).`, 'User-entered API figure'));
  }
  const m1m2 = spreads.find((s) => s.key === 'brent-m1m2');
  if (m1m2?.change48h && m1m2.value !== null) {
    investigate.push(
      bullet(
        `Brent M1–M2 (${m1m2.contracts.join(' − ')}): ${m1m2.value.toFixed(2)} $/bbl vs ${m1m2.change48h.from.toFixed(2)} 48 hours earlier (${signed(m1m2.change48h.abs, 2)}). Worth checking what is behind the change in prompt structure.`,
        'Recorded quotes, exact contracts',
      ),
    );
  }
  for (const p of positions) {
    const ltd = p.legs.map((l) => lastTradingDay(l.contract)).sort()[0];
    const bd = businessDaysToExpiry(p.legs.map((l) => l.contract).sort((a, b) => lastTradingDay(a).localeCompare(lastTradingDay(b)))[0], asOf);
    investigate.push(
      bullet(
        `Position #${p.id} (${p.legs.map((l) => l.contract).join(' / ')}): ${bd} business day(s) to the earliest computed last trading day (${ltd}).${settings.expiryGuardEnabled ? ` Expiry guard closes it at ${settings.expiryGuardTimeEt} ET that day if still open.` : ''}`,
        'CME expiry rules (computed)',
      ),
    );
  }
  const linked = fxBullets(fx, true)[0];
  if (linked && Math.abs(linked.change2d!.pct) >= 0.3) {
    investigate.push(bullet(`${linked.label} ${signed(linked.change2d!.pct, 2)}% over two ECB fixings (since ${linked.change2d!.fromDate}); ${linked.linkage.toLowerCase()}`, 'ECB reference rates'));
  }

  // Plausible red herrings: real data points that tend to draw attention but have a weaker or
  // indirect link to the open positions.
  const gas = inv.rows.find((r) => r.series === 'gasoline');
  if (gas?.actual) {
    red.push(bullet(`Gasoline stocks ${kb(gas.actual.changeKb)} (week ending ${gas.actual.weekEnding}, EIA actual): central to RBOB cracks, indirect for a ULSD-vs-Brent spread.`, 'EIA actuals'));
  }
  const cush = inv.rows.find((r) => r.series === 'cushing');
  if (cush?.actual) {
    red.push(bullet(`Cushing crude stocks ${kb(cush.actual.changeKb)} (week ending ${cush.actual.weekEnding}): a WTI delivery-point measure; the open crude leg is Brent.`, 'EIA actuals'));
  }
  const unlinked = fxBullets(fx, false)[0];
  if (unlinked) {
    red.push(bullet(`${unlinked.label} ${signed(unlinked.change2d!.pct, 2)}% over two ECB fixings: headline-prominent, with limited direct pass-through to USD-priced Brent or NY Harbor ULSD.`, 'ECB reference rates'));
  }
  const bw = spreads.find((s) => s.key === 'brent-wti');
  if (bw && bw.value !== null) {
    red.push(
      bullet(
        `Brent − WTI (${bw.contracts.join(' − ')}) at ${bw.value.toFixed(2)} $/bbl${bw.valid ? '' : ' (provisional)'}: the two legs are different delivery months, so part of this spread is calendar structure rather than location.`,
        'Recorded quotes; contract calendar',
      ),
    );
  }
  const cl1 = activeContracts('CL', asOf, 1)[0];
  const clBd = businessDaysToExpiry(cl1, asOf);
  if (clBd <= 10) {
    red.push(bullet(`WTI ${cl1} expires ${lastTradingDay(cl1)} (${clBd} business days): expiry-driven WTI moves do not settle the Brent or ULSD legs directly.`, 'CME expiry rules (computed)'));
  }
  return { investigate, redHerrings: red };
}

export function buildSnapshot(db: Db, nowMs: number, envFlags: { eia: boolean }): SnapshotDto {
  const settings = loadSettings(db);
  const cache = new Map<string, ContractMarkDto>();
  const contracts = snapshotMarks(db, nowMs, settings, cache);
  const spreads = buildSpreads(db, nowMs, settings, cache);
  const fx = fxRows(db, settings.fxPairs);
  const inv = inventorySummary(db, nowMs, settings);
  const lists = investigateAndRedHerrings(db, nowMs, settings, spreads, fx, inv);
  // The snapshot mixes context items without labelling their relevance; the briefing labels them.
  const context = [...lists.investigate, ...lists.redHerrings].sort((a, b) => hash(a.text) - hash(b.text));
  return {
    generatedAt: iso(nowMs),
    marketOpen: isMarketOpen(nowMs),
    tradeDate: sessionTradeDate(nowMs),
    contracts,
    spreads,
    fx,
    inventories: inv,
    context,
    dataQuality: dataQualityNotes(db, nowMs, settings, contracts, fx, inv, envFlags),
    disclaimer: DISCLAIMER,
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function overnightBullets(db: Db, nowMs: number, settings: AppSettings): BulletDto[] {
  const prev = previousSession(nowMs);
  const closeMs = Date.parse(prev.endUtc);
  const out: BulletDto[] = [];
  const items: { label: string; legs: LegDto[]; decimals: number }[] = [
    { label: `Brent M1 (${m1('BZ', nowMs)})`, legs: [{ contract: m1('BZ', nowMs), weight: 1 }], decimals: 2 },
    { label: `NY Harbor ULSD M1 (${m1('HO', nowMs)}, $/gal)`, legs: [{ contract: m1('HO', nowMs), weight: 1 }], decimals: 4 },
    { label: `WTI M1 (${m1('CL', nowMs)})`, legs: [{ contract: m1('CL', nowMs), weight: 1 }], decimals: 2 },
    { label: `RBOB M1 (${m1('RB', nowMs)}, $/gal)`, legs: [{ contract: m1('RB', nowMs), weight: 1 }], decimals: 4 },
    { label: `ULSD–Brent crack (${m1('HO', nowMs)} × 42 − ${m1('BZ', nowMs)})`, legs: [{ contract: m1('HO', nowMs), weight: 1 }, { contract: m1('BZ', nowMs), weight: -1 }], decimals: 3 },
  ];
  for (const it of items) {
    const native = it.legs.length === 1 ? productOf(it.legs[0].contract).toBarrelFactor : 1;
    const from = valueAt(db, it.legs, closeMs, settings);
    const to = valueAt(db, it.legs, nowMs, settings);
    if (!from || !to) {
      out.push(bullet(`${it.label}: overnight change unavailable — ${!from ? `no valid quote at the prior session close (${fmtEt(closeMs)})` : 'no valid current quote'}.`, 'Recorded quotes'));
      continue;
    }
    const a = from.value / native;
    const b = to.value / native;
    out.push(
      bullet(
        `${it.label}: ${a.toFixed(it.decimals)} (${fmtEt(from.ts)}) → ${b.toFixed(it.decimals)} (${fmtEt(to.ts)}), ${signed(b - a, it.decimals)}${it.legs.length === 1 ? ` (${signed(((b - a) / a) * 100, 2)}%)` : ' $/bbl'}.`,
        'Recorded quotes, exchange timestamps',
      ),
    );
  }
  return out;
}

function trendBullets(db: Db, nowMs: number, settings: AppSettings): BulletDto[] {
  // Session-end values over the last five completed sessions for the exact current contracts.
  const sessions: string[] = [];
  let d = etDate(nowMs);
  while (sessions.length < 5) {
    if (isBusinessDay(d) && Date.parse(sessionEndUtc(d)) <= nowMs) sessions.unshift(d);
    d = addDays(d, -1);
  }
  const series: { label: string; legs: LegDto[]; decimals: number; div: number }[] = [
    { label: `Brent ${m1('BZ', nowMs)}`, legs: [{ contract: m1('BZ', nowMs), weight: 1 }], decimals: 2, div: 1 },
    { label: `ULSD ${m1('HO', nowMs)} ($/gal)`, legs: [{ contract: m1('HO', nowMs), weight: 1 }], decimals: 4, div: 42 },
    { label: `ULSD–Brent crack`, legs: [{ contract: m1('HO', nowMs), weight: 1 }, { contract: m1('BZ', nowMs), weight: -1 }], decimals: 3, div: 1 },
    { label: `Brent M1–M2`, legs: [{ contract: m1('BZ', nowMs), weight: 1 }, { contract: m1('BZ', nowMs, 1), weight: -1 }], decimals: 2, div: 1 },
  ];
  return series.map((s) => {
    const vals = sessions.map((td) => {
      const v = valueAt(db, s.legs, Date.parse(sessionEndUtc(td)), settings);
      return `${toEt(sessionEndUtc(td)).toFormat('ccc')} ${v ? (v.value / s.div).toFixed(s.decimals) : 'n/a'}`;
    });
    const have = vals.filter((v) => !v.endsWith('n/a')).length;
    return bullet(`${s.label}, session-end marks: ${vals.join(' · ')}${have < 2 ? ' (insufficient recorded history for a trend)' : ''}.`, 'Recorded quotes at each 17:00 ET session end');
  });
}

function calendarBullets(db: Db, nowMs: number, settings: AppSettings): BulletDto[] {
  const out: BulletDto[] = [];
  const asOf = etDate(nowMs);
  const next = nextEiaRelease(nowMs, settings.eiaOverrides);
  if (next) out.push(bullet(`EIA Weekly Petroleum Status Report: ${next.releaseDate} at ${next.timeEt} ET (week ending ${next.weekEnding}; ${next.source === 'default-rule' ? 'default Wednesday schedule — verify holiday weeks' : 'user override'}).`, 'EIA schedule'));
  for (const prod of ['BZ', 'HO', 'CL', 'RB'] as const) {
    const c = activeContracts(prod, asOf, 1)[0];
    out.push(bullet(`${PRODUCTS[prod].shortName} M1 is ${contractLabel(c)}; computed last trading day ${lastTradingDay(c)} (${businessDaysToExpiry(c, asOf)} business days).`, 'CME expiry rules (computed)'));
  }
  for (const yr of [Number(asOf.slice(0, 4)), Number(asOf.slice(0, 4)) + 1]) {
    for (const [date, name] of cmeHolidays(yr)) {
      if (date >= asOf && date <= addDays(asOf, 14)) out.push(bullet(`${name} (${date}): exchange holiday schedule applies (computed).`, 'Computed CME holiday calendar'));
    }
  }
  return out;
}

export function buildBriefingContent(db: Db, nowMs: number, envFlags: { eia: boolean }): BriefingDto['content'] {
  const settings = loadSettings(db);
  const cache = new Map<string, ContractMarkDto>();
  const contracts = snapshotMarks(db, nowMs, settings, cache);
  const spreads = buildSpreads(db, nowMs, settings, cache);
  const fx = fxRows(db, settings.fxPairs);
  const inv = inventorySummary(db, nowMs, settings);
  const lists = investigateAndRedHerrings(db, nowMs, settings, spreads, fx, inv);
  const inventoryNotes: BulletDto[] = inv.rows.map((r) => {
    const parts: string[] = [];
    parts.push(r.actual ? `EIA actual (week ending ${r.actual.weekEnding}): ${kb(r.actual.changeKb)}${r.actual.levelKb !== null ? `, level ${Math.round(r.actual.levelKb).toLocaleString('en-US')} kb` : ''}` : 'no EIA actual loaded');
    if (r.api) parts.push(`API (not EIA) for ${r.api.weekEnding}: ${kb(r.api.changeKb)}`);
    if (r.estimate) parts.push(`estimate (not data) for ${r.estimate.weekEnding}: ${kb(r.estimate.changeKb)}`);
    return bullet(`${r.label}: ${parts.join('; ')}.`, 'EIA actuals / user-entered API & estimates');
  });
  const notes = repo
    .listNotes(db, 'note')
    .filter((n) => nowMs - Date.parse(n.createdAt) < 7 * 24 * 3600_000)
    // User notes are the user's own words, so they are shown verbatim (not run through the guard).
    .map((n) => ({ text: `${n.title}${n.body ? ` — ${n.body}` : ''} (user note, ${fmtEt(n.createdAt)})`, basis: 'User-entered' }));
  return {
    title: `Briefing for ${toEt(nowMs).toFormat('cccc d LLLL yyyy')}`,
    overnight: overnightBullets(db, nowMs, settings),
    trends: trendBullets(db, nowMs, settings),
    m1m2: spreads.find((s) => s.key === 'brent-m1m2') ?? null,
    fx,
    inventories: inv,
    inventoryNotes,
    investigate: lists.investigate,
    redHerrings: lists.redHerrings,
    dataQuality: dataQualityNotes(db, nowMs, settings, contracts, fx, inv, envFlags),
    calendar: calendarBullets(db, nowMs, settings),
    userNotes: notes,
    disclaimer: DISCLAIMER,
  };
}

export function storeBriefing(db: Db, key: string, kind: 'scheduled' | 'adhoc', scheduledFor: string | null, nowMs: number, content: BriefingDto['content']): BriefingDto {
  db.run(
    'INSERT OR IGNORE INTO briefings (key, kind, scheduled_for, generated_at, content_json) VALUES (?, ?, ?, ?, ?)',
    key,
    kind,
    scheduledFor,
    iso(nowMs),
    JSON.stringify(content),
  );
  return repo.mapBriefing(db.get('SELECT * FROM briefings WHERE key = ?', key)!);
}
