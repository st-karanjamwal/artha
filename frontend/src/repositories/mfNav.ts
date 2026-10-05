import { all, one, run, tx } from '@/db/sql';
import type { AmfiScheme } from '@/features/mf/amfi';
import { getSetting, setSetting } from './settings';

export type NavSource = 'AMFI' | 'MANUAL' | 'TRANSACTION' | 'MFAPI';

/** Higher rank wins when two sources give a NAV for the same plan and date. */
const RANK: Record<NavSource, number> = { TRANSACTION: 1, MFAPI: 2, MANUAL: 3, AMFI: 4 };

export interface NavPoint {
  NAVDate: string;
  NAV: number;
  Source: NavSource;
}

/** Insert or update a NAV unless a more authoritative source already has that date. */
export function upsertNav(planId: number, date: string, nav: number, source: NavSource): boolean {
  if (!(nav > 0)) return false;
  const existing = one<{ NAVId: number; Source: NavSource; NAV: number }>(
    'SELECT NAVId, Source, NAV FROM MFNAVHistory WHERE MutualFundPlanId = ? AND NAVDate = ?',
    [planId, date],
  );
  if (!existing) {
    run('INSERT INTO MFNAVHistory (MutualFundPlanId, NAVDate, NAV, Source) VALUES (?, ?, ?, ?)', [
      planId,
      date,
      nav,
      source,
    ]);
    return true;
  }
  if (
    RANK[source] >= RANK[existing.Source] &&
    (existing.NAV !== nav || existing.Source !== source)
  ) {
    run('UPDATE MFNAVHistory SET NAV = ?, Source = ? WHERE NAVId = ?', [
      nav,
      source,
      existing.NAVId,
    ]);
    return true;
  }
  return false;
}

export function navOnOrBefore(planId: number, date: string): NavPoint | undefined {
  return one<NavPoint>(
    `SELECT NAVDate, NAV, Source FROM MFNAVHistory WHERE MutualFundPlanId = ? AND NAVDate <= ?
     ORDER BY NAVDate DESC LIMIT 1`,
    [planId, date],
  );
}

export function navOn(planId: number, date: string): NavPoint | undefined {
  return one<NavPoint>(
    'SELECT NAVDate, NAV, Source FROM MFNAVHistory WHERE MutualFundPlanId = ? AND NAVDate = ?',
    [planId, date],
  );
}

export function latestNav(planId: number): NavPoint | undefined {
  return one<NavPoint>(
    'SELECT NAVDate, NAV, Source FROM MFNAVHistory WHERE MutualFundPlanId = ? ORDER BY NAVDate DESC LIMIT 1',
    [planId],
  );
}

export function navSeries(planId: number, from = '0000-00-00'): NavPoint[] {
  return all<NavPoint>(
    'SELECT NAVDate, NAV, Source FROM MFNAVHistory WHERE MutualFundPlanId = ? AND NAVDate >= ? ORDER BY NAVDate',
    [planId, from],
  );
}

/** All NAV rows for many plans at once (for portfolio-over-time charts). */
export function navHistoryByPlan(planIds: number[]): Map<number, NavPoint[]> {
  const out = new Map<number, NavPoint[]>();
  if (!planIds.length) return out;
  const rows = all<NavPoint & { MutualFundPlanId: number }>(
    `SELECT MutualFundPlanId, NAVDate, NAV, Source FROM MFNAVHistory
     WHERE MutualFundPlanId IN (${planIds.map(() => '?').join(',')}) ORDER BY NAVDate`,
    planIds,
  );
  for (const r of rows) out.set(r.MutualFundPlanId, [...(out.get(r.MutualFundPlanId) ?? []), r]);
  return out;
}

export interface NavRefreshResult {
  updated: number;
  matched: number;
  unmatched: { MutualFundPlanId: number; label: string }[];
}

/** Match AMFI schemes to our plans by scheme code, then ISIN, and store their NAVs. */
export function applyAmfiNavs(schemes: AmfiScheme[]): NavRefreshResult {
  const byCode = new Map(schemes.map((s) => [s.schemeCode, s]));
  const byIsin = new Map<string, AmfiScheme>();
  for (const s of schemes) {
    if (s.isin) byIsin.set(s.isin, s);
    if (s.isinReinvest) byIsin.set(s.isinReinvest, s);
  }
  const plans = all<{
    MutualFundPlanId: number;
    SchemeCode: string | null;
    ISIN: string | null;
    ISINReinvest: string | null;
    FundName: string;
  }>(
    `SELECT p.MutualFundPlanId, p.SchemeCode, p.ISIN, p.ISINReinvest, f.FundName
     FROM MutualFundPlan p JOIN MutualFund f ON f.MutualFundId = p.MutualFundId`,
  );
  const result: NavRefreshResult = { updated: 0, matched: 0, unmatched: [] };
  tx(() => {
    for (const p of plans) {
      const s =
        (p.SchemeCode && byCode.get(p.SchemeCode)) ||
        (p.ISIN && byIsin.get(p.ISIN)) ||
        (p.ISINReinvest && byIsin.get(p.ISINReinvest)) ||
        undefined;
      if (!s || !s.nav || !s.navDate) {
        result.unmatched.push({ MutualFundPlanId: p.MutualFundPlanId, label: p.FundName });
        continue;
      }
      result.matched++;
      if (upsertNav(p.MutualFundPlanId, s.navDate, s.nav, 'AMFI')) result.updated++;
      // Fill in a missing scheme code / ISIN from AMFI.
      if (!p.SchemeCode || !p.ISIN) {
        run(
          `UPDATE MutualFundPlan SET SchemeCode = COALESCE(SchemeCode, ?), ISIN = COALESCE(ISIN, ?)
           WHERE MutualFundPlanId = ? AND NOT EXISTS (
             SELECT 1 FROM MutualFundPlan o WHERE o.MutualFundPlanId <> ? AND (o.SchemeCode = ? OR o.ISIN = ?))`,
          [s.schemeCode, s.isin, p.MutualFundPlanId, p.MutualFundPlanId, s.schemeCode, s.isin],
        );
      }
    }
    setSetting('MFLastNavRefresh', new Date().toISOString());
  });
  return result;
}

export const lastNavRefresh = () => getSetting('MFLastNavRefresh') ?? null;

/** Store a historical series (e.g. from the mfapi relay), only from `from` onwards. */
export function storeNavHistory(
  planId: number,
  points: { date: string; nav: number }[],
  from: string,
) {
  let n = 0;
  tx(() => {
    for (const p of points) if (p.date >= from && upsertNav(planId, p.date, p.nav, 'MFAPI')) n++;
  });
  return n;
}
