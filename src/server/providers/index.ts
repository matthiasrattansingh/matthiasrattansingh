// Market-data provider registry. Providers return quotes for exact contract codes only; a
// response for any other symbol is rejected rather than substituted.
//
// TradingView is intentionally NOT a machine-readable provider: TradingView does not offer a
// permitted programmatic quote API for this use, and its internal endpoints must not be scraped.
// The dashboard embeds TradingView's official widgets for visual reference, and values read from
// them can be entered through the manual source with "TradingView (transcribed)" as the source.
import type { AppSettings, ProviderId } from '../../shared/types.ts';
import type { Env } from '../settings.ts';
import type { ProviderQuote } from '../quotes.ts';
import { databentoProvider } from './databento.ts';
import { customHttpProvider } from './customHttp.ts';

export interface ProviderContext {
  env: Env;
  settings: AppSettings;
  fetchImpl: typeof fetch;
  nowMs: number;
}

export interface FetchResult {
  quotes: ProviderQuote[];
  errors: string[];
}

export interface QuoteProvider {
  id: ProviderId;
  label: string;
  kind: 'manual' | 'api';
  status(env: Env, settings: AppSettings): { configured: boolean; reason: string | null };
  fetchLatest(contracts: string[], ctx: ProviderContext): Promise<FetchResult>;
  /** Quotes with exchange times inside [startIso, endIso]; used for the EIA 0–15 minute reaction. */
  fetchWindow?(contracts: string[], startIso: string, endIso: string, ctx: ProviderContext): Promise<FetchResult>;
}

export const manualProvider: QuoteProvider = {
  id: 'manual',
  label: 'Manual entry (e.g. transcribed from a TradingView chart)',
  kind: 'manual',
  status: () => ({ configured: true, reason: null }),
  fetchLatest: async () => ({ quotes: [], errors: [] }),
};

export const PROVIDERS: Record<ProviderId, QuoteProvider> = {
  manual: manualProvider,
  databento: databentoProvider,
  'custom-http': customHttpProvider,
};

export function getProvider(id: ProviderId): QuoteProvider {
  return PROVIDERS[id] ?? manualProvider;
}

export { redact } from './util.ts';
