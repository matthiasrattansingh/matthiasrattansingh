import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { StateDto } from '../../src/shared/types.ts';
import { api } from './api.ts';
import { Ctx, type AppCtx, useInterval, Alert } from './components/ui.tsx';
import { Icon } from './icons.tsx';
import { fmtEt, fmtLocalTime, fmtUsd, resolveZone } from './format.ts';
import { TodayPage } from './pages/Today.tsx';
import { MarketPage } from './pages/Market.tsx';
import { PositionsPage } from './pages/Positions.tsx';
import { AccountPage } from './pages/Account.tsx';
import { TradePage } from './pages/Trade.tsx';
import { EiaPage } from './pages/Eia.tsx';
import { HistoryPage } from './pages/History.tsx';
import { SettingsPage } from './pages/Settings.tsx';

const ROUTES: { id: string; label: string; icon: ReactNode; render: () => ReactNode }[] = [
  { id: 'today', label: 'Today', icon: Icon.today, render: () => <TodayPage /> },
  { id: 'market', label: 'Market', icon: Icon.market, render: () => <MarketPage /> },
  { id: 'positions', label: 'Positions', icon: Icon.positions, render: () => <PositionsPage /> },
  { id: 'account', label: 'Account', icon: Icon.account, render: () => <AccountPage /> },
  { id: 'trade', label: 'Trade entry', icon: Icon.trade, render: () => <TradePage /> },
  { id: 'eia', label: 'EIA', icon: Icon.eia, render: () => <EiaPage /> },
  { id: 'history', label: 'History', icon: Icon.history, render: () => <HistoryPage /> },
  { id: 'settings', label: 'Settings', icon: Icon.settings, render: () => <SettingsPage /> },
];

function useRoute(): string {
  const read = () => (window.location.hash.replace(/^#\/?/, '').split('?')[0] || 'today').toLowerCase();
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function StatusBar({ state, uiRefreshedAt, zone, onRefresh, refreshing }: { state: StateDto; uiRefreshedAt: number | null; zone: string; onRefresh: () => void; refreshing: boolean }) {
  const s = state.scheduler;
  const legs = state.positions.flatMap((p) => p.mark?.legs ?? []);
  const legTimes = legs.map((l) => l.quote?.exchangeTs).filter(Boolean) as string[];
  const oldest = legTimes.sort()[0];
  const legsValid = legs.length > 0 && legs.every((l) => l.freshness.valid);
  return (
    <div className="statusbar" role="status" aria-live="polite">
      <span className="item">
        <span className="dot" style={{ background: s.marketOpen ? 'var(--good)' : 'var(--axis)' }} />
        <strong>NYMEX {s.marketOpen ? 'open' : 'closed'}</strong>
        <span>{s.marketOpen ? `trade date ${s.tradeDate}` : s.nextSessionOpen ? `opens ${fmtEt(s.nextSessionOpen)}` : ''}</span>
      </span>
      <span className="item" title="Exchange/displayed timestamp of the oldest position-leg quote (market-data time)">
        {Icon.clock}
        <span>Market data:</span>
        <strong>{oldest ? fmtEt(oldest) : 'no quotes'}</strong>
        {legs.length ? <span className={`badge ${legsValid ? 'info' : 'warn'}`}>{legsValid ? 'valid' : 'provisional'}</span> : null}
      </span>
      <span className="item" title="When this page last pulled state from the server (app refresh time)">
        <span>App refreshed:</span>
        <strong>{uiRefreshedAt ? fmtLocalTime(uiRefreshedAt, zone, true) : '—'}</strong>
      </span>
      <span className="item" title="Last successful scheduled hourly mark / next scheduled slot">
        <span>Hourly mark:</span>
        <strong>{s.hourly.lastSuccess ? fmtEt(s.hourly.lastSuccess.scheduledFor) : 'none yet'}</strong>
        <span>· next {s.hourly.next ? fmtEt(s.hourly.next, false) : '—'}</span>
        {!s.running ? <span className="badge bad">scheduler off</span> : null}
      </span>
      <span className="spacer" />
      <span className="item">
        <span>Equity</span>
        <strong>{fmtUsd(state.account.equity)}</strong>
        {!state.account.equityValid ? <span className="badge warn">provisional</span> : null}
      </span>
      <button className="btn small" onClick={onRefresh} disabled={refreshing} title={state.provider.kind === 'manual' ? 'Re-mark positions with the stored quotes' : 'Fetch quotes from the configured provider and re-mark'}>
        {Icon.refresh}
        {refreshing ? 'Refreshing…' : state.provider.kind === 'manual' ? 'Re-mark' : 'Refresh quotes'}
      </button>
    </div>
  );
}

export function App() {
  const route = useRoute();
  const [state, setState] = useState<StateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uiRefreshedAt, setUiRefreshedAt] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; tone: 'good' | 'bad' | 'info' | 'warn' } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await api<StateDto>('/api/state');
      setState(s);
      setError(null);
      setUiRefreshedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useInterval(refresh, 15_000);

  const notify = useCallback((msg: string, tone: 'good' | 'bad' | 'info' | 'warn' = 'info') => {
    setToast({ msg, tone });
    window.setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 6000);
  }, []);

  const zone = resolveZone(state?.settings.displayTimeZone);
  const ctx: AppCtx = useMemo(() => ({ state, zone, uiRefreshedAt, refresh, notify }), [state, zone, uiRefreshedAt, refresh, notify]);
  const current = ROUTES.find((r) => r.id === route) ?? ROUTES[0];

  const doRefresh = async () => {
    setRefreshing(true);
    try {
      const r = await api<{ fetch: { attempted: boolean; ok: boolean; errors: string[]; note: string | null; fetched: number }; actions: { summary: string }[] }>('/api/refresh', { method: 'POST' });
      if (r.fetch.attempted && !r.fetch.ok) notify(`Fetch failed: ${r.fetch.errors.join('; ')}`, 'bad');
      else if (r.fetch.errors.length) notify(`Fetched ${r.fetch.fetched} quote(s) with issues: ${r.fetch.errors.join('; ')}`, 'warn');
      else notify(r.fetch.note ?? `Fetched ${r.fetch.fetched} quote(s).${r.actions.length ? ` ${r.actions.map((a) => a.summary).join('; ')}` : ''}`, 'good');
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'bad');
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar" aria-label="Main navigation">
          <div className="brand">
            <div className="brand-mark">
              <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true">
                <path d="M5 22l7-8 6 5 9-11" stroke="#fff" strokeWidth="3.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <div>
              <div className="brand-title">Crack Paper Trader</div>
              <div className="brand-sub">Brent &amp; refined products · simulated</div>
            </div>
          </div>
          <nav className="nav">
            {ROUTES.map((r) => (
              <a key={r.id} href={`#/${r.id}`} aria-current={r.id === current.id ? 'page' : undefined}>
                {r.icon}
                {r.label}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            <span>Paper trading only. No broker connection; no real orders are ever sent.</span>
            <span>Display zone: {zone}</span>
          </div>
        </aside>
        <div className="main">
          <nav className="mobile-nav" aria-label="Main navigation">
            {ROUTES.map((r) => (
              <a key={r.id} href={`#/${r.id}`} aria-current={r.id === current.id ? 'page' : undefined}>
                {r.label}
              </a>
            ))}
          </nav>
          {state ? <StatusBar state={state} uiRefreshedAt={uiRefreshedAt} zone={zone} onRefresh={doRefresh} refreshing={refreshing} /> : null}
          <main className="content">
            {error ? <Alert tone="bad">Cannot reach the server: {error}. Showing the last loaded state (if any).</Alert> : null}
            {state ? current.render() : !error ? <p className="empty">Loading…</p> : null}
          </main>
        </div>
      </div>
      {toast ? (
        <div className="toast">
          <Alert tone={toast.tone}>{toast.msg}</Alert>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}
