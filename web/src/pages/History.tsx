import { useState } from 'react';
import type { EventDto, JobDto, MarkPointDto, OrderDto, UpdateReportDto } from '../../../src/shared/types.ts';
import { Badge, Card, useApp, useFetch } from '../components/ui.tsx';
import { OrdersTable } from './Account.tsx';
import { fmtEt, fmtLocal, fmtNum, fmtPrice, fmtUsd, pnlClass } from '../format.ts';

const TYPE_FILTERS = [
  { v: '', l: 'All' },
  { v: 'decision', l: 'Decisions' },
  { v: 'order', l: 'Orders' },
  { v: 'position', l: 'Fills & exits' },
  { v: 'risk', l: 'Risk / liquidations' },
  { v: 'update', l: 'Scheduled updates' },
  { v: 'quote', l: 'Quotes' },
  { v: 'eia', l: 'EIA' },
  { v: 'settings', l: 'Settings' },
  { v: 'margin', l: 'Margin' },
];

function tone(type: string): string {
  if (type.startsWith('risk') || type === 'order.rejected') return 'bad';
  if (type.startsWith('position') || type === 'order.filled') return 'good';
  if (type.startsWith('update.missed')) return 'warn';
  if (type.startsWith('decision') || type.startsWith('order')) return 'info';
  return '';
}

function Timeline() {
  const { zone, state } = useApp();
  const [type, setType] = useState('');
  const events = useFetch<EventDto[]>(`/api/history?limit=400${type ? `&type=${type}` : ''}`, [state?.lastMark?.ts]);
  return (
    <>
      <div className="btn-row" style={{ marginBottom: 12 }}>
        {TYPE_FILTERS.map((f) => (
          <button key={f.v} className={`btn small ${type === f.v ? 'primary' : ''}`} onClick={() => setType(f.v)}>
            {f.l}
          </button>
        ))}
      </div>
      {events.data?.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time ({zone})</th>
                <th>Type</th>
                <th>Event</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((e) => (
                <tr key={e.id}>
                  <td className="small nowrap">{fmtLocal(e.ts, zone, true)}</td>
                  <td>
                    <Badge tone={tone(e.type)}>{e.type}</Badge>
                  </td>
                  <td className="small">
                    {e.summary}
                    {e.detail && (e.type.startsWith('risk') || e.type.startsWith('position') || e.type === 'order.filled') ? (
                      <details style={{ marginTop: 4 }}>
                        <summary>Details</summary>
                        <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                          {JSON.stringify(e.detail, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="empty">No events.</p>
      )}
    </>
  );
}

function UpdateCard({ u }: { u: UpdateReportDto }) {
  const { zone } = useApp();
  const r = u.report;
  const slot = u.slotKey.replace('hourly:', '');
  return (
    <details className="card tight">
      <summary>
        <strong>{fmtEt(slot)}</strong> slot · equity {fmtUsd(r.account.equity)}
        {r.account.equityValid ? '' : ' (provisional)'} · DD {fmtNum(r.account.drawdownPct, 2)}%{' '}
        {r.fetch.attempted && !r.fetch.ok ? <Badge tone="bad">fetch failed</Badge> : null} {r.events.length ? <Badge tone="warn">{r.events.length} event(s)</Badge> : null}
      </summary>
      <p className="small muted">Recorded {fmtLocal(u.createdAt, zone, true)} · provider {r.provider}{r.fetch.errors.length ? ` · issues: ${r.fetch.errors.join('; ')}` : ''}</p>
      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table>
          <thead>
            <tr>
              <th>Leg</th>
              <th className="num">Price</th>
              <th>Exchange time</th>
              <th>Source</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {r.legs.map((l) => (
              <tr key={l.contract}>
                <td className="mono">{l.contract}</td>
                <td className="num">
                  {fmtPrice(l.contract, l.price)} <span className="small muted">{l.unit}</span>
                </td>
                <td className="small">{fmtEt(l.exchangeTs)}</td>
                <td className="small">{l.source ?? '—'}</td>
                <td className="small">
                  <Badge tone={l.status === 'delayed' || l.status === 'closed-last' ? 'info' : 'warn'}>{l.status}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="kv" style={{ marginTop: 8 }}>
        {r.positions.map((p) => (
          <div key={p.id} style={{ display: 'contents' }}>
            <dt>#{p.id} value</dt>
            <dd>
              {fmtNum(p.value, 3)} vs entry {fmtNum(p.entryValue, 3)} → <span className={pnlClass(p.unrealized)}>{fmtUsd(p.unrealized, { sign: true })}</span>
              {p.valid ? '' : ` (provisional: ${p.missing.join('; ')})`}
            </dd>
          </div>
        ))}
        <dt>Realized / unrealized</dt>
        <dd>
          {fmtUsd(r.account.realized, { sign: true })} / {fmtUsd(r.account.unrealized, { sign: true })} {r.account.grossBeforeCosts ? '(gross before costs)' : `(fees ${fmtUsd(r.account.fees)})`}
        </dd>
        <dt>Total P/L · equity</dt>
        <dd>
          {fmtUsd(r.account.totalPnl, { sign: true })} · {fmtUsd(r.account.equity)} (peak {fmtUsd(r.account.peakEquity)})
        </dd>
        <dt>Margin · buying power</dt>
        <dd>
          {r.account.reservedMargin === null ? 'unknown' : fmtUsd(r.account.reservedMargin)} · {r.account.buyingPower === null ? 'unknown' : fmtUsd(r.account.buyingPower)} {r.account.buyingPowerVerified ? '' : '(unverified)'}
        </dd>
        <dt>Distance to DD limit</dt>
        <dd>{fmtUsd(r.account.distanceToLimitUsd)}</dd>
      </dl>
      {r.events.length ? (
        <ul className="bullets small" style={{ marginTop: 8 }}>
          {r.events.map((e, i) => (
            <li key={i}>
              {fmtEt(e.ts, false)} [{e.type}] {e.summary}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted" style={{ marginTop: 8 }}>
          No rejected orders, triggered exits or liquidations since the previous update.
        </p>
      )}
    </details>
  );
}

export function HistoryPage() {
  const { state, zone } = useApp();
  const [tab, setTab] = useState<'timeline' | 'updates' | 'marks' | 'orders' | 'jobs'>('timeline');
  const updates = useFetch<UpdateReportDto[]>(tab === 'updates' ? '/api/updates?limit=72' : null, [state?.lastMark?.ts]);
  const marks = useFetch<MarkPointDto[]>(tab === 'marks' ? '/api/marks?limit=1000' : null, [state?.lastMark?.ts]);
  const orders = useFetch<OrderDto[]>(tab === 'orders' ? '/api/orders' : null);
  const jobs = useFetch<JobDto[]>(tab === 'jobs' ? '/api/jobs?limit=150' : null, [state?.lastMark?.ts]);
  if (!state) return null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>History</h1>
          <p>Durable ledger: timestamped marks, your decisions, exit triggers, simulated fills, rejections, liquidations and scheduler runs.</p>
        </div>
      </div>
      <Card>
        <div className="tabs" role="tablist">
          {(
            [
              ['timeline', 'Timeline'],
              ['updates', 'Hourly updates'],
              ['marks', 'Marks'],
              ['orders', 'Orders'],
              ['jobs', 'Scheduler log'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          {tab === 'timeline' ? <Timeline /> : null}
          {tab === 'updates' ? (
            updates.data?.length ? (
              <div className="grid" style={{ gap: 8 }}>
                {updates.data.map((u) => (
                  <UpdateCard key={u.slotKey} u={u} />
                ))}
              </div>
            ) : (
              <p className="empty">No hourly updates recorded yet. They run at the top of each hour during NYMEX hours while the server is running. Updates are recorded here only — no notifications are sent.</p>
            )
          ) : null}
          {tab === 'marks' ? (
            <div className="table-wrap" style={{ maxHeight: 600, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Time ({zone})</th>
                    <th>Trigger</th>
                    <th className="num">Equity</th>
                    <th className="num">Drawdown</th>
                    <th>Position values</th>
                    <th>Valid</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(marks.data ?? [])].reverse().map((m, i) => (
                    <tr key={i}>
                      <td className="small nowrap">{fmtLocal(m.ts, zone, true)}</td>
                      <td className="small">{m.trigger}</td>
                      <td className="num">{fmtUsd(m.equity)}</td>
                      <td className="num">{fmtNum(m.drawdownPct, 2)}%</td>
                      <td className="small">
                        {Object.entries(m.values)
                          .map(([id, v]) => `#${id}: ${fmtNum(v, 3)}`)
                          .join(' · ') || '—'}
                      </td>
                      <td>{m.valid ? <Badge tone="info">valid</Badge> : <Badge tone="warn">provisional</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {tab === 'orders' ? <OrdersTable orders={orders.data ?? []} /> : null}
          {tab === 'jobs' ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Scheduled</th>
                    <th>Status</th>
                    <th>Finished</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs.data ?? []).map((j) => (
                    <tr key={j.key}>
                      <td className="small mono">{j.kind}</td>
                      <td className="small">{fmtEt(j.scheduledFor)}</td>
                      <td>
                        <Badge tone={j.status === 'ok' ? 'good' : j.status === 'missed' || j.status === 'partial' ? 'warn' : j.status === 'failed' ? 'bad' : ''}>{j.status}</Badge>
                        {j.attempts > 1 ? <span className="small muted"> ×{j.attempts}</span> : null}
                      </td>
                      <td className="small">{j.finishedAt ? fmtLocal(j.finishedAt, zone, true) : '—'}</td>
                      <td className="small muted" style={{ maxWidth: 420 }}>
                        {j.detail ? JSON.stringify(j.detail).slice(0, 220) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </Card>
    </>
  );
}
