import { useState } from 'react';
import type { MarkPointDto, NoteDto, PositionDto } from '../../../src/shared/types.ts';
import { api } from '../api.ts';
import { Alert, Badge, Card, FreshBadge, useApp, useFetch } from '../components/ui.tsx';
import { LineChart } from '../components/LineChart.tsx';
import { fmtDate, fmtEt, fmtLocal, fmtNum, fmtPrice, fmtUsd, pnlClass } from '../format.ts';
import { Icon } from '../icons.tsx';

function LegTable({ p }: { p: PositionDto }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Leg</th>
            <th>Side</th>
            <th className="num">Size</th>
            <th className="num">Mark</th>
            <th className="num">$/bbl</th>
            <th>Exchange time · source</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {p.legs.map((l) => {
            const m = p.mark?.legs.find((x) => x.contract === l.contract);
            const side = p.direction * l.weight === 1 ? 'Long' : 'Short';
            const gal = l.contract.startsWith('HO') || l.contract.startsWith('RB');
            const fill = p.entryFills?.find((f) => f.contract === l.contract);
            return (
              <tr key={l.contract}>
                <td>
                  <strong className="mono">{l.contract}</strong>
                  <div className="small muted">{m?.label.replace(` (${l.contract})`, '')}</div>
                  <div className="small muted">Last trade {m?.lastTradingDay}</div>
                </td>
                <td>{side}</td>
                <td className="num">
                  {p.contractsPerLeg} × {gal ? '42,000 gal' : '1,000 bbl'}
                  <div className="small muted">= {(p.contractsPerLeg * 1000).toLocaleString('en-US')} bbl</div>
                </td>
                <td className="num">
                  {m?.quote ? (
                    <>
                      <strong>{fmtPrice(l.contract, m.quote.price)}</strong> <span className="small muted">{m.unit}</span>
                    </>
                  ) : (
                    '—'
                  )}
                  {fill ? <div className="small muted">entry {fmtPrice(l.contract, fill.price)}</div> : null}
                </td>
                <td className="num">{m?.quote ? fmtNum(m.quote.perBarrel, gal ? 4 : 2) : '—'}</td>
                <td className="small">
                  {m?.quote ? (
                    <>
                      {fmtEt(m.quote.exchangeTs)}
                      <div className="muted">{m.quote.source}</div>
                    </>
                  ) : (
                    <span className="muted">No quote for this exact contract</span>
                  )}
                </td>
                <td>{m ? <FreshBadge status={m.freshness.status} title={m.freshness.reason} /> : null}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Arithmetic({ p }: { p: PositionDto }) {
  const legs = p.mark?.legs ?? [];
  const priced = p.legs.every((l) => legs.find((m) => m.contract === l.contract)?.quote);
  const terms = p.legs.map((l, i) => {
    const m = legs.find((x) => x.contract === l.contract);
    const gal = l.contract.startsWith('HO') || l.contract.startsWith('RB');
    const price = m?.quote ? fmtPrice(l.contract, m.quote.price) : l.contract;
    const t = gal ? `${price} × 42` : price;
    return `${i === 0 ? (l.weight === 1 ? '' : '−') : l.weight === 1 ? ' + ' : ' − '}${t}`;
  });
  return (
    <div className="small" style={{ display: 'grid', gap: 4, background: 'var(--surface-2)', borderRadius: 8, padding: '10px 12px' }}>
      <div>
        <span className="muted">Formula:</span> <span className="mono">{p.valueFormula}</span>
      </div>
      <div>
        <span className="muted">Conversion:</span> 1 bbl = 42 gal; HO/RB 1 contract = 42,000 gal = 1,000 bbl; BZ/CL 1 contract = 1,000 bbl.
      </div>
      {priced && p.mark?.value !== null && p.mark?.value !== undefined ? (
        <>
          <div>
            <span className="muted">Current value:</span> <span className="mono">{terms.join('')} = {fmtNum(p.mark.value, 3)} $/bbl</span>
          </div>
          <div>
            <span className="muted">Gross P/L:</span>{' '}
            <span className="mono">
              {p.direction === 1 ? '' : '−'}({fmtNum(p.mark.value, 3)} − {fmtNum(p.entryValue, 3)}) × {p.barrels.toLocaleString('en-US')} bbl = {fmtUsd(p.mark.unrealized)}
            </span>{' '}
            {p.mark.valid ? null : <Badge tone="warn">provisional</Badge>}
          </div>
        </>
      ) : (
        <div className="muted">Current value unavailable until every leg has a quote for its exact contract.</div>
      )}
    </div>
  );
}

function PositionCard({ p, history }: { p: PositionDto; history: MarkPointDto[] }) {
  const { state, zone, refresh, notify } = useApp();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const mark = p.mark;
  const close = async () => {
    if (!window.confirm(`Request a simulated close of #${p.id}? It fills at ${state?.settings.fillPolicy === 'next_mark_after_submit' ? 'the first valid mark with exchange time after now' : 'the current valid mark'}. No real order is sent.`)) return;
    setBusy(true);
    try {
      const r = await api<{ actions: { summary: string }[] }>(`/api/positions/${p.id}/close`, { body: { note } });
      notify(r.actions.length ? r.actions.map((a) => a.summary).join('; ') : 'Close requested — pending the next valid mark.', 'info');
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const pts = history.filter((h) => h.values[String(p.id)] !== undefined && h.values[String(p.id)] !== null).map((h) => ({ t: Date.parse(h.ts), v: h.values[String(p.id)], valid: h.valid }));
  return (
    <Card
      title={
        <span>
          #{p.id} {p.label}
        </span>
      }
      sub={`Opened ${fmtLocal(p.openedAt, zone)} · ${p.entryKind === 'seed' ? 'preloaded simulated paper fill' : `simulated fill from order #${p.orderId}`}`}
      actions={
        <>
          {p.status === 'exit_pending' ? (
            <Badge tone="warn" icon={Icon.clock}>
              Exit pending
            </Badge>
          ) : (
            <Badge tone="info">Open</Badge>
          )}
          <Badge>Paper only</Badge>
        </>
      }
    >
      <div className="grid grid-auto" style={{ marginBottom: 12 }}>
        <div className="stat">
          <div className="stat-label">Entry (fixed)</div>
          <div className="stat-value">{fmtNum(p.entryValue, 3)}</div>
          <div className="stat-note">$/bbl net {p.strategy === 'outright' ? 'price' : 'spread'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Current {p.strategy === 'crack' ? 'net crack' : 'value'}</div>
          <div className="stat-value">{fmtNum(mark?.value ?? null, 3)}</div>
          <div className="stat-note">{mark?.valid ? 'valid marks' : mark?.value !== null ? 'provisional — see legs' : 'unavailable'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Unrealized P/L</div>
          <div className={`stat-value ${pnlClass(mark?.unrealized)}`}>{fmtUsd(mark?.unrealized ?? null, { sign: true })}</div>
          <div className="stat-note">{state?.account.costsConfigured ? 'gross; costs shown in Account' : 'gross before costs'}{mark?.valid ? '' : ' · provisional'}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Drawdown liquidation level</div>
          <div className="stat-value">{fmtNum(p.drawdownTriggerValue ?? null, 3)}</div>
          <div className="stat-note">value at which equity hits the {state?.account.maxDrawdownPct}% floor (others held constant)</div>
        </div>
      </div>
      {mark && !mark.valid ? (
        <Alert tone="warn">
          P/L is provisional. Missing or stale inputs: {mark.missing.join(' · ')}
        </Alert>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <LegTable p={p} />
      </div>
      <div style={{ marginTop: 12 }}>
        <Arithmetic p={p} />
      </div>
      <div className="grid grid-2" style={{ marginTop: 14 }}>
        <div>
          <div className="section-title">Exit / stop rule</div>
          <p>{p.exitRuleText ?? '—'}</p>
          <ul className="bullets small" style={{ marginTop: 6 }}>
            {(p.ruleStatus ?? []).map((r, i) => (
              <li key={i}>{r.text}</li>
            ))}
            {state?.settings.expiryGuardEnabled ? <li>Expiry guard: closes at {state.settings.expiryGuardTimeEt} ET on the earliest leg's computed last trading day.</li> : null}
          </ul>
          {p.exitPending ? (
            <Alert tone="warn">
              Exit pending ({p.exitPending.kind}): {p.exitPending.reason} Fills at the first valid mark with exchange time ≥ {fmtEt(p.exitPending.notBefore)}.
            </Alert>
          ) : null}
          {p.rationale ? (
            <>
              <div className="section-title" style={{ marginTop: 10 }}>
                Rationale
              </div>
              <p className="ink2">{p.rationale}</p>
            </>
          ) : null}
        </div>
        <div>
          <div className="section-title">Margin</div>
          {p.margin?.known ? (
            <p>
              <strong>{fmtUsd(p.margin.amount)}</strong> reserved · {p.margin.explanation}
            </p>
          ) : (
            <Alert tone="warn">
              <strong>Margin status: unknown — not verified.</strong> {p.margin?.explanation} Until then reserved margin and buying power are unknown and new orders are blocked.
            </Alert>
          )}
          <div className="section-title" style={{ marginTop: 10 }}>
            Entry record
          </div>
          <p className="small ink2">{p.entryNote}</p>
        </div>
      </div>
      <div style={{ marginTop: 14 }}>
        <div className="section-title">Marked value history ($/bbl)</div>
        <LineChart
          points={pts}
          zone={zone}
          label={`Position ${p.id} marked value over time`}
          format={(v) => fmtNum(v, 2)}
          refLines={[
            { value: p.entryValue, label: `Entry ${fmtNum(p.entryValue, 3)}`, tone: 'muted' },
            ...(p.drawdownTriggerValue !== null && p.drawdownTriggerValue !== undefined ? [{ value: p.drawdownTriggerValue, label: `DD limit ${fmtNum(p.drawdownTriggerValue, 2)}`, tone: 'critical' as const }] : []),
          ]}
        />
      </div>
      <div className="divider" />
      <div className="row">
        <label className="field">
          <span>Close note (optional)</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why are you closing?" />
        </label>
        <button className="btn danger" onClick={close} disabled={busy || p.status === 'exit_pending'}>
          Request simulated close
        </button>
      </div>
    </Card>
  );
}

function WatchItem({ n }: { n: NoteDto }) {
  const { notify, refresh } = useApp();
  const [body, setBody] = useState(n.body ?? '');
  const save = async () => {
    try {
      await api(`/api/notes/${n.id}`, { method: 'PUT', body: { title: n.title, body } });
      notify('Watch-only notes saved.', 'good');
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };
  return (
    <Card title={n.title} sub="Watch-only: excluded from positions, buying power, margin and P/L." actions={<Badge icon={Icon.eye}>Watch-only</Badge>}>
      <label className="field">
        <span>Notes (strikes, expiry, premium, etc.)</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn small" onClick={save}>
          Save notes
        </button>
      </div>
    </Card>
  );
}

export function PositionsPage() {
  const { state } = useApp();
  const marks = useFetch<MarkPointDto[]>('/api/marks?limit=500', [state?.lastMark?.ts]);
  if (!state) return null;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Open positions</h1>
          <p>Simulated paper positions. Entry spreads are fixed at fill; marks come only from quotes for the matching contract months.</p>
        </div>
      </div>
      {state.positions.length ? state.positions.map((p) => <PositionCard key={p.id} p={p} history={marks.data ?? []} />) : <Card title="No open positions">Use Trade entry to submit a simulated trade.</Card>}
      {state.watchItems.map((n) => (
        <WatchItem key={n.id} n={n} />
      ))}
      <Card title="Closed positions" sub="Realized P/L is gross (exit − entry) × barrels; commissions are listed separately when configured.">
        {state.closedPositions.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Position</th>
                  <th className="num">Entry</th>
                  <th className="num">Exit</th>
                  <th className="num">Realized (gross)</th>
                  <th className="num">Fees</th>
                  <th>Closed</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {state.closedPositions.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>{p.label}</td>
                    <td className="num">{fmtNum(p.entryValue, 3)}</td>
                    <td className="num">{fmtNum(p.exitValue, 3)}</td>
                    <td className={`num ${pnlClass(p.realizedGross)}`}>{fmtUsd(p.realizedGross, { sign: true })}</td>
                    <td className="num">{p.entryCommission === null && p.exitCommission === null ? '—' : fmtUsd((p.entryCommission ?? 0) + (p.exitCommission ?? 0))}</td>
                    <td className="small">{fmtEt(p.closedAt)}</td>
                    <td className="small">
                      <Badge tone={p.exitKind === 'drawdown' ? 'bad' : ''}>{p.exitKind}</Badge> {p.exitReason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No closed positions yet.</p>
        )}
      </Card>
      <p className="small muted">Dates use computed CME last-trading days (e.g. {fmtDate('2026-10-30')} for HOX2026/BZZ2026); verify against the exchange calendar.</p>
    </>
  );
}
