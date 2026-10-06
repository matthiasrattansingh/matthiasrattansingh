import { useEffect, useMemo, useState } from 'react';
import type { ExitRule, OrderDto, OrderPreviewDto, OrderRequestDto } from '../../../src/shared/types.ts';
import { api, ApiError, newKey } from '../api.ts';
import { Alert, Badge, Card, useApp, useFetch } from '../components/ui.tsx';
import { fmtDate, fmtEt, fmtNum, fmtUsd } from '../format.ts';
import { Icon } from '../icons.tsx';
import type { ContractList } from './Market.tsx';

type Strategy = 'crack' | 'calendar' | 'outright';

function ContractSelect({ lists, products, value, onChange, label }: { lists: ContractList[]; products: string[]; value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {lists
          .filter((p) => products.includes(p.product))
          .map((p) => (
            <optgroup key={p.product} label={`${p.name} · ${p.contractSize} · ${p.unit}`}>
              {p.contracts.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.label.split(' (')[0].replace(/^.*? (\w{3} \d{4})$/, '$1')} · {c.position} · LTD {c.lastTradingDay}
                </option>
              ))}
            </optgroup>
          ))}
      </select>
    </label>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="field" style={{ flex: '0 0 auto' }}>
      <span>{label}</span>
      <div className="segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button key={o.v} type="button" aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
            {o.l}
          </button>
        ))}
      </div>
    </div>
  );
}

function MarginPanel({ p }: { p: OrderPreviewDto }) {
  const m = p.margin;
  if (!m) return null;
  const req = m.required;
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          <tr>
            <td>Required initial margin</td>
            <td className="num">
              <strong>{req.known ? fmtUsd(req.amount) : 'Unknown'}</strong>
            </td>
          </tr>
          <tr>
            <td colSpan={2} className="small">
              {req.known ? (
                <>
                  {req.explanation}
                  <ul className="bullets" style={{ marginTop: 4 }}>
                    {req.figures.map((f) => (
                      <li key={f.key}>
                        <span className="mono">{f.key}</span>: {fmtUsd(f.perUnitUsd)} per {f.key.startsWith('SPREAD:') ? 'spread unit' : 'contract'} — source: {f.source}, as of {fmtDate(f.asOfDate)}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <span className="neg">{req.explanation}</span>
              )}
            </td>
          </tr>
          <tr>
            <td>Current equity</td>
            <td className="num">
              {fmtUsd(m.before.equity)} {m.before.equityValid ? null : <Badge tone="warn">provisional</Badge>}
            </td>
          </tr>
          <tr>
            <td>Reserved margin (before → after)</td>
            <td className="num">
              {m.before.reservedMargin === null ? 'Unknown' : fmtUsd(m.before.reservedMargin)} → {m.reservedAfter === null ? 'Unknown' : fmtUsd(m.reservedAfter)}
            </td>
          </tr>
          <tr>
            <td>Buying power (before → after)</td>
            <td className="num">
              <strong>
                {m.before.buyingPower === null ? 'Unknown' : fmtUsd(m.before.buyingPower)} → {m.buyingPowerAfter === null ? 'Unknown' : fmtUsd(m.buyingPowerAfter)}
              </strong>
            </td>
          </tr>
          <tr>
            <td>Verified</td>
            <td className="num">{m.before.verified && req.known ? <Badge tone="good" icon={Icon.check}>Yes</Badge> : <Badge tone="bad" icon={Icon.x}>No</Badge>}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function TradePage() {
  const { state, refresh, notify } = useApp();
  const lists = useFetch<ContractList[]>('/api/contracts');
  const [strategy, setStrategy] = useState<Strategy>('crack');
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [legA, setLegA] = useState('HOZ2026');
  const [legB, setLegB] = useState('BZF2027');
  const [qtyMode, setQtyMode] = useState<'contracts' | 'barrels'>('contracts');
  const [qty, setQty] = useState('1');
  const [entryMethod, setEntryMethod] = useState<'market' | 'limit'>('market');
  const [limitValue, setLimitValue] = useState('');
  const [tif, setTif] = useState<'day' | 'gtc'>('day');
  const [rationale, setRationale] = useState('');
  const [exitText, setExitText] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [maxLoss, setMaxLoss] = useState('');
  const [eiaWeeks, setEiaWeeks] = useState('');
  const [closeDate, setCloseDate] = useState('');
  const [key, setKey] = useState(newKey);
  const [preview, setPreview] = useState<OrderPreviewDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lastResult, setLastResult] = useState<{ order: OrderDto; duplicate: boolean } | null>(null);
  const working = useFetch<OrderDto[]>('/api/orders', [state?.workingOrders.length, lastResult?.order.id]);

  // Sensible defaults per strategy once contracts load.
  useEffect(() => {
    if (!lists.data) return;
    const first = (p: string, i = 0) => lists.data!.find((x) => x.product === p)?.contracts[i]?.code ?? '';
    if (strategy === 'crack') {
      setLegA(first('HO', 1));
      setLegB(first('BZ', 1));
    } else if (strategy === 'calendar') {
      setLegA(first('BZ', 0));
      setLegB(first('BZ', 1));
    } else {
      setLegA(first('BZ', 1));
    }
  }, [strategy, lists.data]);

  // Calendar legs must share a product: follow the near leg's product.
  useEffect(() => {
    if (strategy !== 'calendar' || !lists.data || legB.slice(0, 2) === legA.slice(0, 2)) return;
    const codes = lists.data.find((x) => x.product === legA.slice(0, 2))?.contracts ?? [];
    const idx = codes.findIndex((c) => c.code === legA);
    setLegB(codes[idx + 1]?.code ?? codes[0]?.code ?? '');
  }, [strategy, legA, legB, lists.data]);

  const rules: ExitRule[] = useMemo(() => {
    const r: ExitRule[] = [];
    if (stop.trim()) r.push({ type: 'stop_value', level: Number(stop) });
    if (target.trim()) r.push({ type: 'target_value', level: Number(target) });
    if (maxLoss.trim()) r.push({ type: 'max_loss_usd', amount: Number(maxLoss) });
    if (eiaWeeks.trim()) r.push({ type: 'eia_distillate_builds', weeks: Number(eiaWeeks) });
    if (closeDate) r.push({ type: 'close_on_date', date: closeDate, timeEt: '12:00' });
    return r;
  }, [stop, target, maxLoss, eiaWeeks, closeDate]);

  const request: OrderRequestDto = useMemo(
    () => ({
      idempotencyKey: key,
      strategy,
      direction,
      legs: strategy === 'outright' ? [{ contract: legA, weight: 1 }] : [{ contract: legA, weight: 1 }, { contract: legB, weight: -1 }],
      quantity: qtyMode === 'contracts' ? { contracts: Number(qty) } : { barrels: Number(qty) },
      entryMethod,
      limitValue: entryMethod === 'limit' ? Number(limitValue) : null,
      timeInForce: tif,
      rationale,
      exitRuleText: exitText,
      exitRules: rules,
    }),
    [key, strategy, direction, legA, legB, qtyMode, qty, entryMethod, limitValue, tif, rationale, exitText, rules],
  );

  useEffect(() => {
    if (!legA) return;
    const t = window.setTimeout(() => {
      api<OrderPreviewDto>('/api/orders/preview', { body: request })
        .then(setPreview)
        .catch(() => setPreview(null));
    }, 300);
    return () => window.clearTimeout(t);
  }, [request, legA, state?.lastMark?.ts]);

  const submit = async () => {
    setSubmitting(true);
    try {
      const r = await api<{ order: OrderDto; duplicate: boolean }>('/api/orders', { body: request });
      setLastResult(r);
      notify(r.duplicate ? `Duplicate submission ignored — order #${r.order.id} already exists.` : `Order #${r.order.id} accepted (simulated). It fills at the first valid mark per the fill policy.`, r.duplicate ? 'warn' : 'good');
      setKey(newKey());
      await refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const r = e.data as { order: OrderDto; duplicate: boolean };
        setLastResult(r);
        notify(`Order rejected and logged: ${r.order.reasons.join(' ')}`, 'bad');
        setKey(newKey());
        await refresh();
      } else {
        // Network or server error: keep the same idempotency key so a retry cannot duplicate.
        notify(`${(e as Error).message} — you can retry safely (same idempotency key).`, 'bad');
      }
    } finally {
      setSubmitting(false);
    }
  };
  const cancel = async (id: number) => {
    try {
      await api(`/api/orders/${id}/cancel`, { method: 'POST' });
      notify(`Order #${id} cancelled.`, 'info');
      working.reload();
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };

  if (!state) return null;
  const valueUnit = '$/bbl';
  const legLabels = strategy === 'crack' ? ['Product leg (bought when long)', 'Crude leg (sold when long)'] : strategy === 'calendar' ? ['Near month (bought when long)', 'Far month (sold when long)'] : ['Contract'];
  const workingOrders = (working.data ?? []).filter((o) => o.status === 'working');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Trade entry</h1>
          <p>
            Simulated orders only — nothing is sent to a broker or exchange. One decision per weekday (limit {state.settings.dailyTradeLimit || 'none'}; {state.tradesToday} used today).
          </p>
        </div>
      </div>
      {state.account.status === 'halted' ? <Alert tone="bad">Trading halted: {state.account.haltedReason}</Alert> : null}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <Card title="Order ticket">
          <div className="form">
            <div className="row">
              <Seg
                label="Instrument"
                value={strategy}
                onChange={setStrategy}
                options={[
                  { v: 'crack', l: 'Crack spread' },
                  { v: 'calendar', l: 'Calendar spread' },
                  { v: 'outright', l: 'Outright' },
                ]}
              />
              <Seg
                label="Side"
                value={direction}
                onChange={setDirection}
                options={[
                  { v: 'long', l: 'Long' },
                  { v: 'short', l: 'Short' },
                ]}
              />
            </div>
            {lists.data ? (
              <div className="row">
                <ContractSelect lists={lists.data} products={strategy === 'crack' ? ['HO', 'RB'] : strategy === 'calendar' ? ['HO', 'RB', 'BZ', 'CL'] : ['HO', 'RB', 'BZ', 'CL']} value={legA} onChange={setLegA} label={legLabels[0]} />
                {strategy !== 'outright' ? (
                  <ContractSelect lists={lists.data} products={strategy === 'crack' ? ['BZ', 'CL'] : [legA.slice(0, 2)]} value={legB} onChange={setLegB} label={legLabels[1]} />
                ) : null}
              </div>
            ) : (
              <p className="empty">Loading contracts…</p>
            )}
            <div className="row">
              <Seg
                label="Size in"
                value={qtyMode}
                onChange={(v) => {
                  setQtyMode(v);
                  setQty(v === 'barrels' ? String(Number(qty || 1) * 1000) : String(Math.max(1, Math.round(Number(qty || 1000) / 1000))));
                }}
                options={[
                  { v: 'contracts', l: 'Contracts' },
                  { v: 'barrels', l: 'Barrels' },
                ]}
              />
              <label className="field" style={{ flex: '0 1 160px' }}>
                <span>{qtyMode === 'contracts' ? 'Contracts per leg' : 'Barrels per leg'}</span>
                <input type="number" min={qtyMode === 'contracts' ? 1 : 1000} step={qtyMode === 'contracts' ? 1 : 1000} value={qty} onChange={(e) => setQty(e.target.value)} />
                <small>1 contract = 1,000 bbl (HO/RB: 42,000 gal)</small>
              </label>
            </div>
            <div className="row">
              <Seg
                label="Entry method"
                value={entryMethod}
                onChange={setEntryMethod}
                options={[
                  { v: 'market', l: 'Market (next valid mark)' },
                  { v: 'limit', l: 'Limit' },
                ]}
              />
              {entryMethod === 'limit' ? (
                <label className="field" style={{ flex: '0 1 160px' }}>
                  <span>Limit ({valueUnit})</span>
                  <input type="number" step="0.001" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} />
                </label>
              ) : null}
              <Seg
                label="Time in force"
                value={tif}
                onChange={setTif}
                options={[
                  { v: 'day', l: 'Day' },
                  { v: 'gtc', l: 'GTC' },
                ]}
              />
            </div>
            <label className="field">
              <span>Rationale</span>
              <textarea value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="What did you see in the data, and why this structure?" />
            </label>
            <label className="field">
              <span>Exit / stop rule (in words)</span>
              <input type="text" value={exitText} onChange={(e) => setExitText(e.target.value)} placeholder="e.g. Stop at 25.50; take profit at 31.00; exit if distillates build 3 weeks" />
            </label>
            <details open>
              <summary>Machine-enforced exit rules (optional, evaluated on valid marks)</summary>
              <div className="row">
                <label className="field">
                  <span>Stop level ({valueUnit})</span>
                  <input type="number" step="0.001" value={stop} onChange={(e) => setStop(e.target.value)} />
                </label>
                <label className="field">
                  <span>Target level ({valueUnit})</span>
                  <input type="number" step="0.001" value={target} onChange={(e) => setTarget(e.target.value)} />
                </label>
                <label className="field">
                  <span>Max loss (USD)</span>
                  <input type="number" step="100" value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} />
                </label>
                <label className="field">
                  <span>EIA distillate builds (weeks)</span>
                  <input type="number" min={1} max={10} value={eiaWeeks} onChange={(e) => setEiaWeeks(e.target.value)} />
                </label>
                <label className="field">
                  <span>Close on date (12:00 ET)</span>
                  <input type="date" value={closeDate} onChange={(e) => setCloseDate(e.target.value)} />
                </label>
              </div>
            </details>
            <div className="btn-row">
              <button className="btn primary" onClick={submit} disabled={submitting || !preview}>
                {submitting ? 'Submitting…' : preview && !preview.ok ? 'Submit (will be rejected and logged)' : 'Submit simulated order'}
              </button>
              <span className="small muted mono" title="Idempotency key: a retried submission with this key cannot create a duplicate trade">
                key {key.slice(0, 8)}…
              </span>
            </div>
          </div>
        </Card>

        <div className="grid">
          <Card title="Order check" sub="Updates as you edit. The server re-checks margin at submission and again at fill.">
            {preview ? (
              <div className="grid" style={{ gap: 12 }}>
                {preview.ok ? (
                  <Alert tone="good">All checks pass. Margin is covered by verified buying power.</Alert>
                ) : (
                  <Alert tone="bad">
                    <strong>This order would be rejected:</strong>
                    <ul className="bullets" style={{ marginTop: 4 }}>
                      {preview.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </Alert>
                )}
                <dl className="kv">
                  <dt>Direction</dt>
                  <dd>{preview.summary.direction}</dd>
                  <dt>Order</dt>
                  <dd>{preview.summary.label}</dd>
                  <dt>Legs</dt>
                  <dd>
                    {preview.summary.legs.map((l) => (
                      <div key={l.contract}>
                        <strong>{l.side === 'buy' ? 'Buy' : 'Sell'}</strong> {l.contracts} × {l.label} ({l.barrels.toLocaleString('en-US')} bbl)
                      </div>
                    ))}
                  </dd>
                  <dt>Size</dt>
                  <dd>
                    {preview.summary.contractsPerLeg} contract(s) per leg = {preview.summary.barrels.toLocaleString('en-US')} bbl per leg
                  </dd>
                  <dt>Entry method</dt>
                  <dd>{preview.summary.entryMethod}</dd>
                  <dt>Value formula</dt>
                  <dd className="mono small">{preview.summary.valueFormula}</dd>
                  <dt>Current value</dt>
                  <dd>
                    {fmtNum(preview.summary.currentValue, 3)} $/bbl {preview.summary.currentValue !== null && !preview.summary.currentValueValid ? <Badge tone="warn">provisional</Badge> : null}
                  </dd>
                  <dt>Exit / stop</dt>
                  <dd>
                    {preview.summary.exitRuleText || '—'}
                    {preview.summary.exitRules.length ? (
                      <ul className="bullets small">
                        {preview.summary.exitRules.map((r) => (
                          <li key={r}>{r}</li>
                        ))}
                      </ul>
                    ) : null}
                  </dd>
                </dl>
                <MarginPanel p={preview} />
                <p className="small muted">{preview.summary.notionalNote}</p>
                {preview.warnings.map((w) => (
                  <Alert key={w} tone="info">
                    {w}
                  </Alert>
                ))}
              </div>
            ) : (
              <p className="empty">Fill in the ticket to see validation.</p>
            )}
          </Card>
          {lastResult ? (
            <Card title={`Last submission: order #${lastResult.order.id}`}>
              <p>
                Status <Badge tone={lastResult.order.status === 'rejected' ? 'bad' : 'info'}>{lastResult.order.status}</Badge>
                {lastResult.duplicate ? ' (duplicate submission — original returned)' : ''}
              </p>
              {lastResult.order.reasons.length ? (
                <ul className="bullets small" style={{ marginTop: 6 }}>
                  {lastResult.order.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </Card>
          ) : null}
          <Card title="Working orders">
            {workingOrders.length ? (
              <div className="table-wrap">
                <table>
                  <tbody>
                    {workingOrders.map((o) => (
                      <tr key={o.id}>
                        <td>#{o.id}</td>
                        <td className="small">
                          {o.request.direction} {o.request.legs.map((l) => l.contract).join(' / ')} × {o.request.quantity.contracts ?? (o.request.quantity.barrels ?? 0) / 1000} · {o.request.entryMethod}
                          {o.request.entryMethod === 'limit' ? ` @ ${o.request.limitValue}` : ''} · {o.request.timeInForce}
                          <div className="muted">submitted {fmtEt(o.submittedAt)}</div>
                        </td>
                        <td>
                          <button className="btn small" onClick={() => cancel(o.id)}>
                            Cancel
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">No working orders.</p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
