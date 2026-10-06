import { useEffect, useState, type ReactNode } from 'react';
import type { AppSettings, MarginFigureDto, NoteDto } from '../../../src/shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Alert, Badge, Card, useApp, useFetch } from '../components/ui.tsx';
import { etNowParts, fmtDate, fmtLocal, fmtUsd } from '../format.ts';
import { Icon } from '../icons.tsx';
import type { ContractList } from './Market.tsx';

function Section({ title, sub, children, onSave, dirty }: { title: string; sub?: string; children: ReactNode; onSave?: () => void; dirty?: boolean }) {
  return (
    <Card
      title={title}
      sub={sub}
      actions={
        onSave ? (
          <button className="btn primary small" onClick={onSave} disabled={!dirty}>
            Save
          </button>
        ) : undefined
      }
    >
      <div className="form">{children}</div>
    </Card>
  );
}

function Num({ label, value, onChange, hint, step = 1, allowBlank = false }: { label: string; value: number | null; onChange: (v: number | null) => void; hint?: string; step?: number; allowBlank?: boolean }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" step={step} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? (allowBlank ? null : 0) : Number(e.target.value))} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function MarginEditor() {
  const { notify, refresh, state } = useApp();
  const margins = useFetch<MarginFigureDto[]>('/api/margins');
  const contracts = useFetch<ContractList[]>('/api/contracts');
  const legs = state?.positions.flatMap((p) => p.legs.map((l) => l.contract)) ?? [];
  const [key, setKey] = useState(legs[0] ?? 'HOX2026');
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState('');
  const [asOf, setAsOf] = useState(etNowParts().date);
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const spreadKeys = (state?.positions ?? []).filter((p) => p.legs.length > 1).map((p) => `SPREAD:${p.legs.map((l) => l.contract).sort().join('+')}`);
  const save = async () => {
    setErrors([]);
    try {
      await api('/api/margins', { method: 'PUT', body: { key, perUnitUsd: Number(amount), source, asOfDate: asOf, note } });
      notify(`Margin saved for ${key}.`, 'good');
      setAmount('');
      margins.reload();
      await refresh();
    } catch (e) {
      if (e instanceof ApiError) setErrors((e.data as { errors?: string[] })?.errors ?? [e.message]);
    }
  };
  const remove = async (k: string) => {
    if (!window.confirm(`Remove the margin figure for ${k}?`)) return;
    await api(`/api/margins/${encodeURIComponent(k)}`, { method: 'DELETE' });
    margins.reload();
    await refresh();
  };
  return (
    <Card title="Initial margin figures" sub={`Required for buying power. Enter the exchange or broker initial margin per contract (or per spread unit) with its source and date. Figures older than ${state?.settings.marginMaxAgeDays} days count as unverified. Never inferred from notional.`}>
      <Alert tone="info">
        Look up current NYMEX initial margins on the CME Group margins page or your broker’s schedule. The preloaded position stays “margin unknown” until HOX2026 and BZZ2026 (or the SPREAD key) have figures.
      </Alert>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th className="num">Per contract / unit</th>
              <th>Source</th>
              <th>As of</th>
              <th>Entered</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(margins.data ?? []).map((m) => (
              <tr key={m.key}>
                <td className="mono">{m.key}</td>
                <td className="num">{fmtUsd(m.perUnitUsd)}</td>
                <td className="small">
                  {m.source}
                  {m.note ? <div className="muted">{m.note}</div> : null}
                </td>
                <td className="small">{fmtDate(m.asOfDate)}</td>
                <td className="small">{fmtLocal(m.enteredAt, 'UTC')}</td>
                <td>
                  <button className="btn small danger" onClick={() => remove(m.key)}>
                    Remove
                  </button>
                </td>
              </tr>
            ))}
            {!margins.data?.length ? (
              <tr>
                <td colSpan={6} className="muted">
                  No margin figures configured — margin is unknown and new orders are blocked.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Contract or spread key</span>
          <select value={key} onChange={(e) => setKey(e.target.value)}>
            {spreadKeys.length ? (
              <optgroup label="Spread (per 1 contract on each leg)">
                {spreadKeys.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </optgroup>
            ) : null}
            {(contracts.data ?? []).map((p) => (
              <optgroup key={p.product} label={p.name}>
                {p.contracts.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} · {c.position}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field" style={{ flex: '0 1 150px' }}>
          <span>Initial margin (USD)</span>
          <input type="number" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="field">
          <span>Source</span>
          <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. CME Group margins page" />
        </label>
        <label className="field" style={{ flex: '0 1 160px' }}>
          <span>As of</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label className="field">
          <span>Note</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tier, outright vs spread, etc." />
        </label>
        <button className="btn primary" onClick={save}>
          Save margin
        </button>
      </div>
      {errors.length ? (
        <Alert tone="bad">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      ) : null}
    </Card>
  );
}

function NotesEditor() {
  const { notify } = useApp();
  const notes = useFetch<NoteDto[]>('/api/notes');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const add = async () => {
    try {
      await api('/api/notes', { body: { kind: 'note', title, body } });
      setTitle('');
      setBody('');
      notes.reload();
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };
  const remove = async (id: number) => {
    await api(`/api/notes/${id}`, { method: 'DELETE' });
    notes.reload();
  };
  return (
    <Card title="Your notes for the briefing" sub="News items or things to check. Shown verbatim in the next briefings (last 7 days), labeled as user-entered.">
      <ul className="bullets">
        {(notes.data ?? [])
          .filter((n) => n.kind === 'note')
          .map((n) => (
            <li key={n.id}>
              <strong>{n.title}</strong> {n.body} <button className="btn small" onClick={() => remove(n.id)}>Remove</button>
            </li>
          ))}
      </ul>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="field">
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="field">
          <span>Detail</span>
          <input type="text" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <button className="btn" onClick={add} disabled={!title.trim()}>
          Add note
        </button>
      </div>
    </Card>
  );
}

function FxEntry() {
  const { state, notify } = useApp();
  const [pair, setPair] = useState(state?.settings.fxPairs[0] ?? 'EURUSD');
  const [date, setDate] = useState(etNowParts().date);
  const [rate, setRate] = useState('');
  const [source, setSource] = useState('');
  const save = async () => {
    try {
      await api('/api/fx', { body: { pair, asOfDate: date, rate: Number(rate), source } });
      notify(`FX ${pair} saved.`, 'good');
      setRate('');
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };
  const fetchNow = async () => {
    try {
      const r = await api<{ stored: number; errors: string[] }>('/api/fx/refresh', { method: 'POST' });
      notify(r.errors.length ? r.errors.join('; ') : `Stored ${r.stored} FX reference rates.`, r.errors.length ? 'bad' : 'good');
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };
  return (
    <Card title="FX reference rates" sub="Fetched from Frankfurter (ECB reference rates, no key) with each briefing. Manual entry is a fallback; values are labeled with their source." actions={<button className="btn small" onClick={fetchNow}>{Icon.refresh} Fetch now</button>}>
      <div className="row">
        <label className="field">
          <span>Pair (market convention)</span>
          <select value={pair} onChange={(e) => setPair(e.target.value)}>
            {state?.settings.fxPairs.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>As-of date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field">
          <span>Rate</span>
          <input type="number" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label className="field">
          <span>Source</span>
          <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="e.g. ECB website" />
        </label>
        <button className="btn" onClick={save} disabled={!rate || !source}>
          Save rate
        </button>
      </div>
    </Card>
  );
}

export function SettingsPage() {
  const { state, notify, refresh } = useApp();
  const [draft, setDraft] = useState<AppSettings | null>(state?.settings ?? null);
  const [errors, setErrors] = useState<string[]>([]);
  const [confirmText, setConfirmText] = useState('');
  const [ov, setOv] = useState({ date: '', releaseDate: '', timeEt: '10:30' });
  useEffect(() => {
    if (state && !draft) setDraft(state.settings);
  }, [state, draft]);
  if (!state || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);
  const set = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => setDraft({ ...draft, [k]: v });
  const setCh = (patch: Partial<AppSettings['customHttp']>) => setDraft({ ...draft, customHttp: { ...draft.customHttp, ...patch } });
  const save = async () => {
    setErrors([]);
    try {
      const r = await api<{ settings: AppSettings; changes: string[] }>('/api/settings', { method: 'PUT', body: draft });
      notify(r.changes.length ? `Saved: ${r.changes.length} change(s) logged in History.` : 'No changes.', 'good');
      setDraft(r.settings);
      await refresh();
    } catch (e) {
      if (e instanceof ApiError) setErrors((e.data as { errors?: string[] })?.errors ?? [e.message]);
    }
  };
  const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? ['America/New_York', 'America/Chicago', 'Europe/London', 'UTC'];
  const sec = state.secrets;
  const newAccount = async () => {
    try {
      await api('/api/account/new', { body: { confirm: confirmText } });
      notify('New paper account started.', 'good');
      setConfirmText('');
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Every change is logged in History. API keys live only in server environment variables and are never shown here.</p>
        </div>
        <button className="btn primary" onClick={save} disabled={!dirty}>
          Save all changes
        </button>
      </div>
      {errors.length ? (
        <Alert tone="bad">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </Alert>
      ) : null}

      <Section title="Market data" sub="Quote source used for marks. TradingView has no permitted programmatic feed here; its widgets are visual only." onSave={save} dirty={dirty}>
        <div className="row">
          <label className="field">
            <span>Provider</span>
            <select value={draft.provider} onChange={(e) => set('provider', e.target.value as AppSettings['provider'])}>
              <option value="manual">Manual entry (e.g. transcribed from TradingView)</option>
              <option value="databento">Databento — CME Globex GLBX.MDP3</option>
              <option value="custom-http">Custom HTTP/JSON API</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.tradingViewWidgets} onChange={(e) => set('tradingViewWidgets', e.target.checked)} /> Show TradingView widgets (visual reference)
          </label>
        </div>
        <div className="btn-row small">
          <Badge tone={sec.databento ? 'good' : ''} icon={sec.databento ? Icon.check : Icon.minus}>
            DATABENTO_API_KEY {sec.databento ? 'set' : 'not set'}
          </Badge>
          <Badge tone={sec.customHttp ? 'good' : ''} icon={sec.customHttp ? Icon.check : Icon.minus}>
            CUSTOM_QUOTE_API_KEY {sec.customHttp ? 'set' : 'not set'}
          </Badge>
          <Badge tone={sec.eia ? 'good' : ''} icon={sec.eia ? Icon.check : Icon.minus}>
            EIA_API_KEY {sec.eia ? 'set' : 'not set'}
          </Badge>
          <Badge tone={sec.basicAuth ? 'good' : 'warn'} icon={sec.basicAuth ? Icon.check : Icon.alert}>
            APP_BASIC_AUTH {sec.basicAuth ? 'on' : 'off'}
          </Badge>
        </div>
        {draft.provider === 'databento' ? (
          <div className="row">
            <label className="field">
              <span>Dataset</span>
              <input type="text" value={draft.databentoDataset} onChange={(e) => set('databentoDataset', e.target.value)} />
            </label>
            <Num label="Declared delay (min)" value={draft.databentoDelayMinutes} onChange={(v) => set('databentoDelayMinutes', v ?? 0)} hint="Historical-API availability lag; freshness uses exchange time." />
          </div>
        ) : null}
        {draft.provider === 'custom-http' ? (
          <>
            <div className="row">
              <label className="field" style={{ flex: '2 1 360px' }}>
                <span>URL template</span>
                <input type="text" value={draft.customHttp.urlTemplate} onChange={(e) => setCh({ urlTemplate: e.target.value })} placeholder="https://api.example.com/quote?symbol={symbol}" />
                <small>Must contain {'{symbol}'}; may contain {'{apiKey}'} (filled server-side from CUSTOM_QUOTE_API_KEY).</small>
              </label>
              <label className="field">
                <span>Symbol template</span>
                <input type="text" value={draft.customHttp.symbolTemplate} onChange={(e) => setCh({ symbolTemplate: e.target.value })} />
                <small>Tokens: {'{root} {month} {yyyy} {yy} {y}'} → e.g. HOX26</small>
              </label>
            </div>
            <div className="row">
              <label className="field">
                <span>Price JSON path</span>
                <input type="text" value={draft.customHttp.pricePath} onChange={(e) => setCh({ pricePath: e.target.value })} />
              </label>
              <label className="field">
                <span>Timestamp JSON path</span>
                <input type="text" value={draft.customHttp.timestampPath} onChange={(e) => setCh({ timestampPath: e.target.value })} />
              </label>
              <label className="field">
                <span>Timestamp format</span>
                <select value={draft.customHttp.timestampFormat} onChange={(e) => setCh({ timestampFormat: e.target.value as AppSettings['customHttp']['timestampFormat'] })}>
                  <option value="iso">ISO-8601 with offset</option>
                  <option value="epoch_ms">Epoch ms</option>
                  <option value="epoch_s">Epoch s</option>
                </select>
              </label>
              <label className="field">
                <span>Symbol echo path</span>
                <input type="text" value={draft.customHttp.symbolPath} onChange={(e) => setCh({ symbolPath: e.target.value })} />
                <small>Response must echo the exact requested symbol.</small>
              </label>
            </div>
            <div className="row">
              <Num label="Declared delay (min)" value={draft.customHttp.delayMinutes} onChange={(v) => setCh({ delayMinutes: v ?? 0 })} />
              <label className="field">
                <span>Auth header (optional)</span>
                <input type="text" value={draft.customHttp.authHeader} onChange={(e) => setCh({ authHeader: e.target.value })} placeholder="e.g. X-API-Key" />
              </label>
              <label className="field">
                <span>Source label</span>
                <input type="text" value={draft.customHttp.sourceLabel} onChange={(e) => setCh({ sourceLabel: e.target.value })} />
              </label>
            </div>
          </>
        ) : null}
        <div className="row">
          <Num label="Manual-entry default delay (min)" value={draft.manualDefaultDelayMinutes} onChange={(v) => set('manualDefaultDelayMinutes', v ?? 0)} hint="TradingView NYMEX data is typically ~10 min delayed." />
          <Num label="Stale tolerance (min beyond declared delay)" value={draft.staleToleranceMinutes} onChange={(v) => set('staleToleranceMinutes', v ?? 1)} hint="While NYMEX is open, older quotes are stale and P/L becomes provisional." />
        </div>
      </Section>

      <Section title="Display & schedule" sub="Times display in your zone; exchange, EIA and briefing times are always labeled ET." onSave={save} dirty={dirty}>
        <div className="row">
          <label className="field">
            <span>Display time zone</span>
            <select value={draft.displayTimeZone} onChange={(e) => set('displayTimeZone', e.target.value)}>
              <option value="auto">Auto (browser: {Intl.DateTimeFormat().resolvedOptions().timeZone})</option>
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.hourlyEnabled} onChange={(e) => set('hourlyEnabled', e.target.checked)} /> Hourly marks during NYMEX hours
          </label>
          <Num label="Hourly minute offset" value={draft.hourlyMinuteOffset} onChange={(v) => set('hourlyMinuteOffset', v ?? 0)} hint="0 = top of each ET hour" />
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={draft.briefingEnabled} onChange={(e) => set('briefingEnabled', e.target.checked)} /> Weekday briefing
          </label>
          <label className="field" style={{ flex: '0 1 140px' }}>
            <span>Briefing time (ET)</span>
            <input type="time" value={draft.briefingTimeEt} onChange={(e) => set('briefingTimeEt', e.target.value)} />
          </label>
          <Num label="Fill poll while orders/exits pending (min)" value={draft.fillPollMinutes} onChange={(v) => set('fillPollMinutes', v ?? 5)} hint="API providers only" />
          <label className="check">
            <input type="checkbox" checked={draft.eiaPollEnabled} onChange={(e) => set('eiaPollEnabled', e.target.checked)} /> Poll EIA API on release days
          </label>
        </div>
        <div>
          <div className="section-title">EIA release overrides (holiday weeks)</div>
          {draft.eiaOverrides.length ? (
            <ul className="bullets small">
              {draft.eiaOverrides.map((o, i) => (
                <li key={i}>
                  Week of {o.date}: {o.releaseDate ? `${o.releaseDate} ${o.timeEt} ET` : 'no release'}{' '}
                  <button className="btn small" onClick={() => set('eiaOverrides', draft.eiaOverrides.filter((_, k) => k !== i))}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">None — default Wednesday 10:30 ET. Check EIA’s published schedule for holiday weeks.</p>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <label className="field">
              <span>Any date in that week</span>
              <input type="date" value={ov.date} onChange={(e) => setOv({ ...ov, date: e.target.value })} />
            </label>
            <label className="field">
              <span>Actual release date (blank = none)</span>
              <input type="date" value={ov.releaseDate} onChange={(e) => setOv({ ...ov, releaseDate: e.target.value })} />
            </label>
            <label className="field">
              <span>Time (ET)</span>
              <input type="time" value={ov.timeEt} onChange={(e) => setOv({ ...ov, timeEt: e.target.value })} />
            </label>
            <button className="btn" disabled={!ov.date} onClick={() => set('eiaOverrides', [...draft.eiaOverrides, { date: ov.date, releaseDate: ov.releaseDate || null, timeEt: ov.timeEt }])}>
              Add override
            </button>
          </div>
        </div>
        <ul className="bullets small">
          {state.scheduler.limitations.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </Section>

      <Section title="Risk rules, fills & costs" onSave={save} dirty={dirty}>
        <div className="row">
          <Num label="Max drawdown from peak (%)" value={draft.maxDrawdownPct} onChange={(v) => set('maxDrawdownPct', v ?? 15)} step={0.5} hint="Reaching it liquidates all simulated positions." />
          <Num label="Margin figure max age (days)" value={draft.marginMaxAgeDays} onChange={(v) => set('marginMaxAgeDays', v ?? 30)} />
          <Num label="New trades per weekday" value={draft.dailyTradeLimit} onChange={(v) => set('dailyTradeLimit', v ?? 0)} hint="0 = unlimited" />
        </div>
        <div className="row">
          <label className="field">
            <span>Fill policy</span>
            <select value={draft.fillPolicy} onChange={(e) => set('fillPolicy', e.target.value as AppSettings['fillPolicy'])}>
              <option value="next_mark_after_submit">Next valid mark with exchange time after submission (recommended)</option>
              <option value="current_valid_mark">Current valid (delayed) mark</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.expiryGuardEnabled} onChange={(e) => set('expiryGuardEnabled', e.target.checked)} /> Expiry guard
          </label>
          <label className="field" style={{ flex: '0 1 140px' }}>
            <span>Guard time on last trading day (ET)</span>
            <input type="time" value={draft.expiryGuardTimeEt} onChange={(e) => set('expiryGuardTimeEt', e.target.value)} />
          </label>
        </div>
        <div className="row">
          <Num label="Commission per contract per side (USD)" value={draft.commissionPerContractPerSide} onChange={(v) => set('commissionPerContractPerSide', v)} step={0.01} allowBlank hint="Blank = not configured (P/L labeled gross before costs)" />
          <Num label="Slippage per leg (ticks)" value={draft.slippageTicksPerLeg} onChange={(v) => set('slippageTicksPerLeg', v)} allowBlank hint="Applied adversely to simulated fills and liquidations" />
        </div>
      </Section>

      <MarginEditor />
      <NotesEditor />
      <FxEntry />

      <Card title="Start a new paper account" sub="Archives the current account (history is kept) and starts fresh with $100,000. Allowed only when there are no open positions or working orders.">
        <div className="row">
          <label className="field">
            <span>Type START NEW ACCOUNT to confirm</span>
            <input type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
          </label>
          <button className="btn danger" onClick={newAccount} disabled={confirmText !== 'START NEW ACCOUNT'}>
            Start new account
          </button>
        </div>
      </Card>
    </>
  );
}
