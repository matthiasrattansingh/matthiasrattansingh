import { useEffect, useMemo, useRef, useState } from 'react';
import type { QuoteDto, SnapshotDto } from '../../../src/shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Alert, Badge, Card, ContractTable, useApp, useFetch } from '../components/ui.tsx';
import { SpreadTable } from '../components/marketParts.tsx';
import { etNowParts, fmtEt, fmtLocal, fmtNum, fmtPrice, fmtUsd, priceDecimals } from '../format.ts';
import { Icon } from '../icons.tsx';

export interface ContractList {
  product: string;
  name: string;
  unit: string;
  kind: string;
  contractSize: string;
  tickSize: number;
  expiryRule: string;
  contracts: { code: string; label: string; lastTradingDay: string; position: string; tradingView: string }[];
}

const SOURCES = [
  { label: 'TradingView chart/widget (transcribed)', delay: 10 },
  { label: 'CME Group website (transcribed)', delay: 10 },
  { label: 'Broker platform (transcribed)', delay: 0 },
  { label: 'Other (describe)', delay: 0 },
];

const ZONES = [
  { id: 'America/New_York', label: 'ET (New York)' },
  { id: 'America/Chicago', label: 'CT (Chicago)' },
  { id: 'UTC', label: 'UTC' },
  { id: 'Europe/London', label: 'London' },
];

interface Row {
  contract: string;
  price: string;
  time: string;
  zone: string;
  source: string;
  otherSource: string;
  delay: string;
}

interface EntryResult {
  inserted: number;
  duplicates: number;
  issues: { contract: string; code: string; message: string }[];
  dryRun: boolean;
  impact: { positions: { id: number; label: string; value: number | null; unrealized: number | null; valid: boolean }[]; equity: number; equityValid: boolean; drawdownPct: number; actions: { type: string; summary: string }[] } | null;
}

function TvSingleQuote({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    const inner = document.createElement('div');
    inner.className = 'tradingview-widget-container__widget';
    el.appendChild(inner);
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-single-quote.js';
    s.async = true;
    const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    s.innerHTML = JSON.stringify({ symbol, width: '100%', isTransparent: true, colorTheme: dark ? 'dark' : 'light', locale: 'en' });
    el.appendChild(s);
  }, [symbol]);
  return (
    <div className="tv-box">
      <div className="small muted">
        <span className="mono">{symbol}</span> · TradingView widget (visual reference)
      </div>
      <div className="tradingview-widget-container" ref={ref} />
      <div className="tradingview-widget-copyright">
        <a href={`https://www.tradingview.com/symbols/${symbol.replace(':', '-')}/`} rel="noopener nofollow" target="_blank">
          {symbol} quote
        </a>{' '}
        by TradingView ·{' '}
        <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`} rel="noopener nofollow" target="_blank">
          open chart
        </a>
      </div>
    </div>
  );
}

export function QuoteEntry({ contracts, defaults, onSaved }: { contracts: ContractList[]; defaults: string[]; onSaved: () => void }) {
  const { state, notify } = useApp();
  const delayDefault = String(state?.settings.manualDefaultDelayMinutes ?? 10);
  const blank = (c: string): Row => {
    const et = etNowParts();
    return { contract: c, price: '', time: `${et.date}T${et.time}`, zone: 'America/New_York', source: SOURCES[0].label, otherSource: '', delay: delayDefault };
  };
  const [rows, setRows] = useState<Row[]>(() => defaults.map(blank));
  const [result, setResult] = useState<EntryResult | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const allCodes = useMemo(() => contracts.flatMap((p) => p.contracts.map((c) => ({ ...c, unit: p.unit, product: p.product }))), [contracts]);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const payload = (dryRun: boolean) => ({
    dryRun,
    confirmLargeMoves: confirm,
    quotes: rows
      .filter((r) => r.price.trim())
      .map((r) => ({
        contract: r.contract,
        price: Number(r.price),
        exchangeTime: r.time,
        exchangeTimeZone: r.zone,
        source: r.source.startsWith('Other') ? r.otherSource || 'Other' : r.source,
        delayMinutes: r.delay === '' ? null : Number(r.delay),
      })),
  });
  const submit = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api<EntryResult>('/api/quotes', { body: payload(dryRun) });
      setResult(r);
      if (!dryRun) {
        notify(`Saved ${r.inserted} quote(s)${r.duplicates ? ` (${r.duplicates} duplicate ignored)` : ''}.${r.impact?.actions.length ? ` ${r.impact.actions.map((a) => a.summary).join('; ')}` : ''}`, r.impact?.actions.some((a) => a.type.startsWith('liquidation')) ? 'bad' : 'good');
        setRows((rs) => rs.map((x) => ({ ...x, price: '' })));
        setConfirm(false);
        onSaved();
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setResult(e.data as EntryResult);
      else notify((e as Error).message, 'bad');
    } finally {
      setBusy(false);
    }
  };
  const needsConfirm = result?.issues.some((i) => i.code === 'confirm_large_move');
  const liquidation = result?.dryRun && result.impact?.actions.some((a) => a.type.startsWith('liquidation'));

  return (
    <div className="form">
      {rows.map((r, i) => {
        const meta = allCodes.find((c) => c.code === r.contract);
        const unit = meta?.unit ?? '';
        const n = Number(r.price);
        return (
          <div key={i} className="row" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12 }}>
            <label className="field" style={{ flex: '1 1 200px' }}>
              <span>Contract (exact month)</span>
              <select value={r.contract} onChange={(e) => set(i, { contract: e.target.value })}>
                {contracts.map((p) => (
                  <optgroup key={p.product} label={`${p.name} (${p.unit})`}>
                    {p.contracts.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} · {c.position} · LTD {c.lastTradingDay}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: '0 1 140px' }}>
              <span>Price ({unit})</span>
              <input type="number" step={unit === '$/gal' ? '0.0001' : '0.01'} value={r.price} onChange={(e) => set(i, { price: e.target.value })} placeholder={unit === '$/gal' ? 'e.g. 2.3456' : 'e.g. 65.43'} />
              <small>{unit === '$/gal' && Number.isFinite(n) && n > 0 ? `= ${fmtNum(n * 42, 2)} $/bbl (× 42)` : ' '}</small>
            </label>
            <label className="field" style={{ flex: '1 1 200px' }}>
              <span>Displayed timestamp</span>
              <input type="datetime-local" value={r.time} onChange={(e) => set(i, { time: e.target.value })} />
              <small>Use the time shown by the source, not the current time.</small>
            </label>
            <label className="field" style={{ flex: '0 1 140px' }}>
              <span>Timestamp zone</span>
              <select value={r.zone} onChange={(e) => set(i, { zone: e.target.value })}>
                {ZONES.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: '1 1 220px' }}>
              <span>Source</span>
              <select
                value={r.source}
                onChange={(e) => {
                  const s = SOURCES.find((x) => x.label === e.target.value)!;
                  set(i, { source: s.label, delay: String(s.delay) });
                }}
              >
                {SOURCES.map((s) => (
                  <option key={s.label}>{s.label}</option>
                ))}
              </select>
              {r.source.startsWith('Other') ? <input type="text" value={r.otherSource} onChange={(e) => set(i, { otherSource: e.target.value })} placeholder="Describe the source" /> : null}
            </label>
            <label className="field" style={{ flex: '0 1 110px' }}>
              <span>Declared delay (min)</span>
              <input type="number" min={0} value={r.delay} onChange={(e) => set(i, { delay: e.target.value })} />
            </label>
            <button className="btn small" onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} aria-label="Remove row" disabled={rows.length === 1}>
              {Icon.x}
            </button>
          </div>
        );
      })}
      <div className="btn-row">
        <button className="btn small" onClick={() => setRows((rs) => [...rs, blank(rs[rs.length - 1]?.contract ?? defaults[0])])}>
          + Add contract
        </button>
        <span style={{ flex: 1 }} />
        {needsConfirm ? (
          <label className="check">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Confirm large move(s)
          </label>
        ) : null}
        <button className="btn" onClick={() => submit(true)} disabled={busy}>
          {Icon.eye} Preview impact
        </button>
        <button className="btn primary" onClick={() => submit(false)} disabled={busy}>
          Save quotes
        </button>
      </div>
      {result?.issues.length ? (
        <div className="alerts">
          {result.issues.map((x, k) => (
            <Alert key={k} tone={x.code === 'confirm_large_move' ? 'warn' : 'bad'}>
              {x.message}
            </Alert>
          ))}
        </div>
      ) : null}
      {result?.dryRun && result.impact ? (
        <Alert tone={liquidation ? 'bad' : 'info'}>
          <strong>Preview (nothing saved):</strong>{' '}
          {result.impact.positions.map((p) => `#${p.id} value ${fmtNum(p.value, 3)} → unrealized ${fmtUsd(p.unrealized, { sign: true })}${p.valid ? '' : ' (provisional)'}`).join(' · ')}. Equity {fmtUsd(result.impact.equity)}
          {result.impact.equityValid ? '' : ' (provisional)'}, drawdown {fmtNum(result.impact.drawdownPct, 2)}%.
          {result.impact.actions.length ? ` Would trigger: ${result.impact.actions.map((a) => a.summary).join('; ')}.` : ' No exits or liquidations would trigger.'}
        </Alert>
      ) : null}
    </div>
  );
}

export function MarketPage() {
  const { state, zone, refresh } = useApp();
  const [n, setN] = useState(0);
  const snap = useFetch<SnapshotDto>('/api/snapshot', [n, state?.lastMark?.ts]);
  const contracts = useFetch<ContractList[]>('/api/contracts');
  const recent = useFetch<QuoteDto[]>('/api/quotes?limit=60', [n]);
  if (!state) return null;
  const p = state.provider;
  const lastFetch = p.lastFetch?.detail as { at: string; ok: boolean; errors: string[]; fetched: number; trigger: string } | undefined;
  const legCodes = [...new Set(state.positions.flatMap((x) => x.legs.map((l) => l.contract)))];
  const defaults = legCodes.length ? legCodes : ['HOX2026', 'BZZ2026'];
  const tvSymbols = snap.data ? [...new Set([...legCodes, ...snap.data.contracts.filter((c) => /^(BZ|HO)/.test(c.contract)).map((c) => c.contract)])] : legCodes;
  const tvMap = new Map((contracts.data ?? []).flatMap((pp) => pp.contracts.map((c) => [c.code, c.tradingView] as const)));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Market</h1>
          <p>Every quote is tied to an exact contract month, with its source, exchange/displayed time, local observation time and freshness.</p>
        </div>
      </div>

      <Card
        title="Quote source"
        sub={p.label}
        actions={
          <Badge tone={p.configured ? 'good' : 'bad'} icon={p.configured ? Icon.check : Icon.x}>
            {p.configured ? 'Configured' : 'Not configured'}
          </Badge>
        }
      >
        <dl className="kv">
          <dt>Mode</dt>
          <dd>{p.kind === 'manual' ? 'Manual entry — quotes change only when you enter them.' : 'API — fetched hourly during NYMEX hours, on demand, and while orders/exits are pending.'}</dd>
          {p.reason ? (
            <>
              <dt>Note</dt>
              <dd>{p.reason}</dd>
            </>
          ) : null}
          <dt>Last fetch</dt>
          <dd>{lastFetch ? `${fmtLocal(lastFetch.at, zone, true)} — ${lastFetch.ok ? `ok (${lastFetch.fetched} quotes)` : `failed: ${lastFetch.errors.join('; ')}`} [${lastFetch.trigger}]` : p.kind === 'manual' ? 'n/a (manual source)' : 'never'}</dd>
          <dt>Last successful fetch</dt>
          <dd>{state.lastSuccessfulRefresh ? fmtLocal(state.lastSuccessfulRefresh, zone, true) : '—'}</dd>
          <dt>TradingView</dt>
          <dd>
            No permitted programmatic TradingView quote feed is used. Its official widgets are embedded below for visual reference only; values you read there can be entered with source “TradingView (transcribed)” and its ~10-minute delay.
          </dd>
        </dl>
      </Card>

      <Card title="Spreads" sub="Computed only from the exact contracts named; provisional when any input is stale or missing.">
        {snap.data ? <SpreadTable spreads={snap.data.spreads} /> : <p className="empty">Loading…</p>}
      </Card>

      <Card title="Contract quotes" sub="Position legs first, then the snapshot set (M1/M2 resolved from CME expiry rules).">
        {snap.data ? <ContractTable marks={snap.data.contracts} /> : <p className="empty">Loading…</p>}
      </Card>

      <Card title="Enter quotes manually" sub="Transcribe from TradingView, the CME site or your broker. Preview shows the P/L and risk impact before anything is saved.">
        {contracts.data ? (
          <QuoteEntry
            contracts={contracts.data}
            defaults={defaults}
            onSaved={() => {
              setN((x) => x + 1);
              void refresh();
            }}
          />
        ) : (
          <p className="empty">Loading contracts…</p>
        )}
      </Card>

      {state.settings.tradingViewWidgets ? (
        <Card title="TradingView widgets (visual reference)" sub="Embedded with TradingView's official widget. The app cannot read these values (cross-origin), so they never feed P/L. Futures data in widgets may be delayed (~10 min) or unavailable for some contracts.">
          <div className="tv-widgets">
            {tvSymbols.map((c) => (
              <TvSingleQuote key={c} symbol={tvMap.get(c) ?? `NYMEX:${c}`} />
            ))}
          </div>
        </Card>
      ) : null}

      <Card title="Recent quotes" sub="Most recently recorded quotes across all sources.">
        {recent.data?.length ? (
          <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th className="num">Price</th>
                  <th>Exchange/displayed (ET)</th>
                  <th>Observed ({zone})</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.map((q) => (
                  <tr key={q.id}>
                    <td className="mono">{q.contract}</td>
                    <td className="num">
                      {fmtPrice(q.contract, q.price)} <span className="muted small">{q.unit}</span>
                    </td>
                    <td className="small">{fmtEt(q.exchangeTs)}</td>
                    <td className="small">{fmtLocal(q.observedAt, zone, true)}</td>
                    <td className="small">
                      {q.source} <span className="muted">({q.sourceKind}{q.delayMinutes !== null ? `, delay ${q.delayMinutes}m` : ''})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No quotes recorded yet.</p>
        )}
        <p className="small muted" style={{ marginTop: 6 }}>
          Prices: HO/RB {priceDecimals('$/gal')} decimals in $/gal (× 42 = $/bbl); BZ/CL 2 decimals in $/bbl.
        </p>
      </Card>
    </>
  );
}
