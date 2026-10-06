// Quote freshness classification. A quote is a valid mark only when it is for the exact
// contract requested and is not stale. Exchange (displayed) time drives freshness; local
// observation time is recorded separately and never used as a stand-in for market time.
import { isMarketOpen, previousSession, toEt } from './calendar.ts';

export type QuoteStatus = 'realtime' | 'delayed' | 'closed-last' | 'stale' | 'unavailable' | 'invalid-future';

export interface QuoteLike {
  contract: string;
  price: number;
  exchangeTs: string; // ISO instant of the exchange/displayed timestamp
  observedAt: string; // ISO instant at which this app observed/recorded the quote
  delayMinutes: number | null; // declared delay of the source (e.g. ~10 for TradingView)
  source: string;
}

export interface Freshness {
  status: QuoteStatus;
  valid: boolean;
  ageMinutes: number | null;
  marketOpen: boolean;
  reason: string;
}

export const FUTURE_TOLERANCE_MS = 2 * 60_000;

export function classifyQuote(q: QuoteLike | undefined | null, nowMs: number, staleToleranceMinutes: number): Freshness {
  const marketOpen = isMarketOpen(nowMs);
  if (!q) return { status: 'unavailable', valid: false, ageMinutes: null, marketOpen, reason: 'No quote recorded for this exact contract.' };
  const exMs = Date.parse(q.exchangeTs);
  const ageMinutes = (nowMs - exMs) / 60_000;
  if (exMs - nowMs > FUTURE_TOLERANCE_MS) {
    return {
      status: 'invalid-future',
      valid: false,
      ageMinutes,
      marketOpen,
      reason: 'Exchange timestamp is in the future — check the time zone of the displayed timestamp.',
    };
  }
  const exEt = toEt(exMs).toFormat("ccc HH:mm 'ET'");
  if (marketOpen) {
    const delay = q.delayMinutes ?? 0;
    const limit = delay + staleToleranceMinutes;
    if (ageMinutes > limit) {
      return {
        status: 'stale',
        valid: false,
        ageMinutes,
        marketOpen,
        reason: `Exchange time ${exEt} is ${Math.round(ageMinutes)} min old; limit while the market is open is ${limit} min (declared delay ${delay} + tolerance ${staleToleranceMinutes}).`,
      };
    }
    const status: QuoteStatus = delay > 0 || ageMinutes > 2 ? 'delayed' : 'realtime';
    return {
      status,
      valid: true,
      ageMinutes,
      marketOpen,
      reason: status === 'delayed' ? `Delayed quote: exchange time ${exEt} (${Math.round(ageMinutes)} min old).` : `Exchange time ${exEt}.`,
    };
  }
  const prev = previousSession(nowMs);
  if (exMs >= Date.parse(prev.startUtc)) {
    return {
      status: 'closed-last',
      valid: true,
      ageMinutes,
      marketOpen,
      reason: `Market closed; last quote of the session for trade date ${prev.tradeDate} (exchange time ${exEt}).`,
    };
  }
  return {
    status: 'stale',
    valid: false,
    ageMinutes,
    marketOpen,
    reason: `Market closed and this quote (${exEt}) predates the most recent session (trade date ${prev.tradeDate}).`,
  };
}
