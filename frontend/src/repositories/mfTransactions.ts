import { all, one, run, tx, type Params } from '@/db/sql';
import { nowUtc } from '@/lib/dates';
import { formatUnits } from '@/lib/units';
import { blankToNull } from '@/lib/validators';
import {
  ADD_TYPES,
  REDUCE_TYPES,
  runFifo,
  unitDelta,
  type FifoTxn,
  type MFTxnType,
} from '@/features/mf/calc/fifo';
import { addDaysIso } from '@/features/mf/calc/sipSchedule';
import { upsertNav } from './mfNav';
import { createTransaction as createBankTransaction } from './transactions';

export type MFSource = 'MANUAL' | 'CAS_IMPORT' | 'CSV_IMPORT' | 'SIP_AUTO';

export const TXN_TYPE_LABEL: Record<MFTxnType, string> = {
  PURCHASE: 'Purchase',
  SIP: 'SIP instalment',
  REDEMPTION: 'Redemption',
  SWITCH_IN: 'Switch in',
  SWITCH_OUT: 'Switch out',
  IDCW_PAYOUT: 'IDCW payout',
  IDCW_REINVEST: 'IDCW reinvest',
  BONUS: 'Bonus',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
};

export interface MFTransaction {
  TransactionId: number;
  MutualFundPlanId: number;
  InvestmentAccountId: number;
  FolioId: number | null;
  SIPId: number | null;
  TransactionDate: string;
  TransactionType: MFTxnType;
  NAV: number | null;
  Units: number;
  Amount: number;
  STT: number;
  StampDuty: number;
  ExitLoad: number;
  TDS: number;
  OtherCharges: number;
  TotalAmount: number;
  SwitchGroupId: string | null;
  FolioNumber: string | null;
  TransactionReference: string | null;
  BankTransactionId: number | null;
  Source: MFSource;
  ImportBatchId: number | null;
  Remarks: string | null;
}

export interface MFTransactionInput {
  MutualFundPlanId: number;
  InvestmentAccountId: number;
  FolioId?: number | null;
  SIPId?: number | null;
  TransactionDate: string;
  TransactionType: MFTxnType;
  NAV?: number | null;
  Units: number;
  Amount: number;
  STT?: number;
  StampDuty?: number;
  ExitLoad?: number;
  TDS?: number;
  OtherCharges?: number;
  SwitchGroupId?: string | null;
  FolioNumber?: string | null;
  TransactionReference?: string | null;
  BankTransactionId?: number | null;
  Source?: MFSource;
  ImportBatchId?: number | null;
  Remarks?: string | null;
}

/** Cash that left (purchase) or entered (redemption, payout) the bank, per spec §5. Always ≥ 0. */
export function computeTotalAmount(t: {
  TransactionType: MFTxnType;
  Amount: number;
  STT?: number;
  StampDuty?: number;
  ExitLoad?: number;
  TDS?: number;
  OtherCharges?: number;
}): number {
  const [stt, stamp, load, tds, other] = [
    t.STT ?? 0,
    t.StampDuty ?? 0,
    t.ExitLoad ?? 0,
    t.TDS ?? 0,
    t.OtherCharges ?? 0,
  ];
  switch (t.TransactionType) {
    case 'PURCHASE':
    case 'SIP':
      return t.Amount + stamp + other;
    case 'REDEMPTION':
      return Math.max(0, t.Amount - stt - load - tds - other);
    case 'IDCW_PAYOUT':
      return Math.max(0, t.Amount - tds);
    default:
      return 0; // switches, reinvest, bonus, transfers: no bank flow
  }
}

/** Bank cash-flow direction for XIRR and bank linking: −1 out, +1 in, 0 none. */
export function cashDirection(type: MFTxnType): -1 | 0 | 1 {
  if (type === 'PURCHASE' || type === 'SIP') return -1;
  if (type === 'REDEMPTION' || type === 'IDCW_PAYOUT') return 1;
  return 0;
}

const holdingKey = (t: {
  InvestmentAccountId: number;
  FolioId?: number | null;
  MutualFundPlanId: number;
}) => [t.InvestmentAccountId, t.FolioId ?? null, t.MutualFundPlanId];

/** All transactions of one holding (account + folio + plan). */
export function holdingTxns(
  accountId: number,
  folioId: number | null,
  planId: number,
  exceptId = 0,
): MFTransaction[] {
  return all<MFTransaction>(
    `SELECT * FROM MFTransaction
     WHERE InvestmentAccountId = ? AND COALESCE(FolioId, 0) = COALESCE(?, 0) AND MutualFundPlanId = ?
       AND TransactionId <> ?
     ORDER BY TransactionDate, TransactionId`,
    [accountId, folioId, planId, exceptId],
  );
}

export function unitsHeld(
  accountId: number,
  folioId: number | null,
  planId: number,
  onDate = '9999-12-31',
): number {
  return holdingTxns(accountId, folioId, planId)
    .filter((t) => t.TransactionDate <= onDate)
    .reduce((s, t) => s + unitDelta(t), 0);
}

/**
 * Throws if, after applying `candidate` (and removing `exceptId`), the units held in the holding
 * would go negative on any date. This enforces "cannot redeem more than held on that date" and
 * also protects later redemptions when an earlier purchase is edited or deleted.
 */
function assertNoNegativeUnits(
  key: { InvestmentAccountId: number; FolioId?: number | null; MutualFundPlanId: number },
  candidate: Pick<MFTransaction, 'TransactionDate' | 'TransactionType' | 'Units'> | null,
  exceptId = 0,
) {
  const [acc, folio, plan] = holdingKey(key) as [number, number | null, number];
  const rows: Pick<
    MFTransaction,
    'TransactionDate' | 'TransactionType' | 'Units' | 'TransactionId'
  >[] = holdingTxns(acc, folio, plan, exceptId);
  if (candidate) rows.push({ ...candidate, TransactionId: Number.MAX_SAFE_INTEGER });
  rows.sort(
    (a, b) =>
      a.TransactionDate.localeCompare(b.TransactionDate) ||
      Number(REDUCE_TYPES.includes(a.TransactionType)) -
        Number(REDUCE_TYPES.includes(b.TransactionType)) ||
      a.TransactionId - b.TransactionId,
  );
  let held = 0;
  for (const r of rows) {
    held += unitDelta(r);
    if (held < 0) {
      throw new Error(
        `Not enough units: on ${r.TransactionDate} this would leave ${formatUnits(held)} units in this folio`,
      );
    }
  }
}

function validate(t: MFTransactionInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.TransactionDate))
    throw new Error('Transaction date is required');
  if (t.TransactionType === 'IDCW_PAYOUT') {
    if (t.Units !== 0) throw new Error('An IDCW payout does not change units');
    if (t.Amount <= 0) throw new Error('Enter the IDCW amount');
    return;
  }
  if (!t.NAV || t.NAV <= 0) throw new Error('NAV is required');
  if (!(t.Units > 0)) throw new Error('Units must be greater than zero');
  if (t.TransactionType !== 'BONUS' && t.TransactionType !== 'TRANSFER_OUT' && t.Amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }
  for (const k of ['STT', 'StampDuty', 'ExitLoad', 'TDS', 'OtherCharges'] as const) {
    if ((t[k] ?? 0) < 0) throw new Error(`${k} cannot be negative`);
  }
}

const COLS = [
  'MutualFundPlanId',
  'InvestmentAccountId',
  'FolioId',
  'SIPId',
  'TransactionDate',
  'TransactionType',
  'NAV',
  'Units',
  'Amount',
  'STT',
  'StampDuty',
  'ExitLoad',
  'TDS',
  'OtherCharges',
  'TotalAmount',
  'SwitchGroupId',
  'FolioNumber',
  'TransactionReference',
  'BankTransactionId',
  'Source',
  'ImportBatchId',
  'Remarks',
] as const;

function values(t: MFTransactionInput): Params {
  const total = computeTotalAmount(t);
  const row: Record<(typeof COLS)[number], unknown> = {
    MutualFundPlanId: t.MutualFundPlanId,
    InvestmentAccountId: t.InvestmentAccountId,
    FolioId: t.FolioId ?? null,
    SIPId: t.SIPId ?? null,
    TransactionDate: t.TransactionDate,
    TransactionType: t.TransactionType,
    NAV: t.TransactionType === 'IDCW_PAYOUT' ? (t.NAV ?? null) : t.NAV,
    Units: t.Units,
    Amount: t.Amount,
    STT: t.STT ?? 0,
    StampDuty: t.StampDuty ?? 0,
    ExitLoad: t.ExitLoad ?? 0,
    TDS: t.TDS ?? 0,
    OtherCharges: t.OtherCharges ?? 0,
    TotalAmount: total,
    SwitchGroupId: t.SwitchGroupId ?? null,
    FolioNumber: blankToNull(t.FolioNumber ?? ''),
    TransactionReference: blankToNull(t.TransactionReference ?? ''),
    BankTransactionId: t.BankTransactionId ?? null,
    Source: t.Source ?? 'MANUAL',
    ImportBatchId: t.ImportBatchId ?? null,
    Remarks: blankToNull(t.Remarks ?? ''),
  };
  return COLS.map((c) => row[c] as Params[number]);
}

/** Insert without the units check (used by imports, which validate the whole batch). */
export function insertMFTransactionRaw(t: MFTransactionInput): number {
  validate(t);
  const id = run(
    `INSERT INTO MFTransaction (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`,
    values(t),
  ).lastId;
  if (t.NAV) upsertNav(t.MutualFundPlanId, t.TransactionDate, t.NAV, 'TRANSACTION');
  return id;
}

export function createMFTransaction(t: MFTransactionInput): number {
  validate(t);
  return tx(() => {
    if (REDUCE_TYPES.includes(t.TransactionType)) assertNoNegativeUnits(t, t);
    return insertMFTransactionRaw(t);
  });
}

export function getMFTransaction(id: number): MFTransaction | undefined {
  return one<MFTransaction>('SELECT * FROM MFTransaction WHERE TransactionId = ?', [id]);
}

export function updateMFTransaction(id: number, t: MFTransactionInput) {
  validate(t);
  const old = getMFTransaction(id);
  if (!old) throw new Error('Transaction not found');
  tx(() => {
    // Check the new holding with the new row, and the old holding without the old row.
    assertNoNegativeUnits(t, t, id);
    if (
      old.InvestmentAccountId !== t.InvestmentAccountId ||
      old.FolioId !== (t.FolioId ?? null) ||
      old.MutualFundPlanId !== t.MutualFundPlanId
    ) {
      assertNoNegativeUnits(old, null, id);
    }
    run(
      `UPDATE MFTransaction SET ${COLS.map((c) => `${c} = ?`).join(', ')}, UpdatedOn = ? WHERE TransactionId = ?`,
      [
        ...values({
          ...t,
          Source: t.Source ?? old.Source,
          ImportBatchId: t.ImportBatchId ?? old.ImportBatchId,
          SwitchGroupId: t.SwitchGroupId ?? old.SwitchGroupId,
        }),
        nowUtc(),
        id,
      ],
    );
    if (t.NAV) upsertNav(t.MutualFundPlanId, t.TransactionDate, t.NAV, 'TRANSACTION');
  });
}

/** Delete a transaction (both legs for a switch). Refuses if later redemptions would break. */
export function deleteMFTransaction(id: number) {
  const t = getMFTransaction(id);
  if (!t) return;
  const legs = t.SwitchGroupId
    ? all<MFTransaction>('SELECT * FROM MFTransaction WHERE SwitchGroupId = ?', [t.SwitchGroupId])
    : [t];
  tx(() => {
    for (const leg of legs) {
      if (ADD_TYPES.includes(leg.TransactionType))
        assertNoNegativeUnits(leg, null, leg.TransactionId);
    }
    for (const leg of legs)
      run('DELETE FROM MFTransaction WHERE TransactionId = ?', [leg.TransactionId]);
  });
}

// ---------------------------------------------------------------- switch

export interface SwitchInput {
  InvestmentAccountId: number;
  TransactionDate: string;
  FromPlanId: number;
  FromFolioId: number | null;
  OutUnits: number;
  OutNAV: number;
  OutAmount: number;
  ExitLoad?: number;
  STT?: number;
  ToPlanId: number;
  ToFolioId: number | null;
  InUnits: number;
  InNAV: number;
  InAmount: number;
  StampDuty?: number;
  InDate?: string; // switch-in allotment can be a day later
  Remarks?: string;
}

/** Creates both legs, linked by a SwitchGroupId. */
export function createSwitch(s: SwitchInput): string {
  if (s.FromPlanId === s.ToPlanId && (s.FromFolioId ?? 0) === (s.ToFolioId ?? 0)) {
    throw new Error('Choose a different target plan');
  }
  const group = crypto.randomUUID();
  tx(() => {
    createMFTransaction({
      MutualFundPlanId: s.FromPlanId,
      InvestmentAccountId: s.InvestmentAccountId,
      FolioId: s.FromFolioId,
      TransactionDate: s.TransactionDate,
      TransactionType: 'SWITCH_OUT',
      NAV: s.OutNAV,
      Units: s.OutUnits,
      Amount: s.OutAmount,
      ExitLoad: s.ExitLoad,
      STT: s.STT,
      SwitchGroupId: group,
      Remarks: s.Remarks,
    });
    createMFTransaction({
      MutualFundPlanId: s.ToPlanId,
      InvestmentAccountId: s.InvestmentAccountId,
      FolioId: s.ToFolioId,
      TransactionDate: s.InDate ?? s.TransactionDate,
      TransactionType: 'SWITCH_IN',
      NAV: s.InNAV,
      Units: s.InUnits,
      Amount: s.InAmount,
      StampDuty: s.StampDuty,
      SwitchGroupId: group,
      Remarks: s.Remarks,
    });
  });
  return group;
}

// ---------------------------------------------------------------- listing

export interface MFTransactionRow extends MFTransaction {
  FundName: string;
  AMCName: string;
  PlanType: 'DIRECT' | 'REGULAR';
  OptionType: 'GROWTH' | 'IDCW_PAYOUT' | 'IDCW_REINVEST';
  AccountName: string;
  PersonId: number;
  PersonName: string;
  FolioNo: string | null;
}

export interface MFTxnFilter {
  personId?: number;
  planId?: number;
  accountId?: number;
  folioId?: number;
  type?: MFTxnType;
  from?: string;
  to?: string;
  sipId?: number;
  limit?: number;
}

const ROW_SQL = `
SELECT t.*, f.FundName, f.AMCName, p.PlanType, p.OptionType, ia.AccountName, ia.PersonId,
       TRIM(pe.FirstName || ' ' || COALESCE(pe.LastName, '')) AS PersonName, fo.FolioNumber AS FolioNo
FROM MFTransaction t
JOIN MutualFundPlan p ON p.MutualFundPlanId = t.MutualFundPlanId
JOIN MutualFund f ON f.MutualFundId = p.MutualFundId
JOIN InvestmentAccount ia ON ia.InvestmentAccountId = t.InvestmentAccountId
JOIN Persons pe ON pe.PersonId = ia.PersonId
LEFT JOIN MFFolio fo ON fo.FolioId = t.FolioId`;

export function listMFTransactions(f: MFTxnFilter = {}): MFTransactionRow[] {
  const where: string[] = [];
  const params: Params = [];
  const add = (sql: string, v: unknown) => {
    where.push(sql);
    params.push(v as Params[number]);
  };
  if (f.personId) add('ia.PersonId = ?', f.personId);
  if (f.planId) add('t.MutualFundPlanId = ?', f.planId);
  if (f.accountId) add('t.InvestmentAccountId = ?', f.accountId);
  if (f.folioId) add('t.FolioId = ?', f.folioId);
  if (f.type) add('t.TransactionType = ?', f.type);
  if (f.from) add('t.TransactionDate >= ?', f.from);
  if (f.to) add('t.TransactionDate <= ?', f.to);
  if (f.sipId) add('t.SIPId = ?', f.sipId);
  params.push(f.limit ?? 2000);
  return all<MFTransactionRow>(
    `${ROW_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.TransactionDate DESC, t.TransactionId DESC LIMIT ?`,
    params,
  );
}

/** Every transaction (oldest first) — input for portfolio calculations. */
export function allMFTransactions(): MFTransactionRow[] {
  return all<MFTransactionRow>(`${ROW_SQL} ORDER BY t.TransactionDate, t.TransactionId`);
}

// ---------------------------------------------------------------- exit load

/**
 * Warning text if redeeming `units` on `date` would consume lots still inside the plan's
 * exit-load period, with the estimated load.
 */
export function exitLoadWarning(
  accountId: number,
  folioId: number | null,
  planId: number,
  date: string,
  units: number,
  amountPaise: number,
): string | null {
  const plan = one<{
    ExitLoadDays: number | null;
    ExitLoadPercentBps: number | null;
    ExitLoad: string | null;
  }>(
    'SELECT ExitLoadDays, ExitLoadPercentBps, ExitLoad FROM MutualFundPlan WHERE MutualFundPlanId = ?',
    [planId],
  );
  if (!plan?.ExitLoadDays || units <= 0) return null;
  const txns: FifoTxn[] = holdingTxns(accountId, folioId, planId).filter(
    (t) => t.TransactionDate <= date,
  );
  const { lots } = runFifo(txns);
  let remaining = units;
  let inLoad = 0;
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.units, remaining);
    if (addDaysIso(lot.date, plan.ExitLoadDays) > date) inLoad += take;
    remaining -= take;
  }
  if (!inLoad) return null;
  const pct = plan.ExitLoadPercentBps ?? 0;
  const est = pct ? Math.round(((amountPaise * inLoad) / units) * (pct / 1_000_000)) : null;
  return `${formatUnits(inLoad)} of these units were bought within ${plan.ExitLoadDays} days${
    plan.ExitLoad ? ` (${plan.ExitLoad})` : ''
  }${est != null ? `; estimated exit load ₹${(est / 100).toFixed(2)}` : ''}.`;
}

// ---------------------------------------------------------------- bank link

/**
 * Create the MF transaction and, for types that move cash, the matching Phase 1 bank entry
 * (debit for purchases/SIPs, credit for redemptions/IDCW payouts), linked both ways.
 */
export function createMFTransactionWithBank(
  t: MFTransactionInput,
  bankAccountId: number | null,
  description?: string,
): number {
  const dir = cashDirection(t.TransactionType);
  if (!bankAccountId || dir === 0) return createMFTransaction(t);
  return tx(() => {
    const id = createMFTransaction(t);
    const total = computeTotalAmount(t);
    if (total <= 0) return id;
    const fund = one<{ FundName: string }>(
      'SELECT f.FundName FROM MutualFundPlan p JOIN MutualFund f ON f.MutualFundId = p.MutualFundId WHERE p.MutualFundPlanId = ?',
      [t.MutualFundPlanId],
    )?.FundName;
    const category = one<{ CategoryId: number }>(
      dir < 0
        ? "SELECT CategoryId FROM Categories WHERE Name = 'Mutual Fund / SIP' LIMIT 1"
        : t.TransactionType === 'IDCW_PAYOUT'
          ? "SELECT CategoryId FROM Categories WHERE Name = 'Dividend' LIMIT 1"
          : "SELECT CategoryId FROM Categories WHERE Name = 'Mutual Fund / SIP' LIMIT 1",
    )?.CategoryId;
    const bankId = createBankTransaction({
      AccountId: bankAccountId,
      TxnDate: t.TransactionDate,
      Description: description ?? `${TXN_TYPE_LABEL[t.TransactionType]} · ${fund ?? 'Mutual fund'}`,
      Amount: total,
      Direction: dir < 0 ? 'Debit' : 'Credit',
      ReferenceNo: t.TransactionReference ?? undefined,
      CategoryId: category ?? null,
    });
    run('UPDATE MFTransaction SET BankTransactionId = ? WHERE TransactionId = ?', [bankId, id]);
    run(
      "UPDATE Transactions SET LinkedEntity = 'MFTransaction', LinkedEntityId = ? WHERE TransactionId = ?",
      [id, bankId],
    );
    return id;
  });
}
