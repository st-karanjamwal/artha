import { all, one, run, tx } from '@/db/sql';
import { nowUtc } from '@/lib/dates';
import { blankToNull } from '@/lib/validators';
import type { AmfiScheme, OptionType, PlanType } from '@/features/mf/amfi';
import { upsertNav } from './mfNav';

export interface MutualFund {
  MutualFundId: number;
  AMCName: string;
  FundName: string;
  Category: string | null;
  SubCategory: string | null;
  Benchmark: string | null;
  FundType: string | null;
  RiskLevel: string | null;
  InceptionDate: string | null;
  TaxClass: 'EQUITY' | 'DEBT' | 'OTHER' | null;
  Status: 'ACTIVE' | 'MERGED' | 'CLOSED';
  Notes: string | null;
}

export interface MutualFundPlan {
  MutualFundPlanId: number;
  MutualFundId: number;
  PlanType: PlanType;
  OptionType: OptionType;
  SchemeCode: string | null;
  ISIN: string | null;
  ISINReinvest: string | null;
  ExpenseRatioBps: number | null;
  ExitLoad: string | null;
  ExitLoadDays: number | null;
  ExitLoadPercentBps: number | null;
  PurchaseAllowed: number;
  RedemptionAllowed: number;
  Status: 'ACTIVE' | 'MERGED' | 'CLOSED';
}

export interface PlanListItem extends MutualFundPlan {
  AMCName: string;
  FundName: string;
  Category: string | null;
  SubCategory: string | null;
  RiskLevel: string | null;
  TaxClass: MutualFund['TaxClass'];
  FundStatus: MutualFund['Status'];
  LatestNAV: number | null;
  LatestNAVDate: string | null;
  TxnCount: number;
}

export const PLAN_LABEL: Record<PlanType, string> = { DIRECT: 'Direct', REGULAR: 'Regular' };
export const OPTION_LABEL: Record<OptionType, string> = {
  GROWTH: 'Growth',
  IDCW_PAYOUT: 'IDCW payout',
  IDCW_REINVEST: 'IDCW reinvest',
};

export const planVariant = (p: Pick<MutualFundPlan, 'PlanType' | 'OptionType'>) =>
  `${PLAN_LABEL[p.PlanType]} · ${OPTION_LABEL[p.OptionType]}`;
export const planLabel = (p: Pick<PlanListItem, 'FundName' | 'PlanType' | 'OptionType'>) =>
  `${p.FundName} (${planVariant(p)})`;

const PLAN_SQL = `
SELECT p.*, f.AMCName, f.FundName, f.Category, f.SubCategory, f.RiskLevel, f.TaxClass,
       f.Status AS FundStatus, n.NAV AS LatestNAV, n.NAVDate AS LatestNAVDate,
       (SELECT COUNT(*) FROM MFTransaction t WHERE t.MutualFundPlanId = p.MutualFundPlanId) AS TxnCount
FROM MutualFundPlan p
JOIN MutualFund f ON f.MutualFundId = p.MutualFundId
LEFT JOIN vMFLatestNAV n ON n.MutualFundPlanId = p.MutualFundPlanId`;

export function listPlans(opts: { includeInactive?: boolean } = {}): PlanListItem[] {
  return all<PlanListItem>(
    `${PLAN_SQL} ${opts.includeInactive ? '' : "WHERE p.Status = 'ACTIVE' AND f.Status = 'ACTIVE'"}
     ORDER BY f.AMCName, f.FundName, p.PlanType, p.OptionType`,
  );
}

export function getPlan(id: number): PlanListItem | undefined {
  return one<PlanListItem>(`${PLAN_SQL} WHERE p.MutualFundPlanId = ?`, [id]);
}

export function listFunds(includeInactive = false): MutualFund[] {
  return all<MutualFund>(
    `SELECT * FROM MutualFund ${includeInactive ? '' : "WHERE Status = 'ACTIVE'"} ORDER BY AMCName, FundName`,
  );
}

export function getFund(id: number): MutualFund | undefined {
  return one<MutualFund>('SELECT * FROM MutualFund WHERE MutualFundId = ?', [id]);
}

export function findPlan(by: {
  isin?: string | null;
  schemeCode?: string | null;
}): PlanListItem | undefined {
  if (by.isin) {
    const p = one<PlanListItem>(`${PLAN_SQL} WHERE p.ISIN = ? OR p.ISINReinvest = ?`, [
      by.isin,
      by.isin,
    ]);
    if (p) return p;
  }
  if (by.schemeCode)
    return one<PlanListItem>(`${PLAN_SQL} WHERE p.SchemeCode = ?`, [by.schemeCode]);
  return undefined;
}

export type FundInput = Omit<MutualFund, 'MutualFundId'>;

const FUND_COLS = [
  'AMCName',
  'FundName',
  'Category',
  'SubCategory',
  'Benchmark',
  'FundType',
  'RiskLevel',
  'InceptionDate',
  'TaxClass',
  'Status',
  'Notes',
] as const;

function fundValues(f: Partial<FundInput>) {
  return FUND_COLS.map((c) => {
    const v = f[c];
    if (c === 'Status') return v || 'ACTIVE';
    if (c === 'AMCName' || c === 'FundName') return String(v ?? '').trim();
    return typeof v === 'string' ? blankToNull(v) : (v ?? null);
  });
}

export function createFund(f: Partial<FundInput>): number {
  if (!f.AMCName?.trim() || !f.FundName?.trim()) throw new Error('AMC and fund name are required');
  const dup = one<{ MutualFundId: number }>(
    'SELECT MutualFundId FROM MutualFund WHERE AMCName = ? AND FundName = ?',
    [f.AMCName.trim(), f.FundName.trim()],
  );
  if (dup) throw new Error('This fund already exists');
  return run(
    `INSERT INTO MutualFund (${FUND_COLS.join(', ')}) VALUES (${FUND_COLS.map(() => '?').join(', ')})`,
    fundValues(f),
  ).lastId;
}

export function updateFund(id: number, f: Partial<FundInput>) {
  run(
    `UPDATE MutualFund SET ${FUND_COLS.map((c) => `${c} = ?`).join(', ')}, UpdatedOn = ? WHERE MutualFundId = ?`,
    [...fundValues(f), nowUtc(), id],
  );
}

export type PlanInput = Omit<MutualFundPlan, 'MutualFundPlanId' | 'MutualFundId'>;

const PLAN_COLS = [
  'PlanType',
  'OptionType',
  'SchemeCode',
  'ISIN',
  'ISINReinvest',
  'ExpenseRatioBps',
  'ExitLoad',
  'ExitLoadDays',
  'ExitLoadPercentBps',
  'PurchaseAllowed',
  'RedemptionAllowed',
  'Status',
] as const;

function planValues(p: Partial<PlanInput>) {
  return PLAN_COLS.map((c) => {
    const v = p[c];
    if (c === 'Status') return v || 'ACTIVE';
    if (c === 'PurchaseAllowed' || c === 'RedemptionAllowed') return v ?? 1;
    if (c === 'ISIN' || c === 'ISINReinvest')
      return typeof v === 'string' ? (blankToNull(v)?.toUpperCase() ?? null) : null;
    return typeof v === 'string' ? blankToNull(v) : (v ?? null);
  });
}

function checkPlanUnique(p: Partial<PlanInput>, exceptId = 0) {
  if (
    p.SchemeCode &&
    one('SELECT 1 FROM MutualFundPlan WHERE SchemeCode = ? AND MutualFundPlanId <> ?', [
      p.SchemeCode,
      exceptId,
    ])
  ) {
    throw new Error(`Scheme code ${p.SchemeCode} is already used by another plan`);
  }
  if (
    p.ISIN &&
    one('SELECT 1 FROM MutualFundPlan WHERE ISIN = ? AND MutualFundPlanId <> ?', [
      p.ISIN.toUpperCase(),
      exceptId,
    ])
  ) {
    throw new Error(`ISIN ${p.ISIN} is already used by another plan`);
  }
}

export function createPlan(fundId: number, p: Partial<PlanInput>): number {
  if (!p.PlanType || !p.OptionType) throw new Error('Plan and option are required');
  if (
    one('SELECT 1 FROM MutualFundPlan WHERE MutualFundId = ? AND PlanType = ? AND OptionType = ?', [
      fundId,
      p.PlanType,
      p.OptionType,
    ])
  ) {
    throw new Error('This plan/option already exists for the fund');
  }
  checkPlanUnique(p);
  return run(
    `INSERT INTO MutualFundPlan (MutualFundId, ${PLAN_COLS.join(', ')})
     VALUES (?, ${PLAN_COLS.map(() => '?').join(', ')})`,
    [fundId, ...planValues(p)],
  ).lastId;
}

export function updatePlan(id: number, p: Partial<PlanInput>) {
  checkPlanUnique(p, id);
  run(
    `UPDATE MutualFundPlan SET ${PLAN_COLS.map((c) => `${c} = ?`).join(', ')}, UpdatedOn = ?
     WHERE MutualFundPlanId = ?`,
    [...planValues(p), nowUtc(), id],
  );
}

/** Delete a plan that has no transactions or SIPs (mistakes); otherwise mark it CLOSED. */
export function deletePlan(id: number) {
  const used = one<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM MFTransaction WHERE MutualFundPlanId = ?) +
            (SELECT COUNT(*) FROM SIP WHERE MutualFundPlanId = ?) AS n`,
    [id, id],
  )!.n;
  if (used) throw new Error('This plan has transactions or SIPs; set its status to Closed instead');
  tx(() => {
    const fundId = one<{ MutualFundId: number }>(
      'SELECT MutualFundId FROM MutualFundPlan WHERE MutualFundPlanId = ?',
      [id],
    )?.MutualFundId;
    run('DELETE FROM MutualFundPlan WHERE MutualFundPlanId = ?', [id]);
    if (fundId && !one('SELECT 1 FROM MutualFundPlan WHERE MutualFundId = ?', [fundId])) {
      run('DELETE FROM MutualFund WHERE MutualFundId = ?', [fundId]);
    }
  });
}

/** Create (or reuse) the fund and plan for an AMFI scheme; stores its latest NAV. Returns plan id. */
export function addPlanFromAmfi(s: AmfiScheme): number {
  const existing = findPlan({ isin: s.isin, schemeCode: s.schemeCode });
  if (existing) return existing.MutualFundPlanId;
  return tx(() => {
    const amc = s.amc.trim() || 'Unknown AMC';
    let fundId = one<{ MutualFundId: number }>(
      'SELECT MutualFundId FROM MutualFund WHERE AMCName = ? AND FundName = ?',
      [amc, s.fundName],
    )?.MutualFundId;
    fundId ??= createFund({
      AMCName: amc,
      FundName: s.fundName,
      Category: s.category || null,
      SubCategory: s.subCategory || null,
      FundType: s.fundType || null,
    });
    const planId = createPlan(fundId, {
      PlanType: s.planType,
      OptionType: s.optionType,
      SchemeCode: s.schemeCode,
      ISIN: s.isin,
      ISINReinvest: s.isinReinvest,
    });
    if (s.nav && s.navDate) upsertNav(planId, s.navDate, s.nav, 'AMFI');
    return planId;
  });
}
