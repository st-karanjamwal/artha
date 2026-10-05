import Decimal from 'decimal.js';
import { addMonths } from './tax';

export type SipFrequency =
  'DAILY' | 'WEEKLY' | 'FORTNIGHTLY' | 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'YEARLY';

export interface SipLike {
  SIPAmount: number; // paise
  Frequency: SipFrequency;
  SIPDate: number | null;
  StartDate: string;
  EndDate: string | null;
  StepUpPercentBps: number | null;
  StepUpFrequency: 'YEARLY' | 'HALF_YEARLY' | null;
}

/** A paused stretch; `to` null = still paused. Dates inclusive. */
export interface PauseWindow {
  from: string;
  to: string | null;
}

const MONTH_STEP: Partial<Record<SipFrequency, number>> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  HALF_YEARLY: 6,
  YEARLY: 12,
};
const DAY_STEP: Partial<Record<SipFrequency, number>> = { WEEKLY: 7, FORTNIGHTLY: 14 };

/** Instalments per year, for monthly/annual totals. Daily ≈ 250 business days. */
export const PER_YEAR: Record<SipFrequency, number> = {
  DAILY: 250,
  WEEKLY: 52,
  FORTNIGHTLY: 26,
  MONTHLY: 12,
  QUARTERLY: 4,
  HALF_YEARLY: 2,
  YEARLY: 1,
};

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parse = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const addDaysIso = (s: string, n: number) => {
  const d = parse(s);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Day `day` of the month of `ym` (YYYY-MM-..), clamped to the month's last day. */
function clampDay(y: number, m0: number, day: number): string {
  const last = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return `${y}-${pad(m0 + 1)}-${pad(Math.min(day, last))}`;
}

/** Scheduled instalment dates in [from, to] (inclusive), honouring start and end dates. */
export function scheduleDates(sip: SipLike, from: string, to: string): string[] {
  const end = sip.EndDate && sip.EndDate < to ? sip.EndDate : to;
  const out: string[] = [];
  if (end < sip.StartDate) return out;
  const months = MONTH_STEP[sip.Frequency];
  if (months) {
    const day = sip.SIPDate ?? Number(sip.StartDate.slice(8, 10));
    let [y, m0] = [Number(sip.StartDate.slice(0, 4)), Number(sip.StartDate.slice(5, 7)) - 1];
    // First instalment: this month if the SIP day is on/after the start date, else next period.
    if (clampDay(y, m0, day) < sip.StartDate) {
      m0 += months;
    }
    for (let i = 0; i < 2000; i++) {
      y += Math.floor(m0 / 12);
      m0 = ((m0 % 12) + 12) % 12;
      const d = clampDay(y, m0, day);
      if (d > end) break;
      if (d >= from) out.push(d);
      m0 += months;
    }
    return out;
  }
  const step = DAY_STEP[sip.Frequency];
  if (step) {
    for (let d = sip.StartDate; d <= end; d = addDaysIso(d, step)) if (d >= from) out.push(d);
    return out;
  }
  // DAILY: business days (Mon–Fri). Holidays are corrected by the user on confirmation.
  for (let d = sip.StartDate; d <= end; d = addDaysIso(d, 1)) {
    const wd = parse(d).getUTCDay();
    if (wd !== 0 && wd !== 6 && d >= from) out.push(d);
  }
  return out;
}

export const isPaused = (date: string, pauses: PauseWindow[]) =>
  pauses.some((p) => date >= p.from && (p.to == null || date <= p.to));

/** Instalment amount on a date after step-ups (rounded to the rupee). */
export function amountOn(sip: SipLike, date: string): number {
  if (!sip.StepUpPercentBps || !sip.StepUpFrequency) return sip.SIPAmount;
  const every = sip.StepUpFrequency === 'YEARLY' ? 12 : 6;
  let steps = 0;
  while (addMonths(sip.StartDate, every * (steps + 1)) <= date && steps < 100) steps++;
  if (steps === 0) return sip.SIPAmount;
  const factor = new Decimal(1).plus(new Decimal(sip.StepUpPercentBps).div(1_000_000)).pow(steps);
  return new Decimal(sip.SIPAmount).times(factor).div(100).toDecimalPlaces(0).times(100).toNumber();
}

export interface Instalment {
  date: string;
  amount: number;
}

/** Non-paused instalments in [from, to]. */
export function instalments(
  sip: SipLike,
  from: string,
  to: string,
  pauses: PauseWindow[] = [],
): Instalment[] {
  return scheduleDates(sip, from, to)
    .filter((d) => !isPaused(d, pauses))
    .map((date) => ({ date, amount: amountOn(sip, date) }));
}

export function nextInstalment(
  sip: SipLike,
  today: string,
  pauses: PauseWindow[] = [],
): Instalment | null {
  return instalments(sip, today, addDaysIso(today, 800), pauses)[0] ?? null;
}

/**
 * Scheduled dates (≤ today) with no matching transaction. A transaction matches an instalment
 * when it falls within [date − 3, date + 7] days (holidays shift allotment). Each transaction
 * matches at most one instalment.
 */
export function pendingInstalments(
  sip: SipLike,
  today: string,
  txnDates: string[],
  pauses: PauseWindow[] = [],
): Instalment[] {
  const due = instalments(sip, sip.StartDate, today, pauses);
  const unused = [...txnDates].sort();
  const window = sip.Frequency === 'DAILY' ? [0, 3] : [-3, 7];
  return due.filter((inst) => {
    const lo = addDaysIso(inst.date, window[0]);
    const hi = addDaysIso(inst.date, window[1]);
    const i = unused.findIndex((d) => d >= lo && d <= hi);
    if (i >= 0) {
      unused.splice(i, 1);
      return false;
    }
    return true;
  });
}

/** Annual commitment at the current (stepped-up) amount. */
export function annualAmount(sip: SipLike, today: string): number {
  return amountOn(sip, today) * PER_YEAR[sip.Frequency];
}
