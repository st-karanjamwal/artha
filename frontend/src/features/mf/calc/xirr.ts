/**
 * XIRR as Excel computes it: Σ amount / (1 + r)^((d − d0) / 365) = 0.
 * Cash flows in paise: money out (investments) negative, money in (redemptions, current value)
 * positive. Returns the annual rate as a fraction (0.1234 = 12.34%), or null if undefined.
 * Rates are display-only, so floating point is fine here (money is never derived from them).
 */
export interface CashFlow {
  date: string; // YYYY-MM-DD
  amount: number;
}

const DAY_MS = 86_400_000;
const toDays = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

export function xirr(flows: CashFlow[], guess = 0.1): number | null {
  const fs = flows.filter((f) => f.amount !== 0);
  if (!fs.some((f) => f.amount > 0) || !fs.some((f) => f.amount < 0)) return null;
  const d0 = Math.min(...fs.map((f) => toDays(f.date)));
  const pts = fs.map((f) => ({ t: (toDays(f.date) - d0) / 365, a: f.amount }));
  const npv = (r: number) => pts.reduce((s, p) => s + p.a / Math.pow(1 + r, p.t), 0);
  const dnpv = (r: number) => pts.reduce((s, p) => s - (p.t * p.a) / Math.pow(1 + r, p.t + 1), 0);
  const scale = pts.reduce((s, p) => s + Math.abs(p.a), 0);
  const tol = 1e-10 * scale;

  // Newton-Raphson
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const f = npv(r);
    if (Math.abs(f) < tol) return r;
    const df = dnpv(r);
    if (!Number.isFinite(df) || df === 0) break;
    const next = r - f / df;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }

  // Bisection fallback on a bracket that changes sign.
  let lo = -0.999999;
  let hi = 1;
  while (npv(lo) * npv(hi) > 0 && hi < 1e6) hi *= 2;
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    const f = npv(mid);
    if (Math.abs(f) < tol || hi - lo < 1e-12) return mid;
    if (npv(lo) * f < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

/** CAGR between two values over a period; fraction or null. */
export function cagr(start: number, end: number, fromIso: string, toIso: string): number | null {
  const years = (toDays(toIso) - toDays(fromIso)) / 365;
  if (start <= 0 || end <= 0 || years <= 0) return null;
  return Math.pow(end / start, 1 / years) - 1;
}

export function formatRate(r: number | null | undefined, dp = 2): string {
  if (r == null || !Number.isFinite(r)) return '—';
  return `${(r * 100).toFixed(dp)}%`;
}
