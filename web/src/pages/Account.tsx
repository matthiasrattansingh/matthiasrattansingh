import type { MarkPointDto, OrderDto } from '../../../src/shared/types.ts';
import { Alert, Badge, Card, Stat, useApp, useFetch } from '../components/ui.tsx';
import { LineChart } from '../components/LineChart.tsx';
import { fmtEt, fmtLocal, fmtNum, fmtUsd, pnlClass } from '../format.ts';
import { Icon } from '../icons.tsx';

export function DrawdownMeter({ pct, limit }: { pct: number; limit: number }) {
  const frac = Math.min(1, Math.max(0, pct / limit));
  const color = frac >= 0.8 ? 'var(--critical)' : frac >= 0.5 ? 'var(--warning)' : 'var(--accent)';
  const label = frac >= 0.8 ? 'Critical' : frac >= 0.5 ? 'Elevated' : 'Within limit';
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={pct} aria-label="Drawdown from peak equity">
        <div style={{ width: `${frac * 100}%`, background: color }} />
      </div>
      <div className="small" style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>
          <Badge tone={frac >= 0.8 ? 'bad' : frac >= 0.5 ? 'warn' : 'info'} icon={frac >= 0.5 ? Icon.alert : Icon.check}>
            {label}
          </Badge>{' '}
          {fmtNum(pct, 2)}% of {limit}% limit used
        </span>
        <span className="muted">liquidation at {limit}%</span>
      </div>
    </div>
  );
}

export function OrdersTable({ orders }: { orders: OrderDto[] }) {
  const { zone } = useApp();
  if (!orders.length) return <p className="empty">No simulated orders yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Submitted</th>
            <th>Order</th>
            <th>Status</th>
            <th className="num">Margin req.</th>
            <th>Reasons / notes</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{o.id}</td>
              <td className="small">{fmtLocal(o.submittedAt, zone)}</td>
              <td className="small">
                <strong>
                  {o.request.direction} {o.request.strategy}
                </strong>{' '}
                {o.request.legs.map((l) => l.contract).join(' / ')} × {o.request.quantity.contracts ?? (o.request.quantity.barrels ?? 0) / 1000}
                <div className="muted">
                  {o.request.entryMethod}
                  {o.request.entryMethod === 'limit' ? ` ${o.request.limitValue}` : ''} · {o.request.timeInForce}
                </div>
              </td>
              <td>
                <Badge tone={o.status === 'filled' ? 'good' : o.status === 'rejected' ? 'bad' : o.status === 'working' ? 'info' : ''}>{o.status}</Badge>
                {o.positionId ? <div className="small muted">→ position #{o.positionId}</div> : null}
              </td>
              <td className="num">{o.margin?.required.amount !== null && o.margin?.required.amount !== undefined ? fmtUsd(o.margin.required.amount) : 'unknown'}</td>
              <td className="small">{o.reasons.length ? o.reasons.join(' ') : o.request.rationale}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AccountPage() {
  const { state, zone } = useApp();
  const marks = useFetch<MarkPointDto[]>('/api/marks?limit=500', [state?.lastMark?.ts]);
  const orders = useFetch<OrderDto[]>('/api/orders', [state?.lastMark?.ts, state?.workingOrders.length]);
  if (!state) return null;
  const a = state.account;
  const bp = a.buyingPower;
  const pts = (marks.data ?? []).map((m) => ({ t: Date.parse(m.ts), v: m.equity, valid: m.valid }));
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Account</h1>
          <p>
            Simulated paper account #{a.id}, opened {fmtLocal(a.createdAt, zone)} with {fmtUsd(a.startingEquity)}. {a.costsConfigured ? 'Commissions/slippage are configured and applied to fills.' : 'No commissions or slippage configured: all P/L is gross before costs.'}
          </p>
        </div>
      </div>
      {a.status === 'halted' ? (
        <Alert tone="bad">
          <strong>Trading halted</strong> {a.haltedAt ? `at ${fmtLocal(a.haltedAt, zone)}` : ''}: {a.haltedReason} Start a new paper account in Settings to continue.
        </Alert>
      ) : null}
      {!a.equityValid ? (
        <Alert tone="warn">
          Equity is provisional: {a.equityReasons.join(' · ')}
        </Alert>
      ) : null}

      <div className="grid grid-2" style={{ alignItems: 'stretch' }}>
        <Card>
          <div className="stat-label">Marked equity</div>
          <div className="hero-value">{fmtUsd(a.equity)}</div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            {a.equityValid ? (
              <Badge tone="info" icon={Icon.check}>
                All marks valid
              </Badge>
            ) : (
              <Badge tone="warn" icon={Icon.alert}>
                Provisional
              </Badge>
            )}
            <span className={`small ${pnlClass(a.totalPnl)}`}>
              {fmtUsd(a.totalPnl, { sign: true })} total P/L since start
            </span>
          </div>
          <div className="divider" />
          <div className="section-title">Peak-to-current drawdown</div>
          <DrawdownMeter pct={a.drawdownPct} limit={a.maxDrawdownPct} />
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>Peak equity</dt>
            <dd>
              {fmtUsd(a.peakEquity)} <span className="muted small">({fmtLocal(a.peakAt, zone)}; raised only by fully valid marks)</span>
            </dd>
            <dt>Drawdown floor</dt>
            <dd>{fmtUsd(a.drawdownFloorEquity)}</dd>
            <dt>Distance to limit</dt>
            <dd className={a.distanceToLimitUsd <= 0 ? 'neg' : ''}>{fmtUsd(a.distanceToLimitUsd)}</dd>
          </dl>
        </Card>
        <Card title="Margin & buying power" sub="Margin is never inferred from notional. Unknown margin blocks new orders.">
          <div className="grid grid-2">
            <div className="stat">
              <div className="stat-label">Reserved initial margin</div>
              <div className="stat-value">{bp.reservedMargin === null ? 'Unknown' : fmtUsd(bp.reservedMargin)}</div>
              <div className="stat-note">{bp.reservedKnown ? 'open positions + working orders' : 'missing verified margin figures'}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Remaining buying power</div>
              <div className="stat-value">{bp.buyingPower === null ? 'Unknown' : fmtUsd(bp.buyingPower)}</div>
              <div className="stat-note">{bp.verified ? 'verified' : 'unverified — orders blocked'}</div>
            </div>
          </div>
          {bp.reasons.length ? (
            <div className="alerts" style={{ marginTop: 12 }}>
              {bp.reasons.map((r) => (
                <Alert key={r} tone="warn">
                  {r}
                </Alert>
              ))}
            </div>
          ) : (
            <Alert tone="good">Buying power is verified: every open leg is validly marked and every margin figure has a source and date.</Alert>
          )}
          <p className="small" style={{ marginTop: 10 }}>
            <a href="#/settings">Enter margin figures in Settings → Margin</a>
          </p>
        </Card>
      </div>

      <div className="grid grid-auto">
        <Stat label="Starting equity" value={fmtUsd(a.startingEquity)} />
        <Stat label="Realized P/L (gross)" value={fmtUsd(a.realizedGross, { sign: true })} className={pnlClass(a.realizedGross)} />
        <Stat
          label="Unrealized P/L"
          value={fmtUsd(a.unrealized ?? a.unrealizedProvisional, { sign: true })}
          className={pnlClass(a.unrealized ?? a.unrealizedProvisional)}
          note={a.equityValid ? 'gross, valid marks' : 'provisional'}
        />
        <Stat label="Fees paid" value={a.fees ? fmtUsd(a.fees) : '—'} note={a.costsConfigured ? 'configured commissions' : 'not configured'} />
        <Stat label="Total P/L" value={fmtUsd(a.totalPnl, { sign: true })} className={pnlClass(a.totalPnl)} note={a.equityValid ? undefined : 'provisional'} />
        <Stat label="Drawdown" value={`${fmtNum(a.drawdownPct, 2)}%`} note={`limit ${a.maxDrawdownPct}% from peak`} />
      </div>

      <Card title="Equity over time" sub={`Each point is a recorded mark (hourly, quote entry, order or refresh). Last mark ${state.lastMark ? fmtEt(state.lastMark.ts) : '—'}.`}>
        <LineChart points={pts} zone={zone} label="Marked account equity over time" format={(v) => fmtUsd(v, { compact: true })} refLines={[{ value: a.drawdownFloorEquity, label: `DD floor ${fmtUsd(a.drawdownFloorEquity, { compact: true })}`, tone: 'critical' }]} />
      </Card>

      <Card title="Simulated orders" sub="Accepted, filled, rejected (with reasons), cancelled and expired orders.">
        <OrdersTable orders={orders.data ?? []} />
      </Card>
    </>
  );
}
