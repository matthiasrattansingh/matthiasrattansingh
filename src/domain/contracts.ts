// Contract specifications and exact-month contract codes.
//
// Every quote, position leg and order refers to an exact contract such as HOX2026. Nothing in
// the app maps a continuous ("HO1!") or front-month alias to a specific contract silently: M1/M2
// labels are always resolved explicitly from the expiry rules below and shown next to the code.
import { lastBusinessDayOfMonth, businessDaysBefore, isBusinessDay, businessDaysBetween, type IsoDate } from './calendar.ts';

export type ProductCode = 'HO' | 'RB' | 'BZ' | 'CL';

export interface ProductSpec {
  code: ProductCode;
  name: string;
  shortName: string;
  exchange: 'NYMEX';
  unit: '$/gal' | '$/bbl';
  priceDecimals: number;
  tickSize: number;
  /** Size of one contract in its native quoting unit (42,000 gal or 1,000 bbl). */
  contractSize: number;
  contractSizeUnit: 'gal' | 'bbl';
  barrelsPerContract: number;
  /** Multiply a native price by this to express it in $/bbl (42 gal per bbl for gallon products). */
  toBarrelFactor: number;
  settlement: 'physical' | 'financial';
  expiryRule: string;
  /** Plausible native price range, used only to catch unit mistakes on manual entry. */
  sanityRange: [number, number];
  kind: 'crude' | 'product';
}

export const GALLONS_PER_BARREL = 42;

export const PRODUCTS: Record<ProductCode, ProductSpec> = {
  HO: {
    code: 'HO',
    name: 'NY Harbor ULSD (heating oil) futures',
    shortName: 'NY Harbor ULSD',
    exchange: 'NYMEX',
    unit: '$/gal',
    priceDecimals: 4,
    tickSize: 0.0001,
    contractSize: 42_000,
    contractSizeUnit: 'gal',
    barrelsPerContract: 1_000,
    toBarrelFactor: GALLONS_PER_BARREL,
    settlement: 'physical',
    expiryRule: 'Trading terminates on the last business day of the month prior to the contract month.',
    sanityRange: [0.5, 10],
    kind: 'product',
  },
  RB: {
    code: 'RB',
    name: 'RBOB gasoline futures',
    shortName: 'RBOB gasoline',
    exchange: 'NYMEX',
    unit: '$/gal',
    priceDecimals: 4,
    tickSize: 0.0001,
    contractSize: 42_000,
    contractSizeUnit: 'gal',
    barrelsPerContract: 1_000,
    toBarrelFactor: GALLONS_PER_BARREL,
    settlement: 'physical',
    expiryRule: 'Trading terminates on the last business day of the month prior to the contract month.',
    sanityRange: [0.5, 10],
    kind: 'product',
  },
  BZ: {
    code: 'BZ',
    name: 'Brent Last Day Financial futures',
    shortName: 'Brent (NYMEX BZ)',
    exchange: 'NYMEX',
    unit: '$/bbl',
    priceDecimals: 2,
    tickSize: 0.01,
    contractSize: 1_000,
    contractSizeUnit: 'bbl',
    barrelsPerContract: 1_000,
    toBarrelFactor: 1,
    settlement: 'financial',
    expiryRule: 'Trading terminates on the last business day of the second month preceding the contract month.',
    sanityRange: [10, 300],
    kind: 'crude',
  },
  CL: {
    code: 'CL',
    name: 'WTI Light Sweet Crude Oil futures',
    shortName: 'WTI crude',
    exchange: 'NYMEX',
    unit: '$/bbl',
    priceDecimals: 2,
    tickSize: 0.01,
    contractSize: 1_000,
    contractSizeUnit: 'bbl',
    barrelsPerContract: 1_000,
    toBarrelFactor: 1,
    settlement: 'physical',
    expiryRule:
      'Trading terminates 3 business days before the 25th calendar day of the month prior to the contract month (if the 25th is not a business day, 3 business days before the last business day preceding the 25th).',
    sanityRange: [10, 300],
    kind: 'crude',
  },
};

export const MONTH_CODES = ['F', 'G', 'H', 'J', 'K', 'M', 'N', 'Q', 'U', 'V', 'X', 'Z'] as const;
export type MonthCode = (typeof MONTH_CODES)[number];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ContractRef {
  code: string; // e.g. HOX2026
  product: ProductCode;
  monthCode: MonthCode;
  month: number; // 1-12
  year: number; // 4-digit
}

const CODE_RE = /^(HO|RB|BZ|CL)([FGHJKMNQUVXZ])(\d{4})$/;

export function parseContract(code: string): ContractRef {
  const m = CODE_RE.exec(code.trim().toUpperCase());
  if (!m) throw new Error(`Invalid contract code "${code}". Expected e.g. HOX2026 (root + month code + 4-digit year).`);
  const product = m[1] as ProductCode;
  const monthCode = m[2] as MonthCode;
  return { code: `${product}${monthCode}${m[3]}`, product, monthCode, month: MONTH_CODES.indexOf(monthCode) + 1, year: Number(m[3]) };
}

export function isContractCode(code: string): boolean {
  return CODE_RE.test(code.trim().toUpperCase());
}

export function contractCode(product: ProductCode, year: number, month: number): string {
  return `${product}${MONTH_CODES[month - 1]}${year}`;
}

export function contractLabel(code: string): string {
  const c = parseContract(code);
  return `${PRODUCTS[c.product].shortName} ${MONTH_NAMES[c.month - 1]} ${c.year} (${c.code})`;
}

export function contractMonthLabel(code: string): string {
  const c = parseContract(code);
  return `${MONTH_NAMES[c.month - 1]} ${c.year}`;
}

export function productOf(code: string): ProductSpec {
  return PRODUCTS[parseContract(code).product];
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const idx = year * 12 + (month - 1) + delta;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/** Last trading day computed from the CME rule for the product (approximate holiday calendar). */
export function lastTradingDay(code: string): IsoDate {
  const c = parseContract(code);
  switch (c.product) {
    case 'HO':
    case 'RB': {
      const p = shiftMonth(c.year, c.month, -1);
      return lastBusinessDayOfMonth(p.year, p.month);
    }
    case 'BZ': {
      const p = shiftMonth(c.year, c.month, -2);
      return lastBusinessDayOfMonth(p.year, p.month);
    }
    case 'CL': {
      const p = shiftMonth(c.year, c.month, -1);
      let anchor = `${p.year}-${String(p.month).padStart(2, '0')}-25` as IsoDate;
      if (!isBusinessDay(anchor)) anchor = businessDaysBefore(anchor, 1);
      return businessDaysBefore(anchor, 3);
    }
  }
}

/** Contracts of a product ordered by expiry, starting with the first one not yet expired on `asOf` (M1). */
export function activeContracts(product: ProductCode, asOf: IsoDate, count = 3): string[] {
  const [y, m] = asOf.split('-').map(Number);
  const out: string[] = [];
  for (let i = -1; i < 24 && out.length < count; i++) {
    const p = shiftMonth(y, m, i);
    const code = contractCode(product, p.year, p.month);
    if (lastTradingDay(code) >= asOf) out.push(code);
  }
  return out;
}

export function isExpired(code: string, asOf: IsoDate): boolean {
  return lastTradingDay(code) < asOf;
}

export function businessDaysToExpiry(code: string, asOf: IsoDate): number {
  return businessDaysBetween(asOf, lastTradingDay(code));
}

/** Provider symbol formats. */
export function databentoSymbol(code: string): string {
  const c = parseContract(code);
  return `${c.product}${c.monthCode}${String(c.year).slice(-1)}`; // CME Globex raw symbol, e.g. HOX6
}

export function tradingViewSymbol(code: string): string {
  const c = parseContract(code);
  return `NYMEX:${c.product}${c.monthCode}${c.year}`; // e.g. NYMEX:HOX2026
}

export function templateSymbol(code: string, template: string): string {
  const c = parseContract(code);
  return template
    .replaceAll('{root}', c.product)
    .replaceAll('{month}', c.monthCode)
    .replaceAll('{yyyy}', String(c.year))
    .replaceAll('{yy}', String(c.year).slice(-2))
    .replaceAll('{y}', String(c.year).slice(-1));
}

/** Price in $/bbl for a native quote (gallon products × 42). */
export function toPerBarrel(code: string, nativePrice: number): number {
  return nativePrice * productOf(code).toBarrelFactor;
}

export function roundToTick(code: string, price: number): number {
  const tick = productOf(code).tickSize;
  return Math.round(price / tick) * tick;
}
