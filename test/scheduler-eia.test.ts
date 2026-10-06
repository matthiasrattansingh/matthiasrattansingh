import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, quotes, exactCrackQuotes } from './helpers.ts';
import { runHourly, Scheduler } from '../src/server/scheduler.ts';
import { computeReaction, ensureRelease, ingestInventories, manualInventoryRows, parseEiaResponse, storeReaction } from '../src/server/eia.ts';
import { buildBriefingContent, buildSnapshot } from '../src/server/market.ts';
import { findDirectionalLanguage } from '../src/domain/neutrality.ts';
import { eiaReleaseForWeek } from '../src/domain/calendar.ts';
import * as repo from '../src/server/repo.ts';

describe('hourly updates', () => {
  it('records one update per slot even when the scheduled run is retried', async () => {
    const app = makeApp('2026-10-06T13:58:00.000Z');
    quotes(app.db, app.app.now(), exactCrackQuotes(88, '2026-10-06T13:50:00Z'));
    app.setNow('2026-10-06T14:00:05.000Z');
    await runHourly(app.app, '2026-10-06T14:00:00.000Z');
    await runHourly(app.app, '2026-10-06T14:00:00.000Z');
    const updates = repo.listUpdates(app.db);
    assert.equal(updates.length, 1);
    const r = updates[0].report;
    assert.equal(r.legs.length, 2);
    assert.ok(r.legs.every((l) => l.exchangeTs && l.source && l.status === 'delayed'));
    assert.ok(Math.abs(r.positions[0].unrealized! - 0.67 * 5_000) < 1e-6);
    assert.equal(r.account.grossBeforeCosts, true);
    assert.equal(r.account.buyingPowerVerified, false); // margin not configured
    assert.equal(repo.getJob(app.db, 'hourly:2026-10-06T14:00:00.000Z')!.status, 'ok');
  });

  it('records missed slots instead of backfilling them', async () => {
    const app = makeApp('2026-10-06T13:58:00.000Z');
    const s = new Scheduler(app.app);
    app.setNow('2026-10-06T14:01:00.000Z');
    await s.tick();
    assert.equal(repo.getJob(app.db, 'hourly:2026-10-06T14:00:00.000Z')!.status, 'ok');
    app.setNow('2026-10-06T17:20:00.000Z'); // app was "down" for 15:00 and 16:00 ET slots
    await s.tick();
    assert.equal(repo.getJob(app.db, 'hourly:2026-10-06T15:00:00.000Z')!.status, 'missed');
    assert.equal(repo.getJob(app.db, 'hourly:2026-10-06T16:00:00.000Z')!.status, 'missed');
    assert.equal(repo.getJob(app.db, 'hourly:2026-10-06T17:00:00.000Z')!.status, 'ok');
    assert.equal(repo.listUpdates(app.db).length, 2);
    s.stop();
  });

  it('skips the 17:00 ET maintenance break', async () => {
    const app = makeApp('2026-10-06T20:55:00.000Z');
    const s = new Scheduler(app.app);
    app.setNow('2026-10-06T21:05:00.000Z'); // 17:05 ET
    await s.tick();
    assert.equal(repo.getJob(app.db, 'hourly:2026-10-06T21:00:00.000Z'), null);
    s.stop();
  });
});

describe('EIA release reaction (0–15 minutes)', () => {
  const RELEASE = '2026-10-07T14:30:00.000Z';

  function setup() {
    const app = makeApp('2026-10-07T14:00:00.000Z');
    const rel = eiaReleaseForWeek('2026-10-07')!;
    ensureRelease(app.db, rel);
    return app;
  }

  it('reports the actual pre-release vs +15 min change from recorded quotes only', () => {
    const app = setup();
    app.setNow('2026-10-07T14:40:00.000Z');
    quotes(app.db, app.app.now(), [
      ['HOX2026', 3.5, '2026-10-07T14:29:00Z'],
      ['BZZ2026', 60.0, '2026-10-07T14:29:00Z'],
    ]);
    app.setNow('2026-10-07T14:56:00.000Z');
    quotes(app.db, app.app.now(), [
      ['HOX2026', 3.52, '2026-10-07T14:45:00Z'],
      ['BZZ2026', 60.1, '2026-10-07T14:45:00Z'],
    ]);
    // Before the EIA data is recorded the report stays pending.
    assert.equal(computeReaction(app.db, '2026-10-07', app.app.now()).status, 'pending');
    const rows = manualInventoryRows({ weekEnding: '2026-10-02', kind: 'actual', values: [{ series: 'distillate', levelKb: 121_000, changeKb: 800 }, { series: 'crude', levelKb: 420_000, changeKb: -1_200 }] }, app.app.now()).rows;
    ingestInventories(app.db, rows, app.app.now(), 'manual entry');
    const r = computeReaction(app.db, '2026-10-07', app.app.now());
    const ho = r.legs.find((l) => l.contract === 'HOX2026')!;
    const bz = r.legs.find((l) => l.contract === 'BZZ2026')!;
    assert.ok(Math.abs(ho.change! - 0.02) < 1e-9);
    assert.ok(Math.abs(ho.changePerBbl! - 0.84) < 1e-9);
    assert.ok(Math.abs(bz.change! - 0.1) < 1e-9);
    assert.ok(Math.abs(r.crack!.change! - 0.74) < 1e-6);
    assert.equal(r.eiaData.find((d) => d.series === 'distillate')!.changeKb, 800);
    // Other M1 contracts had no quotes: the report is not complete and says so.
    assert.equal(r.status, 'pending');
    assert.ok(r.legs.find((l) => l.contract.startsWith('CL'))!.note.includes('no quote'));
    app.setNow('2026-10-07T16:40:00.000Z'); // after the 2-hour deadline
    const final = computeReaction(app.db, '2026-10-07', app.app.now());
    assert.equal(final.status, 'partial');
    storeReaction(app.db, final);
    assert.equal(repo.listEvents(app.db, { type: 'eia.reaction' }).length, 1);
  });

  it('never fills the window with invented values when no quotes exist', () => {
    const app = setup();
    app.setNow('2026-10-07T16:45:00.000Z');
    ingestInventories(app.db, manualInventoryRows({ weekEnding: '2026-10-02', kind: 'actual', values: [{ series: 'distillate', levelKb: 121_000 }] }, app.app.now()).rows, app.app.now(), 'manual');
    const r = computeReaction(app.db, '2026-10-07', app.app.now());
    assert.equal(r.status, 'missing');
    assert.ok(r.legs.every((l) => l.change === null && l.pre === null && l.post === null));
    assert.equal(r.crack!.change, null);
    assert.equal(Date.parse(r.windowEndUtc) - Date.parse(RELEASE), 15 * 60_000);
  });

  it('parses EIA API v2 weekly stock responses', () => {
    const rows = parseEiaResponse(
      {
        response: {
          data: [
            { period: '2026-10-02', series: 'WDISTUS1', value: '121800', units: 'MBBL' },
            { period: '2026-10-02', series: 'WCESTUS1', value: 420100 },
            { period: '2026-10-02', series: 'UNKNOWN', value: 1 },
          ],
        },
      },
      '2026-10-07T14:32:00.000Z',
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => [r.series, r.levelKb, r.kind, r.releasedAt]),
      [
        ['distillate', 121_800, 'actual', '2026-10-07T14:30:00.000Z'],
        ['crude', 420_100, 'actual', '2026-10-07T14:30:00.000Z'],
      ],
    );
  });
});

describe('briefing and snapshot neutrality', () => {
  it('contains no directional language and labels estimates vs actuals', () => {
    const app = makeApp('2026-10-06T10:55:00.000Z');
    const t = app.app.now();
    quotes(app.db, t, [
      ['HOX2026', 3.5, '2026-10-05T20:55:00Z'],
      ['BZZ2026', 60, '2026-10-05T20:55:00Z'],
      ['BZF2027', 59.3, '2026-10-05T20:55:00Z'],
      ['CLX2026', 57, '2026-10-05T20:55:00Z'],
    ]);
    app.setNow('2026-10-06T11:00:00.000Z');
    quotes(app.db, app.app.now(), [
      ['HOX2026', 3.51, '2026-10-06T10:50:00Z'],
      ['BZZ2026', 60.2, '2026-10-06T10:50:00Z'],
      ['BZF2027', 59.45, '2026-10-06T10:50:00Z'],
      ['CLX2026', 57.1, '2026-10-06T10:50:00Z'],
    ]);
    ingestInventories(
      app.db,
      [
        ...manualInventoryRows({ weekEnding: '2026-09-25', kind: 'actual', values: [{ series: 'distillate', levelKb: 120_000 }, { series: 'gasoline', levelKb: 220_000 }, { series: 'cushing', levelKb: 25_000 }] }, app.app.now()).rows,
        ...manualInventoryRows({ weekEnding: '2026-10-02', kind: 'actual', values: [{ series: 'distillate', levelKb: 120_400 }, { series: 'gasoline', levelKb: 219_000 }, { series: 'cushing', levelKb: 24_500 }] }, app.app.now()).rows,
        ...manualInventoryRows({ weekEnding: '2026-10-09', kind: 'estimate', values: [{ series: 'distillate', changeKb: 600 }] }, app.app.now()).rows,
      ],
      app.app.now(),
      'manual',
    );
    const content = buildBriefingContent(app.db, app.app.now(), { eia: false });
    const texts = [...content.overnight, ...content.trends, ...content.investigate, ...content.redHerrings, ...content.inventoryNotes, ...content.calendar].map((b) => b.text);
    for (const t of texts) assert.deepEqual(findDirectionalLanguage(t), [], t);
    assert.ok(content.redHerrings.length >= 2);
    assert.ok(content.investigate.some((b) => /estimate — not EIA data/.test(b.text)));
    assert.ok(content.inventoryNotes.some((b) => /EIA actual/.test(b.text)));
    assert.ok(content.overnight[0].text.startsWith('Brent M1 (BZZ2026): 60.00'));
    const snap = buildSnapshot(app.db, app.app.now(), { eia: false });
    const m1m2 = snap.spreads.find((s) => s.key === 'brent-m1m2')!;
    assert.equal(m1m2.contracts.join(','), 'BZZ2026,BZF2027');
    assert.ok(Math.abs(m1m2.value! - 0.75) < 1e-9);
    assert.equal(m1m2.change48h, null); // no quotes 48h back — reported as unavailable
    assert.ok(m1m2.change48hNote);
    for (const c of snap.context) assert.deepEqual(findDirectionalLanguage(c.text), [], c.text);
  });
});
