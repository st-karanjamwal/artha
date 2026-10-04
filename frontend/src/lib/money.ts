/**
 * Money is stored as INTEGER paise (₹1 = 100). Convert only at the UI edge.
 * All conversions use string/integer math; no floating point.
 */

export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

export function formatINR(
  paise: number | null | undefined,
  opts: { symbol?: boolean; decimals?: boolean } = {},
): string {
  const { symbol = true, decimals = true } = opts;
  if (paise == null) return '';
  if (!Number.isSafeInteger(paise)) throw new Error('Money must be integer paise');
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  let s = groupIndian(String(rupees));
  if (decimals) s += '.' + String(p).padStart(2, '0');
  return (neg ? '-' : '') + (symbol ? '₹' : '') + s;
}

/** Compact form for dashboards: ₹1.25 L, ₹3.4 Cr. */
export function formatINRCompact(paise: number): string {
  const r = paise / 100;
  const a = Math.abs(r);
  const sign = r < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}₹${trim(a / 1e7)} Cr`;
  if (a >= 1e5) return `${sign}₹${trim(a / 1e5)} L`;
  return formatINR(Math.round(paise / 100) * 100, { decimals: false });
}

function trim(n: number) {
  return n.toFixed(2).replace(/\.?0+$/, '');
}

/**
 * Parse user input like "12,34,567.89", "₹ 1,000", "-25.5" to paise.
 * Returns null for empty/invalid input or more than 2 decimal places.
 */
export function parseToPaise(input: string | number | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input)
    .trim()
    .replace(/[₹,\s]/g, '')
    .replace(/^Rs\.?/i, '');
  if (s === '') return null;
  const m = /^([+-]?)(\d*)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m || (m[2] === '' && !m[3])) return null;
  const rupees = m[2] === '' ? 0 : Number(m[2]);
  const p = Number((m[3] ?? '').padEnd(2, '0'));
  const v = rupees * 100 + p;
  if (!Number.isSafeInteger(v)) return null;
  return m[1] === '-' ? -v : v;
}

/** Lenient parser for statement imports: also handles "1,234.567" (rounds), "(123.00)", "Dr/Cr". */
export function parseStatementAmount(input: unknown): number | null {
  if (input == null || input === '') return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return Math.round(input * 100);
  }
  let s = String(input).trim();
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  if (/\bdr\.?$/i.test(s)) {
    neg = true;
    s = s.replace(/\s*dr\.?$/i, '');
  }
  s = s.replace(/\s*cr\.?$/i, '');
  s = s.replace(/[₹,\s]/g, '').replace(/^(INR|Rs\.?)/i, '');
  if (s === '' || s === '-') return null;
  if (!/^[+-]?\d*(\.\d+)?$/.test(s)) return null;
  const [int, frac = ''] = s.replace(/^[+-]/, '').split('.');
  let v = Number(int || '0') * 100 + Number((frac + '00').slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) v += 1;
  if (s.startsWith('-')) neg = !neg;
  return neg ? -v : v;
}

/** For prefilling inputs: 123450 -> "1234.50". */
export function paiseToInput(paise: number | null | undefined): string {
  if (paise == null) return '';
  return formatINR(paise, { symbol: false }).replace(/,/g, '');
}
