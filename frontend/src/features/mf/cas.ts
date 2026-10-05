import { parseDate } from '@/lib/dates';
import { parseMicro } from '@/lib/units';
import { parseStatementAmount } from '@/lib/money';
import type { MFTxnType } from './calc/fifo';

/**
 * Parser for the text of a CAMS / KFintech Consolidated Account Statement (detailed CAS).
 * Works on lines (as extracted from the PDF by pdf.js), e.g.
 *
 *   HDFC Mutual Fund
 *   Folio No: 12345678 / 90 PAN: ABCDE1234F KYC: OK PAN: OK
 *   B123-HDFC Flexi Cap Fund - Direct Plan - Growth Option - ISIN: INF179K01UT0(Advisor: DIRECT) Registrar : CAMS
 *   Opening Unit Balance: 0.000
 *   10-Jan-2026 SIP Purchase - Instalment No 1 9,999.50 6.123 1,633.0000 6.123
 *   10-Jan-2026 *** Stamp Duty *** 0.50
 *   15-Jun-2026 Redemption (4,000.00) (2.100) 1,904.7619 4.023
 *   Closing Unit Balance: 4.023 NAV on 03-Oct-2026: INR 1,950.1234 Total Cost Value: ...
 *
 * Amounts in paise, units/NAV in micro-units. Negative values (parentheses) are made positive;
 * the transaction type carries the direction.
 */

export interface CasTxn {
  date: string;
  description: string;
  type: MFTxnType;
  amount: number;
  units: number;
  nav: number | null;
  balance: number | null;
  stampDuty: number;
  stt: number;
  tds: number;
}

export interface CasScheme {
  amc: string;
  folioNumber: string;
  schemeName: string;
  isin: string | null;
  registrar: string | null;
  openingUnits: number | null;
  closingUnits: number | null;
  closingNav: number | null;
  closingNavDate: string | null;
  transactions: CasTxn[];
}

export interface CasResult {
  periodFrom: string | null;
  periodTo: string | null;
  schemes: CasScheme[];
  warnings: string[];
}

const DATE_RE = /^(\d{2}-[A-Za-z]{3}-\d{4})\s+(.*)$/;
const NUM_RE = /^\(?-?[\d,]*\.?\d+\)?$/;
const isNeg = (tok: string) => tok.startsWith('(') || tok.startsWith('-');
const amt = (tok: string) => Math.abs(parseStatementAmount(tok) ?? 0);
const micro = (tok: string) => Math.abs(parseMicro(tok.replace(/[()]/g, '')) ?? 0);

/** Map a CAS / platform description to a transaction type. `sign` = +1 units added, −1 removed. */
export function classifyDescription(desc: string, sign: number): MFTxnType {
  const d = desc.toLowerCase();
  const neg = sign < 0;
  if (/switch[\s-]*in|switched[\s-]*in|\blateral shift in\b/.test(d)) return 'SWITCH_IN';
  if (/switch[\s-]*out|switched[\s-]*out|\blateral shift out\b/.test(d)) return 'SWITCH_OUT';
  if (/systematic transfer|\bstp\b/.test(d)) return neg ? 'SWITCH_OUT' : 'SWITCH_IN';
  if (/(idcw|dividend|div\.?)\s*.*re-?invest/.test(d)) return 'IDCW_REINVEST';
  if (/(idcw|dividend).*(paid|payout|pay out)|(idcw|dividend) (credit|declared)/.test(d))
    return 'IDCW_PAYOUT';
  if (/\bbonus\b/.test(d)) return 'BONUS';
  if (/transmission|transfer|change of broker|consolidation/.test(d))
    return neg ? 'TRANSFER_OUT' : 'TRANSFER_IN';
  if (/redemption|redeem|\bswp\b|systematic withdrawal|withdrawal/.test(d)) return 'REDEMPTION';
  if (/\bsip\b|systematic investment|instal+ment/.test(d)) return neg ? 'REDEMPTION' : 'SIP';
  if (/purchase|investment|subscription|\bnfo\b|allotment/.test(d))
    return neg ? 'REDEMPTION' : 'PURCHASE';
  return neg ? 'REDEMPTION' : 'PURCHASE';
}

function newScheme(
  amc: string,
  folio: string,
  name: string,
  isin: string | null,
  registrar: string | null,
): CasScheme {
  return {
    amc,
    folioNumber: folio,
    schemeName: name,
    isin,
    registrar,
    openingUnits: null,
    closingUnits: null,
    closingNav: null,
    closingNavDate: null,
    transactions: [],
  };
}

export function parseCasLines(lines: string[]): CasResult {
  const res: CasResult = { periodFrom: null, periodTo: null, schemes: [], warnings: [] };
  let amc = '';
  let folio = '';
  let scheme: CasScheme | null = null;
  let prevText = '';
  const pendingCharges: { date: string; kind: 'stampDuty' | 'stt' | 'tds'; amount: number }[] = [];

  const applyCharge = (date: string, kind: 'stampDuty' | 'stt' | 'tds', amount: number) => {
    const target = scheme?.transactions.filter((t) => t.date === date).pop();
    if (target) target[kind] += amount;
    else pendingCharges.push({ date, kind, amount });
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;

    // Statement period, e.g. "01-Jan-2026 To 04-Oct-2026" (appears before any scheme).
    const period = /^(\d{2}-[A-Za-z]{3}-\d{4})\s+(?:To|to|-)\s+(\d{2}-[A-Za-z]{3}-\d{4})$/.exec(
      line,
    );
    if (period) {
      if (!res.periodFrom) {
        res.periodFrom = parseDate(period[1], 'DD-MMM-YYYY');
        res.periodTo = parseDate(period[2], 'DD-MMM-YYYY');
      }
      continue;
    }

    if (/^[A-Za-z0-9 .&'()-]+ Mutual Fund$/i.test(line) && !/folio/i.test(line)) {
      amc = line;
      continue;
    }

    const folioM = /Folio No\s*[:.]?\s*([A-Za-z0-9/ ]+?)(?=\s+(?:PAN|KYC|UCC|Nominee)\b|$)/i.exec(
      line,
    );
    if (folioM) {
      folio = folioM[1].replace(/\s*\/\s*/g, '/').trim();
      continue;
    }

    const isinM = /ISIN\s*:\s*(INF[A-Z0-9]{9})/i.exec(line);
    if (isinM) {
      let name = line
        .slice(0, isinM.index)
        .replace(/[-\s]+$/, '')
        .trim();
      if (name.length < 5 && prevText) name = `${prevText} ${name}`.trim();
      name = name.replace(/^[A-Z0-9]{2,12}-(?=\S)/, '').trim(); // scheme code prefix "B123-"
      const registrar = /Registrar\s*:\s*(\w+)/i.exec(line)?.[1] ?? null;
      scheme = newScheme(amc, folio, name, isinM[1].toUpperCase(), registrar);
      res.schemes.push(scheme);
      prevText = '';
      continue;
    }

    const openM = /Opening Unit Balance\s*:\s*([\d,]*\.?\d+)/i.exec(line);
    if (openM && scheme) {
      scheme.openingUnits = micro(openM[1]);
      continue;
    }

    const closeM = /Closing Unit Balance\s*:\s*\(?(-?[\d,]*\.?\d+)\)?/i.exec(line);
    if (closeM && scheme) {
      scheme.closingUnits = micro(closeM[1]);
      const navM = /NAV on (\d{2}-[A-Za-z]{3}-\d{4})\s*:\s*(?:INR|Rs\.?)?\s*([\d,]*\.?\d+)/i.exec(
        line,
      );
      if (navM) {
        scheme.closingNavDate = parseDate(navM[1], 'DD-MMM-YYYY');
        scheme.closingNav = micro(navM[2]);
      }
      continue;
    }

    const dm = DATE_RE.exec(line);
    if (dm && scheme) {
      const date = parseDate(dm[1], 'DD-MMM-YYYY');
      if (!date) continue;
      const toks = dm[2].split(' ');
      const nums: string[] = [];
      while (toks.length && NUM_RE.test(toks[toks.length - 1]) && nums.length < 4)
        nums.unshift(toks.pop()!);
      const desc = toks.join(' ').trim();
      const lower = desc.toLowerCase();
      if (/\*\*\*/.test(desc) || /^(stamp duty|stt paid|tds)/i.test(desc)) {
        if (nums.length >= 1) {
          const v = amt(nums[nums.length - 1]);
          if (/stamp/.test(lower)) applyCharge(date, 'stampDuty', v);
          else if (/\bstt\b/.test(lower)) applyCharge(date, 'stt', v);
          else if (/\btds\b/.test(lower)) applyCharge(date, 'tds', v);
        }
        continue; // other *** notes (address change etc.)
      }
      let t: CasTxn;
      if (nums.length === 4) {
        const sign = isNeg(nums[1]) ? -1 : 1;
        t = {
          date,
          description: desc,
          type: classifyDescription(desc, sign),
          amount: amt(nums[0]),
          units: micro(nums[1]),
          nav: micro(nums[2]) || null,
          balance: micro(nums[3]),
          stampDuty: 0,
          stt: 0,
          tds: 0,
        };
      } else if (nums.length === 3) {
        const sign = isNeg(nums[0]) ? -1 : 1;
        t = {
          date,
          description: desc,
          type: classifyDescription(desc, sign),
          amount: 0,
          units: micro(nums[0]),
          nav: micro(nums[1]) || null,
          balance: micro(nums[2]),
          stampDuty: 0,
          stt: 0,
          tds: 0,
        };
      } else if (nums.length === 1 && /(idcw|dividend)/i.test(desc)) {
        t = {
          date,
          description: desc,
          type: 'IDCW_PAYOUT',
          amount: amt(nums[0]),
          units: 0,
          nav: null,
          balance: null,
          stampDuty: 0,
          stt: 0,
          tds: 0,
        };
      } else {
        res.warnings.push(`Skipped line (unrecognised): ${line}`);
        continue;
      }
      // IDCW reinvest/payout detection overrides when units are 0
      if (t.units === 0 && t.type !== 'IDCW_PAYOUT') t.type = 'IDCW_PAYOUT';
      scheme.transactions.push(t);
      for (let i = pendingCharges.length - 1; i >= 0; i--) {
        if (pendingCharges[i].date === date) {
          t[pendingCharges[i].kind] += pendingCharges[i].amount;
          pendingCharges.splice(i, 1);
        }
      }
      continue;
    }

    prevText = line;
  }

  for (const s of res.schemes) {
    if (!s.folioNumber) res.warnings.push(`No folio number found for ${s.schemeName}`);
    if (s.closingUnits == null) res.warnings.push(`No closing balance found for ${s.schemeName}`);
  }
  return res;
}
