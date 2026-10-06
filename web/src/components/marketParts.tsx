import type { FxRowDto, InventorySummaryDto, SpreadDto } from '../../../src/shared/types.ts';
import { fmtDate, fmtEt, fmtNum } from '../format.ts';
import { Badge } from './ui.tsx';
import { Icon } from '../icons.tsx';

export function SpreadTable({ spreads, compact = false }: { spreads: SpreadDto[]; compact?: boolean }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Spread</th>
            <th className="num">Value ($/bbl)</th>
            <th className="num">48h change</th>
            {compact ? null : <th>Inputs as of</th>}
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {spreads.map((s) => (
            <tr key={s.key}>
              <td>
                <strong>{s.label}</strong>
                {compact ? null : <div className="small muted">{s.formula}</div>}
              </td>
              <td className="num">
                {fmtNum(s.value, s.key.includes('m1m2') ? 2 : 3)}
                {compact && s.asOf ? <div className="small muted">{fmtEt(s.asOf, false)}</div> : null}
              </td>
              <td className="num">
                {s.change48h ? (
                  <>
                    {fmtNum(s.change48h.abs, 3, true)}
                    <div className="small muted">from {fmtNum(s.change48h.from, 3)}</div>
                  </>
                ) : (
                  <span className="small muted" title={s.change48hNote ?? ''}>
                    n/a
                  </span>
                )}
              </td>
              {compact ? null : <td className="small">{s.asOf ? fmtEt(s.asOf) : '—'}</td>}
              <td>
                {s.value === null ? (
                  <Badge tone="bad" icon={Icon.x} title={s.missing.join('; ')}>
                    Unavailable
                  </Badge>
                ) : s.valid ? (
                  <Badge tone="info" icon={Icon.check}>
                    Valid
                  </Badge>
                ) : (
                  <Badge tone="warn" icon={Icon.alert} title={s.missing.join('; ')}>
                    Provisional
                  </Badge>
                )}
                {s.missing.length && !compact ? <div className="small muted">{s.missing.join('; ')}</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FxTable({ rows }: { rows: FxRowDto[] }) {
  if (!rows.some((r) => r.value !== null)) return <p className="empty">No FX reference rates recorded yet (fetched with the briefing, or enter them in Settings → Notes & data).</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pair</th>
            <th className="num">Value</th>
            <th className="num">1 fixing</th>
            <th className="num">2 fixings (~48h)</th>
            <th>As of</th>
            <th>Context</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const d = r.pair.includes('JPY') || r.pair.includes('INR') ? 2 : 4;
            return (
              <tr key={r.pair}>
                <td>
                  <strong>{r.label}</strong>
                </td>
                <td className="num">{fmtNum(r.value, d)}</td>
                <td className="num">{r.change1d ? `${fmtNum(r.change1d.pct, 2, true)}%` : '—'}</td>
                <td className="num">{r.change2d ? `${fmtNum(r.change2d.pct, 2, true)}%` : '—'}</td>
                <td className="small">
                  {r.asOfDate ? fmtDate(r.asOfDate) : '—'}
                  <div className="muted">{r.source ?? ''}</div>
                </td>
                <td className="small muted">{r.linkage}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted" style={{ marginTop: 6 }}>
        ECB euro reference rates are once-daily fixings (~16:00 CET), not live quotes. Changes compare consecutive fixings.
      </p>
    </div>
  );
}

const kb = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n >= 0 ? '+' : '−'}${Math.abs(Math.round(n)).toLocaleString('en-US')}`);

export function InventoryTable({ inv }: { inv: InventorySummaryDto }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Series</th>
            <th className="num">EIA actual Δ (kb)</th>
            <th className="num">Level (kb)</th>
            <th className="num">API Δ (not EIA)</th>
            <th className="num">Estimate Δ (not data)</th>
          </tr>
        </thead>
        <tbody>
          {inv.rows.map((r) => (
            <tr key={r.series}>
              <td>
                <strong>{r.label}</strong>
                {r.actual ? <div className="small muted">week ending {r.actual.weekEnding}</div> : null}
              </td>
              <td className="num">{r.actual ? kb(r.actual.changeKb) : '—'}</td>
              <td className="num">{r.actual?.levelKb !== null && r.actual?.levelKb !== undefined ? Math.round(r.actual.levelKb).toLocaleString('en-US') : '—'}</td>
              <td className="num">
                {r.api ? (
                  <>
                    {kb(r.api.changeKb)}
                    <div className="small muted">wk {r.api.weekEnding}</div>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className="num">
                {r.estimate ? (
                  <>
                    {kb(r.estimate.changeKb)}
                    <div className="small muted">wk {r.estimate.weekEnding}</div>
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DistillateStreak({ inv, required = 3 }: { inv: InventorySummaryDto; required?: number }) {
  const s = inv.distillateStreak;
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="streak" aria-label={`${s.streak} of ${required} consecutive weekly distillate builds`}>
        {Array.from({ length: required }, (_, i) => (
          <span key={i} className={i < s.streak ? 'on' : ''} />
        ))}
      </div>
      <div className="small">
        <strong>
          {Math.min(s.streak, 99)}/{required}
        </strong>{' '}
        consecutive weekly builds (EIA actuals). <span className="muted">{s.note}</span>
      </div>
      {inv.nextRelease ? (
        <div className="small muted">
          Next WPSR: {fmtDate(inv.nextRelease.releaseDate)} {inv.nextRelease.timeEt} ET (week ending {inv.nextRelease.weekEnding}
          {inv.nextRelease.source === 'default-rule' ? '; default Wednesday rule' : '; user override'})
        </div>
      ) : null}
    </div>
  );
}
