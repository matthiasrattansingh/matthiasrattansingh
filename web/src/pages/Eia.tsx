import { useState } from 'react';
import type { InventoryDto, InventorySummaryDto, ReactionDto } from '../../../src/shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Alert, Badge, Card, useApp, useFetch } from '../components/ui.tsx';
import { DistillateStreak, InventoryTable } from '../components/marketParts.tsx';
import { etNowParts, fmtDate, fmtEt, fmtLocal, fmtNum, fmtPrice } from '../format.ts';
import { Icon } from '../icons.tsx';

interface EiaData {
  summary: InventorySummaryDto;
  inventories: InventoryDto[];
  releases: { release_date: string; release_utc: string; week_ending: string; data_arrived_at: string | null; arrival_source: string | null; status: string }[];
  reactions: ReactionDto[];
  apiKeyConfigured: boolean;
}

const SERIES = [
  { id: 'distillate', label: 'Distillate' },
  { id: 'crude', label: 'Crude (ex-SPR)' },
  { id: 'gasoline', label: 'Gasoline' },
  { id: 'cushing', label: 'Cushing' },
];

function lastFriday(): string {
  const d = new Date(`${etNowParts().date}T12:00:00Z`);
  const day = d.getUTCDay();
  const back = (day + 2) % 7 || 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function ReactionCard({ r, onRecompute }: { r: ReactionDto; onRecompute: () => void }) {
  const tone = r.status === 'complete' ? 'good' : r.status === 'pending' ? 'info' : r.status === 'partial' ? 'warn' : 'bad';
  return (
    <Card
      title={`EIA release ${fmtDate(r.releaseDate)} — 0–15 minute reaction`}
      sub={`Window ${fmtEt(r.releaseUtc, false)} → ${fmtEt(r.windowEndUtc, false)} (exchange time) · updated ${fmtEt(r.updatedAt)}`}
      actions={
        <>
          <Badge tone={tone}>{r.status}</Badge>
          <button className="btn small" onClick={onRecompute}>
            {Icon.refresh} Recompute from recorded quotes
          </button>
        </>
      }
    >
      <div className="grid grid-2">
        <div>
          <div className="section-title">EIA data (week ending {r.eiaData[0]?.weekEnding})</div>
          <p className="small muted" style={{ marginBottom: 6 }}>
            {r.eiaArrivedAt ? `Recorded in app ${fmtEt(r.eiaArrivedAt)}` : 'Not yet recorded in the app'}
          </p>
          <table>
            <thead>
              <tr>
                <th>Series</th>
                <th className="num">Actual Δ (kb)</th>
                <th className="num">Estimate Δ</th>
              </tr>
            </thead>
            <tbody>
              {r.eiaData.map((d) => (
                <tr key={d.series}>
                  <td>{d.series}</td>
                  <td className="num">{fmtNum(d.changeKb, 0, true)}</td>
                  <td className="num">{d.estimateChangeKb === null ? '—' : `${fmtNum(d.estimateChangeKb, 0, true)} (est.)`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <div className="section-title">Crack reaction</div>
          {r.crack ? (
            <p>
              {r.crack.contracts.join(' / ')}: {fmtNum(r.crack.pre, 3)} → {fmtNum(r.crack.post, 3)} ={' '}
              <strong>{r.crack.change === null ? 'n/a' : `${fmtNum(r.crack.change, 3, true)} $/bbl`}</strong>
              <span className="small muted"> · {r.crack.note}</span>
            </p>
          ) : null}
        </div>
      </div>
      <div className="table-wrap" style={{ marginTop: 10 }}>
        <table>
          <thead>
            <tr>
              <th>Contract</th>
              <th className="num">Pre-release</th>
              <th className="num">+15 min</th>
              <th className="num">Change</th>
              <th className="num">In-window hi / lo</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {r.legs.map((l) => (
              <tr key={l.contract}>
                <td className="mono">{l.contract}</td>
                <td className="num">
                  {l.pre ? fmtPrice(l.contract, l.pre.price) : '—'}
                  {l.pre ? <div className="small muted">{fmtEt(l.pre.exchangeTs, false)}</div> : null}
                </td>
                <td className="num">
                  {l.post ? fmtPrice(l.contract, l.post.price) : '—'}
                  {l.post ? <div className="small muted">{fmtEt(l.post.exchangeTs, false)}</div> : null}
                </td>
                <td className="num">
                  {l.change === null ? '—' : fmtNum(l.change, l.contract.startsWith('HO') || l.contract.startsWith('RB') ? 4 : 2, true)}
                  {l.changePerBbl !== null && (l.contract.startsWith('HO') || l.contract.startsWith('RB')) ? <div className="small muted">{fmtNum(l.changePerBbl, 2, true)} $/bbl</div> : null}
                </td>
                <td className="num small">
                  {l.inWindow.count ? `${fmtPrice(l.contract, l.inWindow.high)} / ${fmtPrice(l.contract, l.inWindow.low)} (${l.inWindow.count})` : '—'}
                </td>
                <td className="small muted">{l.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="bullets small" style={{ marginTop: 8 }}>
        {r.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </Card>
  );
}

export function EiaPage() {
  const { state, zone, notify, refresh } = useApp();
  const [n, setN] = useState(0);
  const data = useFetch<EiaData>('/api/eia', [n]);
  const [week, setWeek] = useState(lastFriday);
  const [kind, setKind] = useState<'actual' | 'estimate' | 'api'>('actual');
  const [source, setSource] = useState('');
  const [vals, setVals] = useState<Record<string, { level: string; change: string }>>(() => Object.fromEntries(SERIES.map((s) => [s.id, { level: '', change: '' }])));
  const [errors, setErrors] = useState<string[]>([]);
  if (!state) return null;
  const d = data.data;

  const save = async () => {
    setErrors([]);
    try {
      await api('/api/eia/inventories', {
        body: { weekEnding: week, kind, source: source || undefined, values: SERIES.map((s) => ({ series: s.id, levelKb: vals[s.id].level === '' ? null : Number(vals[s.id].level), changeKb: vals[s.id].change === '' ? null : Number(vals[s.id].change) })) },
      });
      notify('Inventory figures saved.', 'good');
      setVals(Object.fromEntries(SERIES.map((s) => [s.id, { level: '', change: '' }])));
      setN((x) => x + 1);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError) setErrors((e.data as { errors?: string[] })?.errors ?? [e.message]);
      else notify((e as Error).message, 'bad');
    }
  };
  const fetchEia = async () => {
    try {
      const r = await api<{ changed: number; arrived: string | null; errors: string[] }>('/api/eia/refresh', { method: 'POST' });
      notify(`EIA fetch: ${r.changed} row(s) updated${r.arrived ? `; release ${r.arrived} data arrival recorded` : ''}.`, 'good');
      setN((x) => x + 1);
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };
  const recompute = async (date: string) => {
    try {
      await api(`/api/eia/reactions/${date}/recompute`, { method: 'POST' });
      setN((x) => x + 1);
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };
  const nextRel = d?.summary.nextRelease;
  const pastReleases = (d?.releases ?? []).filter((r) => Date.parse(r.release_utc) + 15 * 60_000 <= Date.now());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>EIA inventories</h1>
          <p>Weekly Petroleum Status Report data. Actual EIA figures, API survey numbers and analyst estimates are stored and labeled separately; only EIA actuals drive the thesis exit.</p>
        </div>
      </div>
      {d ? (
        <>
          <div className="grid grid-2" style={{ alignItems: 'start' }}>
            <Card title="Next release" sub={nextRel ? `${nextRel.source === 'default-rule' ? 'Default Wednesday 10:30 ET rule — override holiday weeks in Settings' : 'User override'}` : ''}>
              {nextRel ? (
                <>
                  <div className="hero-value" style={{ fontSize: 28 }}>
                    {fmtDate(nextRel.releaseDate)} · {nextRel.timeEt} ET
                  </div>
                  <p className="small muted" style={{ marginTop: 4 }}>
                    Week ending {fmtDate(nextRel.weekEnding)} · {fmtLocal(nextRel.releaseUtc, zone)} your time
                  </p>
                </>
              ) : (
                <p className="empty">No release scheduled.</p>
              )}
              <div className="divider" />
              <p className="small">
                After the data arrives, the app captures the 0–15 minute reaction from quotes recorded for the exact contracts (exchange timestamps). With delayed data, the +15 minute quote is available roughly 25 minutes after release. Nothing is estimated.
              </p>
            </Card>
            <Card title="Thesis exit tracker" sub="Close both legs when EIA actuals confirm three consecutive weekly distillate builds.">
              <DistillateStreak inv={d.summary} />
              <div className="divider" />
              <div className="btn-row">
                <Badge tone={d.apiKeyConfigured ? 'good' : 'warn'} icon={d.apiKeyConfigured ? Icon.check : Icon.alert}>
                  EIA_API_KEY {d.apiKeyConfigured ? 'set' : 'not set'}
                </Badge>
                <button className="btn small" onClick={fetchEia} disabled={!d.apiKeyConfigured}>
                  {Icon.refresh} Fetch from EIA API
                </button>
              </div>
            </Card>
          </div>

          <Card title="Latest inventories" sub={d.summary.latestWeek ? `Latest EIA actual week ending ${fmtDate(d.summary.latestWeek)}` : 'No EIA actuals loaded'}>
            <InventoryTable inv={d.summary} />
          </Card>

          <Card title="Enter WPSR / API / estimate figures" sub="Thousand barrels (kb). Enter actual levels (change is derived from the prior week) or reported changes.">
            <div className="form">
              <div className="row">
                <label className="field" style={{ flex: '0 1 180px' }}>
                  <span>Week ending (Friday)</span>
                  <input type="date" value={week} onChange={(e) => setWeek(e.target.value)} />
                </label>
                <label className="field" style={{ flex: '0 1 220px' }}>
                  <span>Kind</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                    <option value="actual">EIA actual (WPSR)</option>
                    <option value="api">API survey (not EIA)</option>
                    <option value="estimate">Analyst estimate (not data)</option>
                  </select>
                </label>
                <label className="field">
                  <span>Source (optional)</span>
                  <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder={kind === 'actual' ? 'EIA WPSR (user-entered)' : kind === 'api' ? 'API weekly statistics via …' : 'Consensus via …'} />
                </label>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Series</th>
                      <th>Level (kb){kind !== 'actual' ? ' — actual only' : ''}</th>
                      <th>Change (kb)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SERIES.map((s) => (
                      <tr key={s.id}>
                        <td>{s.label}</td>
                        <td>
                          <input type="number" disabled={kind !== 'actual'} value={vals[s.id].level} onChange={(e) => setVals((v) => ({ ...v, [s.id]: { ...v[s.id], level: e.target.value } }))} />
                        </td>
                        <td>
                          <input type="number" value={vals[s.id].change} onChange={(e) => setVals((v) => ({ ...v, [s.id]: { ...v[s.id], change: e.target.value } }))} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {errors.length ? (
                <Alert tone="bad">
                  {errors.map((e) => (
                    <div key={e}>{e}</div>
                  ))}
                </Alert>
              ) : null}
              <div className="btn-row">
                <button className="btn primary" onClick={save}>
                  Save figures
                </button>
              </div>
            </div>
          </Card>

          <Card title="Release reactions" sub="One report per release; pending until the window has closed, the EIA data is recorded, and quotes exist.">
            {d.reactions.length ? (
              <div className="grid">
                {d.reactions.map((r) => (
                  <ReactionCard key={r.releaseDate} r={r} onRecompute={() => recompute(r.releaseDate)} />
                ))}
              </div>
            ) : (
              <>
                <p className="empty">No reaction captured yet. Captures run automatically on release days while the server is running.</p>
                {pastReleases.length ? (
                  <div className="btn-row">
                    {pastReleases.slice(0, 3).map((r) => (
                      <button key={r.release_date} className="btn small" onClick={() => recompute(r.release_date)}>
                        Compute {fmtDate(r.release_date)} from recorded quotes
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </Card>

          <Card title="Recorded inventory rows">
            {d.inventories.length ? (
              <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Week ending</th>
                      <th>Series</th>
                      <th>Kind</th>
                      <th className="num">Level</th>
                      <th className="num">Change</th>
                      <th>Source</th>
                      <th>Entered</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.inventories.map((r) => (
                      <tr key={r.id}>
                        <td>{r.weekEnding}</td>
                        <td>{r.series}</td>
                        <td>
                          <Badge tone={r.kind === 'actual' ? 'info' : 'warn'}>{r.kind === 'actual' ? 'EIA actual' : r.kind === 'api' ? 'API (not EIA)' : 'estimate'}</Badge>
                        </td>
                        <td className="num">{fmtNum(r.levelKb, 0)}</td>
                        <td className="num">{fmtNum(r.changeKb, 0, true)}</td>
                        <td className="small">{r.source}</td>
                        <td className="small">{fmtLocal(r.enteredAt, zone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">No inventory data recorded.</p>
            )}
          </Card>
        </>
      ) : data.error ? (
        <Alert tone="bad">{data.error}</Alert>
      ) : (
        <p className="empty">Loading…</p>
      )}
    </>
  );
}
