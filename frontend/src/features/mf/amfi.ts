import { parseMicro } from '@/lib/units';
import { parseDate } from '@/lib/dates';

/**
 * Parser for AMFI's public NAVAll.txt:
 *   Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date
 * interleaved with section headers ("Open Ended Schemes(Equity Scheme - Large Cap Fund)") and
 * AMC name lines ("HDFC Mutual Fund").
 */

export type PlanType = 'DIRECT' | 'REGULAR';
export type OptionType = 'GROWTH' | 'IDCW_PAYOUT' | 'IDCW_REINVEST';

export interface AmfiScheme {
  schemeCode: string;
  isin: string | null;
  isinReinvest: string | null;
  schemeName: string;
  nav: number | null; // micro-units
  navDate: string | null; // YYYY-MM-DD
  amc: string;
  fundType: string; // Open Ended / Close Ended / Interval
  category: string; // Equity / Debt / Hybrid / Solution Oriented / Other
  subCategory: string;
  fundName: string;
  planType: PlanType;
  optionType: OptionType;
}

const CATEGORY_MAP: [RegExp, string][] = [
  [/^equity/i, 'Equity'],
  [/^debt/i, 'Debt'],
  [/^hybrid/i, 'Hybrid'],
  [/^solution/i, 'Solution Oriented'],
  [/^other/i, 'Other'],
  [/^(elss|income|growth|money market|gilt|liquid)/i, 'Other'],
];

export function inferPlanType(name: string): PlanType {
  return /\bdirect\b/i.test(name) ? 'DIRECT' : 'REGULAR';
}

export function inferOptionType(name: string): OptionType {
  const n = name.toLowerCase();
  const idcw = /(idcw|dividend|income distribution|\bdiv\b|bonus)/.test(n);
  if (!idcw || (/\bgrowth\b/.test(n) && !/(idcw|dividend)/.test(n))) return 'GROWTH';
  if (/(re-?invest|reinvestment)/.test(n)) return 'IDCW_REINVEST';
  return 'IDCW_PAYOUT';
}

const PLAN_OPTION_WORDS =
  /\b(direct|regular|plan|option|growth|idcw|dividend|payout|pay ?out|re-?investment|re-?invest|income distribution cum capital withdrawal|daily|weekly|fortnightly|monthly|quarterly|half[- ]yearly|annual|yearly|bonus|cumulative)\b/gi;

/** "HDFC Flexi Cap Fund - Direct Plan - Growth Option" → "HDFC Flexi Cap Fund". */
export function cleanFundName(name: string): string {
  const parts = name.split(/\s+-\s+|\s*\(\s*|\s*\)\s*/).filter(Boolean);
  const kept = parts.filter(
    (p) => p.replace(PLAN_OPTION_WORDS, '').replace(/[\s&/,-]+/g, '') !== '',
  );
  const base = (kept.length ? kept : parts)
    .join(' - ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return base.replace(/\s*-\s*$/, '');
}

function parseHeader(
  line: string,
): { fundType: string; category: string; subCategory: string } | null {
  const m = /^(Open Ended|Close Ended|Interval Fund)\s*Schemes?\s*\((.*)\)\s*$/i.exec(line.trim());
  if (!m) return null;
  const inner = m[2];
  const [catRaw, ...rest] = inner.split(/\s+-\s+/);
  const category =
    CATEGORY_MAP.find(([re]) => re.test(catRaw.trim()))?.[1] ??
    catRaw.replace(/\s*Schemes?$/i, '').trim();
  const subCategory = rest
    .join(' - ')
    .replace(/\s+Fund$/i, '')
    .trim();
  const fundType = m[1].replace(/ Fund$/i, '').replace(/\b\w/g, (c) => c.toUpperCase());
  return { fundType, category, subCategory };
}

export function parseAmfiNav(text: string): AmfiScheme[] {
  const out: AmfiScheme[] = [];
  let header = { fundType: '', category: '', subCategory: '' };
  let amc = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('Scheme Code;')) continue;
    if (!line.includes(';')) {
      const h = parseHeader(line);
      if (h) header = h;
      else amc = line;
      continue;
    }
    const cols = line.split(';').map((c) => c.trim());
    if (cols.length < 6 || !/^\d+$/.test(cols[0])) continue;
    const [schemeCode, isin, isinRe, schemeName, navStr, dateStr] = cols;
    const nav = /^[\d.]+$/.test(navStr) ? parseMicro(navStr) : null;
    const validIsin = (s: string) => (/^INF[A-Z0-9]{9}$/i.test(s) ? s.toUpperCase() : null);
    out.push({
      schemeCode,
      isin: validIsin(isin),
      isinReinvest: validIsin(isinRe),
      schemeName,
      nav: nav && nav > 0 ? nav : null,
      navDate: parseDate(dateStr, 'DD-MMM-YYYY'),
      amc,
      ...header,
      fundName: cleanFundName(schemeName),
      planType: inferPlanType(schemeName),
      optionType: inferOptionType(schemeName),
    });
  }
  return out;
}

/** Simple multi-word search: every query word must appear in the scheme name or AMC. */
export function searchSchemes(list: AmfiScheme[], query: string, limit = 30): AmfiScheme[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  if (words.length === 1 && /^\d+$/.test(words[0])) {
    return list.filter((s) => s.schemeCode === words[0]).slice(0, limit);
  }
  if (words.length === 1 && /^inf[a-z0-9]{9}$/.test(words[0])) {
    const isin = words[0].toUpperCase();
    return list.filter((s) => s.isin === isin || s.isinReinvest === isin).slice(0, limit);
  }
  const res: AmfiScheme[] = [];
  for (const s of list) {
    const hay = `${s.schemeName} ${s.amc}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) {
      res.push(s);
      if (res.length >= limit * 4) break;
    }
  }
  // Prefer direct growth plans, then shorter names.
  return res
    .sort(
      (a, b) =>
        Number(b.planType === 'DIRECT') - Number(a.planType === 'DIRECT') ||
        Number(b.optionType === 'GROWTH') - Number(a.optionType === 'GROWTH') ||
        a.schemeName.length - b.schemeName.length,
    )
    .slice(0, limit);
}
