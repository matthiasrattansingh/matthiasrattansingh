import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BulletDto, ContractMarkDto, QuoteStatus, StateDto } from '../../../src/shared/types.ts';
import { Icon } from '../icons.tsx';
import { fmtAge, fmtEt, fmtLocal, fmtPrice, fmtNum } from '../format.ts';

export interface AppCtx {
  state: StateDto | null;
  zone: string;
  uiRefreshedAt: number | null;
  refresh: () => Promise<void>;
  notify: (msg: string, tone?: 'good' | 'bad' | 'info' | 'warn') => void;
}

export const Ctx = createContext<AppCtx>(null as unknown as AppCtx);
export const useApp = () => useContext(Ctx);

const STATUS_META: Record<QuoteStatus, { tone: string; label: string; icon: ReactNode }> = {
  realtime: { tone: 'good', label: 'Real-time', icon: Icon.check },
  delayed: { tone: 'info', label: 'Delayed', icon: Icon.clock },
  'closed-last': { tone: 'info', label: 'Market closed · last', icon: Icon.clock },
  stale: { tone: 'warn', label: 'Stale', icon: Icon.alert },
  unavailable: { tone: 'bad', label: 'Unavailable', icon: Icon.x },
  'invalid-future': { tone: 'bad', label: 'Bad timestamp', icon: Icon.alert },
};

export function FreshBadge({ status, title }: { status: QuoteStatus; title?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={`badge ${m.tone}`} title={title}>
      {m.icon}
      {m.label}
    </span>
  );
}

export function Badge({ tone = '', icon, children, title }: { tone?: string; icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {icon}
      {children}
    </span>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'good'; children: ReactNode }) {
  const icon = tone === 'bad' || tone === 'warn' ? Icon.alert : tone === 'good' ? Icon.check : Icon.info;
  return (
    <div className={`alert ${tone}`} role={tone === 'bad' ? 'alert' : undefined}>
      {icon}
      <div>{children}</div>
    </div>
  );
}

export function Stat({ label, value, note, className = '' }: { label: string; value: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className="card tight stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${className}`}>{value}</div>
      {note ? <div className="stat-note">{note}</div> : null}
    </div>
  );
}

export function Card({ title, sub, actions, children, className = '' }: { title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {sub ? <p>{sub}</p> : null}
          </div>
          {actions ? <div className="btn-row">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Bullets({ items, empty = 'Nothing to show.' }: { items: BulletDto[]; empty?: string }) {
  if (!items.length) return <p className="empty">{empty}</p>;
  return (
    <ul className="bullets">
      {items.map((b, i) => (
        <li key={i}>
          {b.text}
          <span className="basis">· {b.basis}</span>
        </li>
      ))}
    </ul>
  );
}

/** Price with units plus exchange time (ET) and local observation time. */
export function QuoteTimes({ mark }: { mark: ContractMarkDto }) {
  const { zone } = useApp();
  if (!mark.quote) return <span className="muted">No quote</span>;
  return (
    <div className="small">
      <div>
        <span className="muted">Exchange/displayed:</span> {fmtEt(mark.quote.exchangeTs)}
      </div>
      <div>
        <span className="muted">Observed:</span> {fmtLocal(mark.quote.observedAt, zone)}
      </div>
    </div>
  );
}

export function ContractTable({ marks, showRole = true }: { marks: ContractMarkDto[]; showRole?: boolean }) {
  if (!marks.length) return <p className="empty">No contracts.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            {showRole ? <th>Role</th> : null}
            <th className="num">Price</th>
            <th className="num">$/bbl</th>
            <th>Source</th>
            <th>Times</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {marks.map((m) => (
            <tr key={m.contract}>
              <td>
                <strong className="mono">{m.contract}</strong>
                <div className="small muted">{m.label.replace(` (${m.contract})`, '')}</div>
                <div className="small muted">Last trade {m.lastTradingDay} ({m.businessDaysToExpiry} bd)</div>
              </td>
              {showRole ? <td className="small ink2">{m.role ?? '—'}</td> : null}
              <td className="num">
                {m.quote ? (
                  <>
                    <strong>{fmtPrice(m.contract, m.quote.price)}</strong> <span className="muted small">{m.unit}</span>
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td className="num">{m.quote ? fmtNum(m.quote.perBarrel, 2) : '—'}</td>
              <td className="small">
                {m.quote ? (
                  <>
                    {m.quote.source}
                    <div className="muted">
                      {m.quote.delayMinutes !== null ? `declared delay ${m.quote.delayMinutes} min` : 'delay not declared'}
                      {m.quote.basis ? ` · ${m.quote.basis}` : ''}
                    </div>
                  </>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <QuoteTimes mark={m} />
              </td>
              <td>
                <FreshBadge status={m.freshness.status} title={m.freshness.reason} />
                <div className="small muted" style={{ marginTop: 4, maxWidth: 260 }}>
                  {m.quote ? `age ${fmtAge(m.freshness.ageMinutes)}` : m.freshness.reason}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function useInterval(fn: () => void, ms: number) {
  useEffect(() => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}

export function useFetch<T>(path: string | null, deps: unknown[] = []): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    fetch(path)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
        return j as T;
      })
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, n, ...deps]);
  return { data, error, reload: () => setN((x) => x + 1), loading };
}
