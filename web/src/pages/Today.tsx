import { useState } from 'react';
import type { BriefingDto, SnapshotDto } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { Alert, Badge, Bullets, Card, ContractTable, useApp, useFetch } from '../components/ui.tsx';
import { FxTable, InventoryTable, SpreadTable, DistillateStreak } from '../components/marketParts.tsx';
import { fmtEt, fmtLocal, fmtNum, etNowParts } from '../format.ts';
import { Icon } from '../icons.tsx';

function BriefingView({ b }: { b: BriefingDto }) {
  const c = b.content;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="btn-row small">
        <Badge tone={b.kind === 'scheduled' ? 'info' : ''} icon={Icon.clock}>
          {b.kind === 'scheduled' ? `Scheduled ${b.scheduledFor ? fmtEt(b.scheduledFor) : ''}` : 'Ad-hoc'}
        </Badge>
        <span className="muted">Generated {fmtEt(b.generatedAt)}</span>
        {b.late ? (
          <Badge tone="warn" icon={Icon.alert}>
            Generated late
          </Badge>
        ) : null}
      </div>
      <div>
        <div className="section-title">Overnight</div>
        <Bullets items={c.overnight} />
      </div>
      <div>
        <div className="section-title">Recent trends</div>
        <Bullets items={c.trends} />
      </div>
      {c.m1m2 ? (
        <div>
          <div className="section-title">Brent M1–M2</div>
          <p>
            <strong>{c.m1m2.label}</strong>: {fmtNum(c.m1m2.value, 2)} $/bbl{c.m1m2.valid ? '' : ' (provisional)'} ·{' '}
            {c.m1m2.change48h ? (
              <>
                48h change {fmtNum(c.m1m2.change48h.abs, 2, true)} (from {fmtNum(c.m1m2.change48h.from, 2)} at {fmtEt(c.m1m2.change48h.fromTs)})
              </>
            ) : (
              <span className="muted">48h change unavailable — {c.m1m2.change48hNote}</span>
            )}
          </p>
        </div>
      ) : null}
      <div>
        <div className="section-title">FX basket</div>
        <FxTable rows={c.fx} />
      </div>
      <div>
        <div className="section-title">EIA / API inventory context</div>
        <Bullets items={c.inventoryNotes} />
      </div>
      <div className="grid grid-2">
        <div>
          <div className="section-title">Investigate</div>
          <Bullets items={c.investigate} empty="No items (insufficient data)." />
        </div>
        <div>
          <div className="section-title">Plausible red herrings</div>
          <Bullets items={c.redHerrings} empty="No items (insufficient data)." />
        </div>
      </div>
      <div>
        <div className="section-title">Calendar</div>
        <Bullets items={c.calendar} />
      </div>
      {c.userNotes.length ? (
        <div>
          <div className="section-title">Your notes</div>
          <Bullets items={c.userNotes} />
        </div>
      ) : null}
      <div>
        <div className="section-title">Data quality</div>
        <ul className="bullets small">
          {c.dataQuality.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      </div>
      <p className="small muted">{c.disclaimer}</p>
    </div>
  );
}

export function TodayPage() {
  const { state, zone, refresh, notify } = useApp();
  const briefings = useFetch<BriefingDto[]>('/api/briefings?limit=1', [state?.now.slice(0, 15)]);
  const [snapN, setSnapN] = useState(0);
  const snap = useFetch<SnapshotDto>('/api/snapshot', [snapN]);
  const [busy, setBusy] = useState(false);
  const [passNote, setPassNote] = useState('');
  if (!state) return null;
  const et = etNowParts();
  const weekday = ![0, 6].includes(new Date(`${et.date}T12:00:00Z`).getUTCDay());
  const latest = briefings.data?.[0];

  const generate = async () => {
    setBusy(true);
    try {
      await api('/api/briefings', { method: 'POST' });
      briefings.reload();
      setSnapN((n) => n + 1);
      notify('Briefing generated.', 'good');
    } catch (e) {
      notify((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const pass = async () => {
    try {
      const r = await api<{ recorded: boolean }>('/api/decisions/pass', { body: { note: passNote } });
      notify(r.recorded ? 'Recorded: no new trade today.' : 'A pass is already recorded for today.', 'info');
      setPassNote('');
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trading day · {new Date(`${et.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} (ET)</h1>
          <p>
            Read the recap, check the neutral snapshot, then decide: enter a simulated trade or pass. Times show in {zone}; exchange and EIA times are labeled ET.
          </p>
        </div>
      </div>

      {state.warnings.length ? (
        <div className="alerts">
          {state.warnings.map((w) => (
            <Alert key={w} tone={w.startsWith('Trading halted') ? 'bad' : 'warn'}>
              {w}
            </Alert>
          ))}
        </div>
      ) : null}

      <Card title="Today's decision" sub={weekday ? `${state.tradesToday} simulated trade(s) submitted today · daily limit ${state.settings.dailyTradeLimit || 'none'}` : 'Weekend — new simulated trades open Monday (ET).'}>
        <div className="row">
          <div style={{ flex: '1 1 280px' }}>
            {state.decisionToday ? (
              <Alert tone="good">
                {state.decisionToday.summary} <span className="muted">({fmtLocal(state.decisionToday.ts, zone)})</span>
              </Alert>
            ) : (
              <p className="ink2">No decision recorded today.</p>
            )}
          </div>
          <a className="btn primary" href="#/trade">
            {Icon.trade} Enter a simulated trade
          </a>
          <div className="row" style={{ flex: '1 1 320px' }}>
            <label className="field">
              <span>Pass note (optional)</span>
              <input type="text" value={passNote} onChange={(e) => setPassNote(e.target.value)} placeholder="Why no trade today?" />
            </label>
            <button className="btn" onClick={pass} disabled={!weekday}>
              Pass today
            </button>
          </div>
        </div>
      </Card>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card
          title="Overnight recap & briefing"
          sub={`Weekday briefing at ${state.settings.briefingTimeEt} ET${state.scheduler.briefing.next ? ` · next ${fmtEt(state.scheduler.briefing.next)}` : ''}`}
          actions={
            <button className="btn small" onClick={generate} disabled={busy}>
              {Icon.refresh} {busy ? 'Generating…' : 'Generate now'}
            </button>
          }
        >
          {briefings.error ? <Alert tone="bad">{briefings.error}</Alert> : null}
          {latest ? <BriefingView b={latest} /> : <p className="empty">No briefing yet. The scheduled briefing runs on weekdays at {state.settings.briefingTimeEt} ET while the server is running, or generate one now.</p>}
        </Card>

        <div className="grid">
          <Card
            title="Market snapshot"
            sub={snap.data ? `Built ${fmtLocal(snap.data.generatedAt, zone, true)} · ${snap.data.marketOpen ? `NYMEX open (trade date ${snap.data.tradeDate})` : 'NYMEX closed'}` : 'Loading…'}
            actions={
              <button className="btn small" onClick={() => setSnapN((n) => n + 1)}>
                {Icon.refresh} Rebuild
              </button>
            }
          >
            {snap.data ? (
              <div className="grid" style={{ gap: 14 }}>
                <SpreadTable spreads={snap.data.spreads} compact />
                <details>
                  <summary>Contract quotes ({snap.data.contracts.length})</summary>
                  <ContractTable marks={snap.data.contracts} />
                </details>
                <div>
                  <div className="section-title">FX basket</div>
                  <FxTable rows={snap.data.fx} />
                </div>
                <div>
                  <div className="section-title">Inventories</div>
                  <InventoryTable inv={snap.data.inventories} />
                  <div style={{ marginTop: 10 }}>
                    <DistillateStreak inv={snap.data.inventories} />
                  </div>
                </div>
                <div>
                  <div className="section-title">Context items (relevance not assessed)</div>
                  <Bullets items={snap.data.context} empty="No context items (insufficient data)." />
                </div>
                <div>
                  <div className="section-title">Data quality</div>
                  <ul className="bullets small">
                    {snap.data.dataQuality.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                </div>
                <p className="small muted">{snap.data.disclaimer}</p>
              </div>
            ) : snap.error ? (
              <Alert tone="bad">{snap.error}</Alert>
            ) : (
              <p className="empty">Loading…</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
