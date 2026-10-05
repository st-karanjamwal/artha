import Decimal from 'decimal.js';
import { financialYear } from '@/lib/dates';
import type { Realisation } from './fifo';

/** Capital-gains classification for MF redemptions. Rules come from settings (MFTaxRules). */

export type TaxClass = 'EQUITY' | 'DEBT' | 'OTHER';
export type Term = 'ST' | 'LT';

interface EquityRegime {
  from: string;
  stcgRate: number;
  ltcgRate: number;
  ltcgExemption: number; // paise per FY
}
interface LtRegime {
  from: string;
  ltAfterMonths: number;
  ltcgRate: number;
}

export interface TaxRules {
  version: number;
  note: string;
  categoryClass: Record<string, TaxClass>;
  subCategoryClass: Record<string, TaxClass>;
  equity: { ltAfterMonths: number; grandfatherDate: string; regimes: EquityRegime[] };
  debt: { alwaysShortTermIfBoughtFrom: string; regimes: LtRegime[] };
  other: { regimes: LtRegime[] };
}

export function validateTaxRules(r: unknown): asserts r is TaxRules {
  const x = r as TaxRules;
  const ok =
    !!x &&
    typeof x === 'object' &&
    !!x.categoryClass &&
    !!x.subCategoryClass &&
    Array.isArray(x.equity?.regimes) &&
    x.equity.regimes.length > 0 &&
    typeof x.equity.ltAfterMonths === 'number' &&
    typeof x.debt?.alwaysShortTermIfBoughtFrom === 'string' &&
    Array.isArray(x.debt?.regimes) &&
    x.debt.regimes.length > 0 &&
    Array.isArray(x.other?.regimes) &&
    x.other.regimes.length > 0;
  if (!ok) throw new Error('Tax rules are missing required fields');
}

export function taxClassFor(
  fund: { TaxClass?: string | null; Category?: string | null; SubCategory?: string | null },
  rules: TaxRules,
): TaxClass {
  if (fund.TaxClass === 'EQUITY' || fund.TaxClass === 'DEBT' || fund.TaxClass === 'OTHER') {
    return fund.TaxClass;
  }
  const sub = (fund.SubCategory ?? '').toLowerCase();
  for (const [k, v] of Object.entries(rules.subCategoryClass)) {
    if (sub && sub.includes(k.toLowerCase())) return v;
  }
  return rules.categoryClass[fund.Category ?? ''] ?? 'OTHER';
}

function regime<T extends { from: string }>(regimes: T[], sellDate: string): T {
  const sorted = [...regimes].sort((a, b) => a.from.localeCompare(b.from));
  return sorted.filter((r) => r.from <= sellDate).pop() ?? sorted[0];
}

export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const total = m - 1 + months;
  const yy = y + Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** Long-term if held MORE than the threshold (sale date after buy date + N months). */
export function classifyTerm(
  cls: TaxClass,
  buyDate: string,
  sellDate: string,
  rules: TaxRules,
): Term {
  if (cls === 'EQUITY') {
    return sellDate > addMonths(buyDate, rules.equity.ltAfterMonths) ? 'LT' : 'ST';
  }
  if (cls === 'DEBT' && buyDate >= rules.debt.alwaysShortTermIfBoughtFrom) return 'ST';
  const r = regime(cls === 'DEBT' ? rules.debt.regimes : rules.other.regimes, sellDate);
  return sellDate > addMonths(buyDate, r.ltAfterMonths) ? 'LT' : 'ST';
}

export interface GainMeta {
  planId: number;
  personId: number;
  personName: string;
  fundLabel: string;
  taxClass: TaxClass;
}

export interface GainRow extends Realisation, GainMeta {
  term: Term;
  /** Cost after grandfathering (equity bought on/before 31-Jan-2018). */
  taxCost: number;
  taxGain: number;
  grandfathered: boolean;
  /** Rate in % for fixed-rate gains; null = taxed at your slab. */
  rate: number | null;
}

/** NAV (micro-units) of a plan on or before a date, if known. */
export type FmvLookup = (planId: number, date: string) => number | null;

export function classifyRealisation(
  r: Realisation,
  meta: GainMeta,
  rules: TaxRules,
  fmv?: FmvLookup,
): GainRow {
  const term = classifyTerm(meta.taxClass, r.buyDate, r.sellDate, rules);
  let taxCost = r.cost;
  let grandfathered = false;
  if (
    meta.taxClass === 'EQUITY' &&
    term === 'LT' &&
    r.buyDate <= rules.equity.grandfatherDate &&
    r.sellDate >= '2018-04-01' &&
    fmv
  ) {
    const nav = fmv(meta.planId, rules.equity.grandfatherDate);
    if (nav) {
      const fmvValue = new Decimal(r.units).times(nav).div(1e10).toDecimalPlaces(0).toNumber();
      const candidate = Math.max(r.cost, Math.min(fmvValue, r.proceeds));
      if (candidate !== r.cost) {
        taxCost = candidate;
        grandfathered = true;
      }
    }
  }
  let rate: number | null = null;
  if (meta.taxClass === 'EQUITY') {
    const reg = regime(rules.equity.regimes, r.sellDate);
    rate = term === 'LT' ? reg.ltcgRate : reg.stcgRate;
  } else if (term === 'LT') {
    rate = regime(
      meta.taxClass === 'DEBT' ? rules.debt.regimes : rules.other.regimes,
      r.sellDate,
    ).ltcgRate;
  }
  return { ...r, ...meta, term, taxCost, taxGain: r.proceeds - taxCost, grandfathered, rate };
}

export interface FySummary {
  fy: string;
  personId: number;
  personName: string;
  equityST: number;
  equityLT: number;
  equityLTExemption: number;
  equityLTTaxable: number;
  otherLT: number; // debt (bought before Apr-2023) + other funds, long term
  slabST: number; // debt/other short term, taxed at your slab
  estimatedFixedRateTax: number; // paise; excludes slab-rate gains, surcharge and cess
}

/** Per-person summary for one FY. The equity LTCG exemption applies once per person per FY. */
export function summariseFy(rows: GainRow[], fy: string, rules: TaxRules): FySummary[] {
  const byPerson = new Map<number, GainRow[]>();
  for (const r of rows.filter((x) => financialYear(x.sellDate) === fy)) {
    byPerson.set(r.personId, [...(byPerson.get(r.personId) ?? []), r]);
  }
  return [...byPerson.entries()].map(([personId, rs]) => {
    const sum = (f: (r: GainRow) => boolean) => rs.filter(f).reduce((s, r) => s + r.taxGain, 0);
    const equityST = sum((r) => r.taxClass === 'EQUITY' && r.term === 'ST');
    const equityLT = sum((r) => r.taxClass === 'EQUITY' && r.term === 'LT');
    const otherLT = sum((r) => r.taxClass !== 'EQUITY' && r.term === 'LT');
    const slabST = sum((r) => r.taxClass !== 'EQUITY' && r.term === 'ST');
    // Exemption from the regime in force at the end of the FY.
    const endReg = regime(rules.equity.regimes, `${Number(fy.slice(0, 4)) + 1}-03-31`);
    const exemption = Math.min(Math.max(equityLT, 0), endReg.ltcgExemption);
    const taxableLT = Math.max(0, equityLT - exemption);
    // Each row at its own regime rate; the exemption reduces equity LT gains pro rata.
    let tax = new Decimal(0);
    for (const r of rs) {
      if (r.rate == null || r.taxGain <= 0) continue;
      let g = new Decimal(r.taxGain);
      if (r.taxClass === 'EQUITY' && r.term === 'LT' && equityLT > 0) {
        g = g.times(taxableLT).div(equityLT);
      }
      tax = tax.plus(g.times(r.rate).div(100));
    }
    return {
      fy,
      personId,
      personName: rs[0].personName,
      equityST,
      equityLT,
      equityLTExemption: exemption,
      equityLTTaxable: taxableLT,
      otherLT,
      slabST,
      estimatedFixedRateTax: Math.max(0, tax.toDecimalPlaces(0).toNumber()),
    };
  });
}
