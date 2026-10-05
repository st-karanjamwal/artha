import Decimal from 'decimal.js';

/**
 * Mutual-fund quantities are INTEGER micro-units (value × 1,000,000): NAV 125.50 → 125500000,
 * units 79.677 → 79677000. Money is INTEGER paise. All multiplication/division goes through
 * decimal.js so no floating-point error reaches the database.
 */
export const MICRO = 1_000_000;

const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

function toInt(d: Decimal): number {
  const n = d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
  if (!Number.isSafeInteger(n)) throw new Error('Number out of range');
  return n;
}

/** "79.6773" → 79677300. Returns null for empty/invalid input. Rounds beyond 6 dp. */
export function parseMicro(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input)
    .trim()
    .replace(/[,\s₹]/g, '');
  if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return toInt(new D(s).times(MICRO));
}

export function toMicro(v: string | number): number {
  const m = parseMicro(v);
  if (m == null) throw new Error(`Invalid number: ${v}`);
  return m;
}

/** 79677000 → "79.677" (dp decimals, default all 6 trimmed to at least `minDp`). */
export function fromMicro(micro: number | null | undefined, dp = 6): string {
  if (micro == null) return '';
  return new D(micro).div(MICRO).toFixed(dp);
}

const groupIndian = (int: string) =>
  int.length <= 3
    ? int
    : int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + int.slice(-3);

function formatGrouped(micro: number | null | undefined, dp: number): string {
  if (micro == null) return '';
  const s = fromMicro(Math.abs(micro), dp);
  const [i, f] = s.split('.');
  return (micro < 0 ? '-' : '') + groupIndian(i) + (f ? '.' + f : '');
}

/** Units for display, 3 decimals by default (CAS precision). */
export const formatUnits = (micro: number | null | undefined, dp = 3) => formatGrouped(micro, dp);
/** NAV for display, 4 decimals. */
export const formatNav = (micro: number | null | undefined) => formatGrouped(micro, 4);

/** Market value in paise = units × NAV (both micro-units). */
export function valuePaise(unitsMicro: number, navMicro: number): number {
  // (u/1e6) × (n/1e6) rupees × 100 paise = u × n / 1e10
  return toInt(new D(unitsMicro).times(navMicro).div(1e10));
}

/**
 * Units allotted for a net amount at a NAV, rounded to `dp` decimals (AMC precision, default 3).
 * units = (paise / 100) / (nav / 1e6)
 */
export function unitsFromAmount(netPaise: number, navMicro: number, dp = 3): number {
  if (navMicro <= 0) throw new Error('NAV must be positive');
  const units = new D(netPaise).div(100).div(new D(navMicro).div(MICRO));
  return toInt(units.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).times(MICRO));
}

/** NAV (micro) implied by an amount and units. */
export function navFromAmountUnits(paise: number, unitsMicro: number): number {
  if (unitsMicro <= 0) throw new Error('Units must be positive');
  return toInt(new D(paise).div(100).div(new D(unitsMicro).div(MICRO)).times(MICRO));
}

/** Stamp duty: 0.005% of the amount invested, rounded to the paisa. */
export function stampDuty(paise: number, ratePercent = '0.005'): number {
  return toInt(new D(paise).times(ratePercent).div(100));
}

/** Pro-rata share: total × part / whole, rounded to an integer (paise). */
export function proRata(total: number, part: number, whole: number): number {
  if (whole === 0) return 0;
  return toInt(new D(total).times(part).div(whole));
}

/** Percentage in hundredths of a basis point (0.65% → 6500) ↔ "0.65". */
export function parseBps(input: string | null | undefined): number | null {
  if (input == null || String(input).trim() === '') return null;
  const s = String(input).trim().replace('%', '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return toInt(new D(s).times(10000));
}

export function formatBps(bps: number | null | undefined, dp = 2): string {
  if (bps == null) return '';
  return new D(bps).div(10000).toFixed(dp);
}

/** Percentage with given decimals, e.g. ratio(1234, 10000) → "12.34". */
export function percent(numerator: number, denominator: number, dp = 2): string {
  if (denominator === 0) return '0.00';
  return new D(numerator).times(100).div(denominator).toFixed(dp);
}
