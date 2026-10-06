// DTOs shared by the API server and the dashboard. Type-only module.

export type ProviderId = 'manual' | 'databento' | 'custom-http';
export type QuoteStatus = 'realtime' | 'delayed' | 'closed-last' | 'stale' | 'unavailable' | 'invalid-future';

export interface EiaOverrideDto {
  date: string;
  releaseDate: string | null;
  timeEt: string;
}

export interface CustomHttpSettings {
  urlTemplate: string; // e.g. https://api.example.com/quote?symbol={symbol}&key={apiKey}
  symbolTemplate: string; // tokens: {root} {month} {yyyy} {yy} {y}
  pricePath: string; // dot path into the JSON response, e.g. "data.last"
  timestampPath: string;
  timestampFormat: 'iso' | 'epoch_ms' | 'epoch_s';
  symbolPath: string; // optional; when set the echoed symbol must equal the requested symbol
  delayMinutes: number;
  authHeader: string; // optional header name that receives CUSTOM_QUOTE_API_KEY
  sourceLabel: string;
}

export interface AppSettings {
  provider: ProviderId;
  displayTimeZone: string; // 'auto' or an IANA zone
  hourlyEnabled: boolean;
  hourlyMinuteOffset: number;
  briefingEnabled: boolean;
  briefingTimeEt: string;
  staleToleranceMinutes: number;
  manualDefaultDelayMinutes: number;
  fillPolicy: 'next_mark_after_submit' | 'current_valid_mark';
  dailyTradeLimit: number;
  commissionPerContractPerSide: number | null;
  slippageTicksPerLeg: number | null;
  maxDrawdownPct: number;
  marginMaxAgeDays: number;
  expiryGuardEnabled: boolean;
  expiryGuardTimeEt: string;
  eiaPollEnabled: boolean;
  eiaOverrides: EiaOverrideDto[];
  fillPollMinutes: number;
  customHttp: CustomHttpSettings;
  databentoDataset: string;
  databentoDelayMinutes: number;
  tradingViewWidgets: boolean;
  fxPairs: string[];
}

export interface QuoteDto {
  id: number;
  contract: string;
  contractLabel: string;
  price: number;
  unit: string;
  perBarrel: number;
  source: string;
  sourceKind: 'manual' | 'api';
  provider: ProviderId;
  providerSymbol: string | null;
  delayMinutes: number | null;
  exchangeTs: string;
  observedAt: string;
  basis: string | null;
  note: string | null;
}

export interface FreshnessDto {
  status: QuoteStatus;
  valid: boolean;
  ageMinutes: number | null;
  marketOpen: boolean;
  reason: string;
}

export interface ContractMarkDto {
  contract: string;
  label: string;
  product: string;
  unit: string;
  role?: string; // e.g. "Brent M1"
  lastTradingDay: string;
  businessDaysToExpiry: number;
  quote: QuoteDto | null;
  freshness: FreshnessDto;
}

export interface LegDto {
  contract: string;
  weight: 1 | -1;
}

export interface LegFillDto {
  contract: string;
  side: 1 | -1;
  price: number;
  markPrice: number;
}

export type ExitRule =
  | { type: 'eia_distillate_builds'; weeks: number }
  | { type: 'stop_value'; level: number }
  | { type: 'target_value'; level: number }
  | { type: 'max_loss_usd'; amount: number }
  | { type: 'close_on_date'; date: string; timeEt: string };

export interface PositionMarkDto {
  valid: boolean;
  provisional: boolean;
  value: number | null; // current strategy value in $/bbl
  unrealized: number | null;
  missing: string[]; // human-readable missing/stale inputs
  legs: ContractMarkDto[];
}

export interface PositionDto {
  id: number;
  strategy: 'crack' | 'calendar' | 'outright';
  label: string;
  direction: 1 | -1;
  legs: LegDto[];
  contractsPerLeg: number;
  barrels: number;
  entryValue: number;
  entryFills: LegFillDto[] | null;
  entryKind: 'seed' | 'order';
  entryNote: string;
  openedAt: string;
  orderId: number | null;
  rationale: string | null;
  exitRuleText: string | null;
  exitRules: ExitRule[];
  entryCommission: number | null;
  status: 'open' | 'exit_pending' | 'closed';
  exitPending: { reason: string; kind: string; requestedAt: string; notBefore: string } | null;
  closedAt: string | null;
  exitValue: number | null;
  exitFills: LegFillDto[] | null;
  exitReason: string | null;
  exitKind: string | null;
  exitCommission: number | null;
  realizedGross: number | null;
  valueFormula: string;
  mark?: PositionMarkDto;
  margin?: MarginRequirementDto;
  drawdownTriggerValue?: number | null;
  ruleStatus?: { rule: ExitRule; text: string }[];
}

export interface MarginFigureDto {
  key: string;
  perUnitUsd: number;
  source: string;
  asOfDate: string;
  enteredAt: string;
  note?: string | null;
}

export interface MarginRequirementDto {
  known: boolean;
  amount: number | null;
  basis: 'spread' | 'sum-of-legs' | 'unknown';
  figures: MarginFigureDto[];
  missing: string[];
  stale: string[];
  explanation: string;
}

export interface BuyingPowerDto {
  equity: number;
  equityValid: boolean;
  reservedMargin: number | null;
  reservedKnown: boolean;
  buyingPower: number | null;
  verified: boolean;
  reasons: string[];
}

export interface AccountDto {
  id: number;
  createdAt: string;
  startingEquity: number;
  status: 'active' | 'halted' | 'archived';
  haltedAt: string | null;
  haltedReason: string | null;
  peakEquity: number;
  peakAt: string;
  realizedGross: number;
  fees: number;
  unrealized: number | null;
  unrealizedProvisional: number | null;
  equity: number;
  equityValid: boolean;
  equityReasons: string[];
  totalPnl: number;
  drawdownPct: number;
  maxDrawdownPct: number;
  drawdownFloorEquity: number;
  distanceToLimitUsd: number;
  provisionalBreach: boolean;
  buyingPower: BuyingPowerDto;
  costsConfigured: boolean;
}

export interface OrderRequestDto {
  idempotencyKey: string;
  strategy: 'crack' | 'calendar' | 'outright';
  direction: 'long' | 'short';
  legs: LegDto[];
  quantity: { contracts?: number; barrels?: number };
  entryMethod: 'market' | 'limit';
  limitValue?: number | null;
  timeInForce: 'day' | 'gtc';
  rationale: string;
  exitRuleText: string;
  exitRules: ExitRule[];
}

export interface MarginCheckDto {
  ok: boolean;
  reasons: string[];
  required: MarginRequirementDto;
  before: BuyingPowerDto;
  buyingPowerAfter: number | null;
  reservedAfter: number | null;
}

export interface OrderPreviewDto {
  ok: boolean;
  reasons: string[];
  warnings: string[];
  summary: {
    direction: string;
    label: string;
    legs: { contract: string; label: string; side: 'buy' | 'sell'; contracts: number; barrels: number }[];
    contractsPerLeg: number;
    barrels: number;
    entryMethod: string;
    exitRuleText: string;
    exitRules: string[];
    valueFormula: string;
    currentValue: number | null;
    currentValueValid: boolean;
    notionalNote: string;
  };
  margin: MarginCheckDto | null;
  tradesToday: number;
  dailyLimit: number;
}

export interface OrderDto {
  id: number;
  idempotencyKey: string;
  submittedAt: string;
  tradeDate: string;
  status: 'rejected' | 'working' | 'filled' | 'cancelled' | 'expired';
  request: OrderRequestDto;
  reasons: string[];
  margin: MarginCheckDto | null;
  positionId: number | null;
  updatedAt: string;
  fill: unknown;
}

export interface EventDto {
  id: number;
  ts: string;
  type: string;
  summary: string;
  detail: unknown;
}

export interface JobDto {
  key: string;
  kind: string;
  scheduledFor: string | null;
  status: string;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  detail: unknown;
}

export interface SchedulerStatusDto {
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  marketOpen: boolean;
  tradeDate: string | null;
  nextSessionOpen: string | null;
  hourly: { enabled: boolean; lastSuccess: JobDto | null; lastAttempt: JobDto | null; next: string | null; recentMissed: JobDto[] };
  briefing: { enabled: boolean; next: string | null; last: JobDto | null };
  eia: { next: { releaseDate: string; releaseUtc: string; timeEt: string; weekEnding: string; source: string } | null };
  limitations: string[];
}

export interface ProviderStatusDto {
  id: ProviderId;
  label: string;
  configured: boolean;
  reason: string | null;
  kind: 'manual' | 'api';
  lastFetch: JobDto | null;
}

export interface StateDto {
  now: string;
  account: AccountDto;
  positions: PositionDto[];
  closedPositions: PositionDto[];
  workingOrders: OrderDto[];
  contracts: ContractMarkDto[];
  settings: AppSettings;
  secrets: { databento: boolean; customHttp: boolean; eia: boolean; basicAuth: boolean };
  provider: ProviderStatusDto;
  scheduler: SchedulerStatusDto;
  lastMark: { ts: string; trigger: string; valid: boolean } | null;
  lastSuccessfulRefresh: string | null;
  warnings: string[];
  tradesToday: number;
  decisionToday: { type: string; ts: string; summary: string } | null;
  watchItems: NoteDto[];
}

export interface NoteDto {
  id: number;
  createdAt: string;
  kind: 'watch-only' | 'note';
  title: string;
  body: string | null;
}

export interface InventoryDto {
  id: number;
  series: string;
  weekEnding: string;
  levelKb: number | null;
  changeKb: number | null;
  kind: 'actual' | 'estimate' | 'api';
  source: string;
  releasedAt: string | null;
  enteredAt: string;
}

export interface FxRateDto {
  pair: string;
  asOfDate: string;
  rate: number;
  source: string;
  observedAt: string;
}

export interface FxRowDto {
  pair: string;
  label: string;
  linkage: string;
  value: number | null;
  asOfDate: string | null;
  change1d: { abs: number; pct: number; fromDate: string } | null;
  change2d: { abs: number; pct: number; fromDate: string } | null;
  source: string | null;
  note: string | null;
}

export interface SpreadDto {
  key: string;
  label: string;
  formula: string;
  contracts: string[];
  value: number | null;
  valid: boolean;
  unit: string;
  asOf: string | null; // oldest exchange time among inputs
  missing: string[];
  change48h: { from: number; fromTs: string; abs: number } | null;
  change48hNote: string | null;
}

export interface BulletDto {
  text: string;
  basis: string;
}

export interface SnapshotDto {
  generatedAt: string;
  marketOpen: boolean;
  tradeDate: string | null;
  contracts: ContractMarkDto[];
  spreads: SpreadDto[];
  fx: FxRowDto[];
  inventories: InventorySummaryDto;
  context: BulletDto[]; // mixed context items, relevance not assessed (includes plausible red herrings)
  dataQuality: string[];
  disclaimer: string;
}

export interface InventorySummaryDto {
  latestWeek: string | null;
  rows: {
    series: string;
    label: string;
    actual: { weekEnding: string; levelKb: number | null; changeKb: number | null; source: string; releasedAt: string | null } | null;
    estimate: { weekEnding: string; changeKb: number | null; source: string } | null;
    api: { weekEnding: string; changeKb: number | null; source: string } | null;
  }[];
  distillateStreak: { streak: number; latestWeek: string | null; note: string; weeks: { weekEnding: string; changeKb: number }[] };
  nextRelease: { releaseDate: string; timeEt: string; releaseUtc: string; weekEnding: string; source: string } | null;
}

export interface BriefingDto {
  key: string;
  kind: 'scheduled' | 'adhoc';
  scheduledFor: string | null;
  generatedAt: string;
  late: boolean;
  content: {
    title: string;
    overnight: BulletDto[];
    trends: BulletDto[];
    m1m2: SpreadDto | null;
    fx: FxRowDto[];
    inventories: InventorySummaryDto;
    inventoryNotes: BulletDto[];
    investigate: BulletDto[];
    redHerrings: BulletDto[];
    dataQuality: string[];
    calendar: BulletDto[];
    userNotes: BulletDto[];
    disclaimer: string;
  };
}

export interface ReactionLegDto {
  contract: string;
  pre: { price: number; exchangeTs: string; source: string } | null;
  post: { price: number; exchangeTs: string; source: string } | null;
  inWindow: { count: number; high: number | null; low: number | null };
  change: number | null;
  changePerBbl: number | null;
  note: string;
}

export interface ReactionDto {
  releaseDate: string;
  releaseUtc: string;
  windowEndUtc: string;
  status: 'pending' | 'complete' | 'partial' | 'missing';
  updatedAt: string;
  finalizedAt: string | null;
  eiaArrivedAt: string | null;
  eiaData: { series: string; weekEnding: string; changeKb: number | null; levelKb: number | null; estimateChangeKb: number | null }[];
  legs: ReactionLegDto[];
  crack: { contracts: string[]; pre: number | null; post: number | null; change: number | null; note: string } | null;
  notes: string[];
}

export interface UpdateReportDto {
  slotKey: string;
  createdAt: string;
  report: {
    trigger: string;
    provider: string;
    fetch: { attempted: boolean; ok: boolean; errors: string[]; fetched: number };
    legs: { contract: string; label: string; price: number | null; unit: string; perBarrel: number | null; exchangeTs: string | null; observedAt: string | null; source: string | null; status: string; reason: string }[];
    positions: { id: number; label: string; entryValue: number; value: number | null; unrealized: number | null; valid: boolean; missing: string[] }[];
    account: {
      realized: number;
      unrealized: number | null;
      fees: number;
      totalPnl: number;
      equity: number;
      equityValid: boolean;
      peakEquity: number;
      drawdownPct: number;
      reservedMargin: number | null;
      buyingPower: number | null;
      buyingPowerVerified: boolean;
      distanceToLimitUsd: number;
      grossBeforeCosts: boolean;
    };
    events: { ts: string; type: string; summary: string }[];
  };
}

export interface MarkPointDto {
  ts: string;
  trigger: string;
  valid: boolean;
  equity: number;
  drawdownPct: number;
  values: Record<string, number | null>; // positionId -> strategy value
}
