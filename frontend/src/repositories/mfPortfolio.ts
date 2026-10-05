import { todayLocal } from '@/lib/dates';
import { valuePaise } from '@/lib/units';
import { runFifo, type Lot, type Realisation } from '@/features/mf/calc/fifo';
import {
  classifyRealisation,
  classifyTerm,
  summariseFy,
  taxClassFor,
  validateTaxRules,
  type GainRow,
  type TaxClass,
  type TaxRules,
} from '@/features/mf/calc/tax';
import { xirr, type CashFlow } from '@/features/mf/calc/xirr';
import { all } from '@/db/sql';
import { allMFTransactions, cashDirection, type MFTransactionRow } from './mfTransactions';
import { navHistoryByPlan, navOnOrBefore } from './mfNav';
import { getSetting, setSetting } from './settings';
import migrationSql from '@/db/migrations/003_mutual_funds.sql?raw';

// ---------------------------------------------------------------- tax rules

export function defaultTaxRules(): TaxRules {
  const json = /json\('([\s\S]*?)'\)/.exec(migrationSql)![1];
  return JSON.parse(json) as TaxRules;
}

export function getTaxRules(): TaxRules {
  try {
    const r = JSON.parse(getSetting('MFTaxRules') ?? 'null');
    validateTaxRules(r);
    return r;
  } catch {
    return defaultTaxRules();
  }
}

export function saveTaxRules(r: unknown) {
  validateTaxRules(r);
  setSetting('MFTaxRules', JSON.stringify(r));
}

// ---------------------------------------------------------------- holdings

interface FundMeta {
  MutualFundPlanId: number;
  FundName: string;
  AMCName: string;
  Category: string | null;
  SubCategory: string | null;
  TaxClass: TaxClass | null;
  PlanType: 'DIRECT' | 'REGULAR';
  OptionType: 'GROWTH' | 'IDCW_PAYOUT' | 'IDCW_REINVEST';
}

function planMeta(): Map<number, FundMeta> {
  return new Map(
    all<FundMeta>(
      `SELECT p.MutualFundPlanId, f.FundName, f.AMCName, f.Category, f.SubCategory, f.TaxClass,
              p.PlanType, p.OptionType
       FROM MutualFundPlan p JOIN MutualFund f ON f.MutualFundId = p.MutualFundId`,
    ).map((m) => [m.MutualFundPlanId, m]),
  );
}

export interface Holding {
  key: string;
  InvestmentAccountId: number;
  AccountName: string;
  FolioId: number | null;
  FolioNo: string | null;
  MutualFundPlanId: number;
  PersonId: number;
  PersonName: string;
  FundName: string;
  AMCName: string;
  Category: string;
  SubCategory: string;
  PlanType: 'DIRECT' | 'REGULAR';
  OptionType: 'GROWTH' | 'IDCW_PAYOUT' | 'IDCW_REINVEST';
  taxClass: TaxClass;
  units: number;
  invested: number; // remaining FIFO cost, paise
  avgCost: number | null; // NAV-like micro-units per unit
  nav: number | null;
  navDate: string | null;
  value: number;
  gain: number;
  realisedGain: number;
  incomeIDCW: number; // IDCW payouts received (gross)
  xirr: number | null;
  stUnits: number;
  ltUnits: number;
  lots: Lot[];
  txns: MFTransactionRow[];
  shortfall: number;
}

/** XIRR cash flow of a transaction (paise; out negative). */
export function cashFlowOf(t: MFTransactionRow): number {
  const dir = cashDirection(t.TransactionType);
  if (dir !== 0) return dir * t.TotalAmount;
  switch (t.TransactionType) {
    case 'SWITCH_IN':
    case 'TRANSFER_IN':
      return -(t.Amount + t.StampDuty);
    case 'SWITCH_OUT':
      return t.Amount - t.ExitLoad - t.STT;
    case 'TRANSFER_OUT':
      return t.Amount;
    default:
      return 0; // IDCW reinvest, bonus
  }
}

export function flowsFor(
  txns: MFTransactionRow[],
  currentValue: number,
  today: string,
): CashFlow[] {
  const flows = txns.map((t) => ({ date: t.TransactionDate, amount: cashFlowOf(t) }));
  if (currentValue > 0) flows.push({ date: today, amount: currentValue });
  return flows;
}

export interface PortfolioOptions {
  today?: string;
  includeClosed?: boolean;
}

/** One entry per account + folio + plan, computed from transactions. */
export function computeHoldings(opts: PortfolioOptions = {}): Holding[] {
  const today = opts.today ?? todayLocal();
  const rules = getTaxRules();
  const meta = planMeta();
  const groups = new Map<string, MFTransactionRow[]>();
  for (const t of allMFTransactions()) {
    if (t.TransactionDate > today) continue;
    const key = `${t.InvestmentAccountId}|${t.FolioId ?? 0}|${t.MutualFundPlanId}`;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out: Holding[] = [];
  for (const [key, txns] of groups) {
    const t0 = txns[0];
    const m = meta.get(t0.MutualFundPlanId)!;
    const { lots, realised, shortfall } = runFifo(txns);
    const units = lots.reduce((s, l) => s + l.units, 0);
    if (units === 0 && !opts.includeClosed) continue;
    const invested = lots.reduce((s, l) => s + l.cost, 0);
    const navPt = navOnOrBefore(t0.MutualFundPlanId, today);
    const value = navPt ? valuePaise(units, navPt.NAV) : invested;
    const taxClass = taxClassFor(m, rules);
    let stUnits = 0;
    let ltUnits = 0;
    for (const l of lots) {
      if (classifyTerm(taxClass, l.date, today, rules) === 'LT') ltUnits += l.units;
      else stUnits += l.units;
    }
    out.push({
      key,
      InvestmentAccountId: t0.InvestmentAccountId,
      AccountName: t0.AccountName,
      FolioId: t0.FolioId,
      FolioNo: t0.FolioNo,
      MutualFundPlanId: t0.MutualFundPlanId,
      PersonId: t0.PersonId,
      PersonName: t0.PersonName,
      FundName: m.FundName,
      AMCName: m.AMCName,
      Category: m.Category ?? 'Uncategorised',
      SubCategory: m.SubCategory ?? '—',
      PlanType: m.PlanType,
      OptionType: m.OptionType,
      taxClass,
      units,
      invested,
      avgCost: units > 0 ? Math.round((invested / 100 / (units / 1e6)) * 1e6) : null,
      nav: navPt?.NAV ?? null,
      navDate: navPt?.NAVDate ?? null,
      value,
      gain: value - invested,
      realisedGain: realised.reduce((s, r) => s + r.gain, 0),
      incomeIDCW: txns
        .filter((t) => t.TransactionType === 'IDCW_PAYOUT')
        .reduce((s, t) => s + t.Amount, 0),
      xirr: xirr(flowsFor(txns, value, today)),
      stUnits,
      ltUnits,
      lots,
      txns,
      shortfall,
    });
  }
  return out.sort((a, b) => b.value - a.value);
}

export interface Aggregate {
  key: string;
  label: string;
  invested: number;
  value: number;
  gain: number;
  xirr: number | null;
  count: number;
}

export type GroupBy = 'family' | 'person' | 'category' | 'subCategory' | 'amc' | 'fund';

export function aggregate(holdings: Holding[], by: GroupBy, today = todayLocal()): Aggregate[] {
  const keyOf = (h: Holding): [string, string] => {
    switch (by) {
      case 'family':
        return ['family', 'Family'];
      case 'person':
        return [String(h.PersonId), h.PersonName];
      case 'category':
        return [h.Category, h.Category];
      case 'subCategory':
        return [h.SubCategory, h.SubCategory];
      case 'amc':
        return [h.AMCName, h.AMCName];
      default:
        return [String(h.MutualFundPlanId), h.FundName];
    }
  };
  const map = new Map<string, { label: string; hs: Holding[] }>();
  for (const h of holdings) {
    const [k, label] = keyOf(h);
    const e = map.get(k) ?? { label, hs: [] };
    e.hs.push(h);
    map.set(k, e);
  }
  return [...map.entries()]
    .map(([key, { label, hs }]) => {
      const invested = hs.reduce((s, h) => s + h.invested, 0);
      const value = hs.reduce((s, h) => s + h.value, 0);
      const flows = hs.flatMap((h) => flowsFor(h.txns, 0, today));
      if (value > 0) flows.push({ date: today, amount: value });
      return {
        key,
        label,
        invested,
        value,
        gain: value - invested,
        xirr: xirr(flows),
        count: hs.length,
      };
    })
    .sort((a, b) => b.value - a.value);
}

// ---------------------------------------------------------------- value over time

export interface ValuePoint {
  date: string;
  invested: number;
  value: number;
}

/** Month-end portfolio value from NAV history (falls back to the last known NAV). */
export function valueSeries(
  opts: { personId?: number; months?: number; today?: string } = {},
): ValuePoint[] {
  const today = opts.today ?? todayLocal();
  const txns = allMFTransactions().filter(
    (t) => t.TransactionDate <= today && (!opts.personId || t.PersonId === opts.personId),
  );
  if (!txns.length) return [];
  const planIds = [...new Set(txns.map((t) => t.MutualFundPlanId))];
  const navs = navHistoryByPlan(planIds);
  // Month ends from first transaction (bounded) to today.
  const first = txns[0].TransactionDate;
  const dates: string[] = [];
  const [ty, tm] = today.split('-').map(Number);
  let [y, m] = first.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    dates.push(end > today ? today : end);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  const limited = opts.months ? dates.slice(-opts.months) : dates;
  const navAt = (planId: number, d: string) => {
    const list = navs.get(planId) ?? [];
    let lo = 0;
    let hi = list.length - 1;
    let best: number | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].NAVDate <= d) {
        best = list[mid].NAV;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best;
  };
  const byHolding = new Map<string, MFTransactionRow[]>();
  for (const t of txns) {
    const k = `${t.InvestmentAccountId}|${t.FolioId ?? 0}|${t.MutualFundPlanId}`;
    byHolding.set(k, [...(byHolding.get(k) ?? []), t]);
  }
  return limited.map((d) => {
    let invested = 0;
    let value = 0;
    for (const hs of byHolding.values()) {
      const upto = hs.filter((t) => t.TransactionDate <= d);
      if (!upto.length) continue;
      const { lots } = runFifo(upto);
      const units = lots.reduce((s, l) => s + l.units, 0);
      const cost = lots.reduce((s, l) => s + l.cost, 0);
      invested += cost;
      const nav = navAt(hs[0].MutualFundPlanId, d);
      value += nav ? valuePaise(units, nav) : cost;
    }
    return { date: d, invested, value };
  });
}

// ---------------------------------------------------------------- capital gains

export interface RealisedRow extends Realisation {
  holding: Pick<
    Holding,
    'PersonId' | 'PersonName' | 'FundName' | 'MutualFundPlanId' | 'FolioNo' | 'taxClass'
  >;
}

/** All realised gains (FIFO), classified for tax. */
export function realisedGains(): GainRow[] {
  const rules = getTaxRules();
  const fmv = (planId: number, date: string) => navOnOrBefore(planId, date)?.NAV ?? null;
  return computeHoldings({ includeClosed: true, today: '9999-12-31' }).flatMap((h) => {
    const { realised } = runFifo(h.txns);
    return realised.map((r) =>
      classifyRealisation(
        r,
        {
          planId: h.MutualFundPlanId,
          personId: h.PersonId,
          personName: h.PersonName,
          fundLabel: h.FolioNo ? `${h.FundName} · ${h.FolioNo}` : h.FundName,
          taxClass: h.taxClass,
        },
        rules,
        fmv,
      ),
    );
  });
}

export function capitalGainsForFy(fy: string) {
  const rules = getTaxRules();
  const rows = realisedGains().filter((r) => {
    const [y, m] = r.sellDate.split('-').map(Number);
    const start = m >= 4 ? y : y - 1;
    return `${start}-${String((start + 1) % 100).padStart(2, '0')}` === fy;
  });
  return {
    rows: rows.sort((a, b) => a.sellDate.localeCompare(b.sellDate)),
    summary: summariseFy(rows, fy, rules),
    rules,
  };
}

/** FYs that have at least one redemption / switch-out. */
export function fysWithGains(): string[] {
  const dates = all<{ d: string }>(
    "SELECT DISTINCT TransactionDate AS d FROM MFTransaction WHERE TransactionType IN ('REDEMPTION','SWITCH_OUT')",
  ).map((r) => r.d);
  const fys = new Set(
    dates.map((d) => {
      const [y, m] = d.split('-').map(Number);
      const s = m >= 4 ? y : y - 1;
      return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
    }),
  );
  return [...fys].sort().reverse();
}
