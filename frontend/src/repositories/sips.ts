import { all, one, run, tx } from '@/db/sql';
import { nowUtc, todayLocal } from '@/lib/dates';
import { stampDuty, unitsFromAmount } from '@/lib/units';
import { blankToNull } from '@/lib/validators';
import {
  addDaysIso,
  annualAmount,
  amountOn,
  nextInstalment,
  pendingInstalments,
  type Instalment,
  type PauseWindow,
  type SipFrequency,
  type SipLike,
} from '@/features/mf/calc/sipSchedule';
import { createMFTransaction } from './mfTransactions';
import { navOn } from './mfNav';
import { createTransaction } from './transactions';

export type SipStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'COMPLETED';

export const FREQUENCY_LABEL: Record<SipFrequency, string> = {
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  FORTNIGHTLY: 'Fortnightly',
  MONTHLY: 'Monthly',
  QUARTERLY: 'Quarterly',
  HALF_YEARLY: 'Half-yearly',
  YEARLY: 'Yearly',
};

export interface SIP extends SipLike {
  SIPId: number;
  MutualFundPlanId: number;
  InvestmentAccountId: number;
  FolioId: number | null;
  AutoDebit: number;
  MandateReference: string | null;
  DebitBankAccountId: number | null;
  Status: SipStatus;
  PausedUntil: string | null;
  Notes: string | null;
}

export interface SIPRow extends SIP {
  FundName: string;
  AMCName: string;
  PlanType: 'DIRECT' | 'REGULAR';
  OptionType: 'GROWTH' | 'IDCW_PAYOUT' | 'IDCW_REINVEST';
  AccountName: string;
  PersonId: number;
  PersonName: string;
  FolioNumber: string | null;
  InstalmentCount: number;
  InvestedTotal: number;
}

const ROW_SQL = `
SELECT s.*, f.FundName, f.AMCName, p.PlanType, p.OptionType, ia.AccountName, ia.PersonId,
       TRIM(pe.FirstName || ' ' || COALESCE(pe.LastName, '')) AS PersonName, fo.FolioNumber,
       (SELECT COUNT(*) FROM MFTransaction t WHERE t.SIPId = s.SIPId) AS InstalmentCount,
       (SELECT COALESCE(SUM(t.TotalAmount), 0) FROM MFTransaction t WHERE t.SIPId = s.SIPId) AS InvestedTotal
FROM SIP s
JOIN MutualFundPlan p ON p.MutualFundPlanId = s.MutualFundPlanId
JOIN MutualFund f ON f.MutualFundId = p.MutualFundId
JOIN InvestmentAccount ia ON ia.InvestmentAccountId = s.InvestmentAccountId
JOIN Persons pe ON pe.PersonId = ia.PersonId
LEFT JOIN MFFolio fo ON fo.FolioId = s.FolioId`;

export function listSips(
  opts: { status?: SipStatus[]; personId?: number; planId?: number } = {},
): SIPRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status?.length) {
    where.push(`s.Status IN (${opts.status.map(() => '?').join(',')})`);
    params.push(...opts.status);
  }
  if (opts.personId) {
    where.push('ia.PersonId = ?');
    params.push(opts.personId);
  }
  if (opts.planId) {
    where.push('s.MutualFundPlanId = ?');
    params.push(opts.planId);
  }
  return all<SIPRow>(
    `${ROW_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE s.Status WHEN 'ACTIVE' THEN 1 WHEN 'PAUSED' THEN 2 ELSE 3 END, pe.PersonId, f.FundName`,
    params,
  );
}

export function getSip(id: number): SIPRow | undefined {
  return one<SIPRow>(`${ROW_SQL} WHERE s.SIPId = ?`, [id]);
}

function log(sipId: number, action: string, details?: unknown) {
  run('INSERT INTO SIPHistory (SIPId, Action, Details) VALUES (?, ?, ?)', [
    sipId,
    action,
    details === undefined ? null : JSON.stringify(details),
  ]);
}

export interface SIPHistoryRow {
  SIPHistoryId: number;
  ChangedOn: string;
  Action: string;
  Details: string | null;
}

export function sipHistory(sipId: number): SIPHistoryRow[] {
  return all<SIPHistoryRow>(
    'SELECT * FROM SIPHistory WHERE SIPId = ? ORDER BY ChangedOn DESC, SIPHistoryId DESC',
    [sipId],
  );
}

export interface SIPInput {
  MutualFundPlanId: number;
  InvestmentAccountId: number;
  FolioId?: number | null;
  SIPAmount: number;
  Frequency: SipFrequency;
  SIPDate?: number | null;
  StartDate: string;
  EndDate?: string | null;
  StepUpPercentBps?: number | null;
  StepUpFrequency?: 'YEARLY' | 'HALF_YEARLY' | null;
  AutoDebit?: boolean;
  MandateReference?: string;
  DebitBankAccountId?: number | null;
  Notes?: string;
}

function validate(s: SIPInput) {
  if (!(s.SIPAmount > 0)) throw new Error('SIP amount must be greater than zero');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.StartDate)) throw new Error('Start date is required');
  if (s.EndDate && s.EndDate < s.StartDate) throw new Error('End date is before the start date');
  if (s.SIPDate != null && (s.SIPDate < 1 || s.SIPDate > 31))
    throw new Error('SIP day must be 1–31');
  if (s.StepUpPercentBps && !s.StepUpFrequency)
    throw new Error('Choose how often the step-up applies');
}

const MONTHLY_PLUS = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'YEARLY'];

function sipValues(s: SIPInput) {
  return [
    s.MutualFundPlanId,
    s.InvestmentAccountId,
    s.FolioId ?? null,
    s.SIPAmount,
    s.Frequency,
    MONTHLY_PLUS.includes(s.Frequency) ? (s.SIPDate ?? Number(s.StartDate.slice(8, 10))) : null,
    s.StartDate,
    blankToNull(s.EndDate ?? ''),
    s.StepUpPercentBps || null,
    s.StepUpPercentBps ? (s.StepUpFrequency ?? 'YEARLY') : null,
    s.AutoDebit === false ? 0 : 1,
    blankToNull(s.MandateReference),
    s.DebitBankAccountId ?? null,
    blankToNull(s.Notes),
  ];
}

const SIP_COLS =
  'MutualFundPlanId, InvestmentAccountId, FolioId, SIPAmount, Frequency, SIPDate, StartDate, EndDate, StepUpPercentBps, StepUpFrequency, AutoDebit, MandateReference, DebitBankAccountId, Notes';

export function createSip(s: SIPInput): number {
  validate(s);
  return tx(() => {
    const id = run(
      `INSERT INTO SIP (${SIP_COLS}) VALUES (${SIP_COLS.split(',')
        .map(() => '?')
        .join(', ')})`,
      sipValues(s),
    ).lastId;
    log(id, 'CREATED', { amount: s.SIPAmount, frequency: s.Frequency, start: s.StartDate });
    return id;
  });
}

export function updateSip(id: number, s: SIPInput) {
  validate(s);
  const old = getSip(id);
  if (!old) throw new Error('SIP not found');
  tx(() => {
    run(
      `UPDATE SIP SET ${SIP_COLS.split(', ')
        .map((c) => `${c} = ?`)
        .join(', ')}, UpdatedOn = ? WHERE SIPId = ?`,
      [...sipValues(s), nowUtc(), id],
    );
    if (old.SIPAmount !== s.SIPAmount)
      log(id, 'AMOUNT_CHANGED', { from: old.SIPAmount, to: s.SIPAmount });
    else log(id, 'EDITED');
  });
}

function setStatus(
  id: number,
  status: SipStatus,
  extra: Partial<Pick<SIP, 'PausedUntil' | 'EndDate'>> = {},
) {
  run(
    `UPDATE SIP SET Status = ?, PausedUntil = ?, EndDate = COALESCE(?, EndDate), UpdatedOn = ? WHERE SIPId = ?`,
    [status, extra.PausedUntil ?? null, extra.EndDate ?? null, nowUtc(), id],
  );
}

/** Pause from `from` (default today) until `until` (inclusive) or indefinitely. */
export function pauseSip(id: number, until: string | null, from = todayLocal()) {
  tx(() => {
    setStatus(id, 'PAUSED', { PausedUntil: until });
    log(id, 'PAUSED', { from, until });
  });
}

export function resumeSip(id: number, on = todayLocal()) {
  tx(() => {
    setStatus(id, 'ACTIVE');
    log(id, 'RESUMED', { on });
  });
}

/** Stop: no instalments after `on`. */
export function stopSip(id: number, on = todayLocal()) {
  tx(() => {
    setStatus(id, 'STOPPED', { EndDate: on });
    log(id, 'STOPPED', { on });
  });
}

export function deleteSip(id: number) {
  if (one('SELECT 1 FROM MFTransaction WHERE SIPId = ?', [id])) {
    throw new Error('This SIP has instalments; stop it instead of deleting');
  }
  run('DELETE FROM SIP WHERE SIPId = ?', [id]);
}

/** Pause windows reconstructed from the history log (plus a current pause). */
export function pauseWindows(sipId: number): PauseWindow[] {
  const events = all<{ Action: string; Details: string | null }>(
    "SELECT Action, Details FROM SIPHistory WHERE SIPId = ? AND Action IN ('PAUSED','RESUMED') ORDER BY ChangedOn, SIPHistoryId",
    [sipId],
  );
  const out: PauseWindow[] = [];
  let open: PauseWindow | null = null;
  for (const e of events) {
    const d = e.Details ? JSON.parse(e.Details) : {};
    if (e.Action === 'PAUSED') {
      open = { from: d.from, to: d.until ?? null };
      out.push(open);
    } else if (open) {
      const resumedOn = addDaysIso(d.on, -1);
      if (open.to == null || open.to > resumedOn) open.to = resumedOn;
      open = null;
    }
  }
  return out;
}

export function nextSipDate(sip: SIP, today = todayLocal()): Instalment | null {
  if (sip.Status === 'STOPPED' || sip.Status === 'COMPLETED') return null;
  return nextInstalment(sip, today, pauseWindows(sip.SIPId));
}

export interface PendingInstalment extends Instalment {
  sip: SIPRow;
  nav: number | null; // NAV of that date, if known
}

/** Instalments that are due but have no matching SIP transaction (max 24 per SIP). */
export function pendingSipConfirmations(today = todayLocal()): PendingInstalment[] {
  const out: PendingInstalment[] = [];
  for (const sip of listSips({ status: ['ACTIVE', 'PAUSED', 'STOPPED'] })) {
    const txnDates = all<{ TransactionDate: string }>(
      'SELECT TransactionDate FROM MFTransaction WHERE SIPId = ?',
      [sip.SIPId],
    ).map((r) => r.TransactionDate);
    const pend = pendingInstalments(sip, today, txnDates, pauseWindows(sip.SIPId)).slice(-24);
    for (const p of pend)
      out.push({ ...p, sip, nav: navOn(sip.MutualFundPlanId, p.date)?.NAV ?? null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export interface ConfirmInput {
  sipId: number;
  date: string; // allotment date (may differ from scheduled date)
  amount: number; // gross paise debited
  nav: number; // micro
  units?: number; // override to match the statement
  stampDuty?: number;
  folioId?: number | null;
  createBankDebit?: boolean;
  reference?: string;
}

/** Record a SIP instalment (Source = SIP_AUTO), optionally with the bank debit in Phase 1. */
export function confirmSipInstalment(c: ConfirmInput): number {
  const sip = getSip(c.sipId);
  if (!sip) throw new Error('SIP not found');
  const stamp = c.stampDuty ?? stampDuty(c.amount);
  const net = c.amount - stamp;
  const units = c.units ?? unitsFromAmount(net, c.nav);
  return tx(() => {
    let bankTxnId: number | null = null;
    const bankAccount = sip.DebitBankAccountId;
    if (c.createBankDebit && bankAccount) {
      bankTxnId = createTransaction({
        AccountId: bankAccount,
        TxnDate: c.date,
        Description: `SIP · ${sip.FundName}`,
        Amount: c.amount,
        Direction: 'Debit',
        Mode: 'ECS_NACH',
        ReferenceNo: sip.MandateReference ?? undefined,
        CategoryId:
          one<{ CategoryId: number }>(
            "SELECT CategoryId FROM Categories WHERE Name = 'Mutual Fund / SIP' LIMIT 1",
          )?.CategoryId ?? null,
      });
    }
    const id = createMFTransaction({
      MutualFundPlanId: sip.MutualFundPlanId,
      InvestmentAccountId: sip.InvestmentAccountId,
      FolioId: c.folioId !== undefined ? c.folioId : sip.FolioId,
      SIPId: sip.SIPId,
      TransactionDate: c.date,
      TransactionType: 'SIP',
      NAV: c.nav,
      Units: units,
      Amount: net,
      StampDuty: stamp,
      Source: 'SIP_AUTO',
      BankTransactionId: bankTxnId,
      TransactionReference: c.reference,
    });
    // Remember the folio on the SIP after its first allotment.
    if (!sip.FolioId && c.folioId)
      run('UPDATE SIP SET FolioId = ? WHERE SIPId = ?', [c.folioId, sip.SIPId]);
    if (bankTxnId) {
      run(
        "UPDATE Transactions SET LinkedEntity = 'MFTransaction', LinkedEntityId = ? WHERE TransactionId = ?",
        [id, bankTxnId],
      );
    }
    return id;
  });
}

export interface SipTotals {
  monthly: number;
  annual: number;
  count: number;
  byPerson: {
    PersonId: number;
    PersonName: string;
    monthly: number;
    annual: number;
    count: number;
  }[];
}

/** Monthly and annual SIP commitment of ACTIVE SIPs at today's stepped-up amounts. */
export function sipTotals(today = todayLocal()): SipTotals {
  const sips = listSips({ status: ['ACTIVE'] }).filter((s) => !s.EndDate || s.EndDate >= today);
  const map = new Map<number, SipTotals['byPerson'][number]>();
  let annual = 0;
  for (const s of sips) {
    const a = annualAmount(s, today);
    annual += a;
    const e = map.get(s.PersonId) ?? {
      PersonId: s.PersonId,
      PersonName: s.PersonName,
      monthly: 0,
      annual: 0,
      count: 0,
    };
    e.annual += a;
    e.monthly = Math.round(e.annual / 12);
    e.count++;
    map.set(s.PersonId, e);
  }
  return {
    monthly: Math.round(annual / 12),
    annual,
    count: sips.length,
    byPerson: [...map.values()],
  };
}

export const currentSipAmount = (s: SIP, today = todayLocal()) => amountOn(s, today);

/** Paused SIPs whose PausedUntil has passed become ACTIVE again (run on unlock). */
export function autoResumeExpiredPauses(today = todayLocal()): number {
  const expired = all<{ SIPId: number; PausedUntil: string }>(
    "SELECT SIPId, PausedUntil FROM SIP WHERE Status = 'PAUSED' AND PausedUntil IS NOT NULL AND PausedUntil < ?",
    [today],
  );
  if (expired.length) {
    tx(() => {
      for (const s of expired) resumeSip(s.SIPId, addDaysIso(s.PausedUntil, 1));
    });
  }
  return expired.length;
}
