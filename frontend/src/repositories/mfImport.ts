import { all, one, run, tx } from '@/db/sql';
import { nowUtc, parseDate, type DateFormat } from '@/lib/dates';
import { parseStatementAmount } from '@/lib/money';
import { navFromAmountUnits, parseMicro, unitsFromAmount } from '@/lib/units';
import { cleanFundName, inferOptionType, inferPlanType } from '@/features/mf/amfi';
import { classifyDescription, type CasResult } from '@/features/mf/cas';
import { ADD_TYPES, REDUCE_TYPES, unitDelta, type MFTxnType } from '@/features/mf/calc/fifo';
import type { Grid } from './imports';
import { createFund, createPlan, findPlan, listPlans } from './mfFunds';
import { findFolio, getOrCreateFolio, normaliseFolio } from './mfAccounts';
import { holdingTxns, insertMFTransactionRaw } from './mfTransactions';
import { upsertNav } from './mfNav';

/** One candidate transaction from a CAS or CSV, before it is written. */
export interface ImportRow {
  line: number;
  amc: string;
  folioNumber: string | null;
  schemeName: string;
  isin: string | null;
  planId: number | null; // existing plan, if matched
  date: string | null;
  type: MFTxnType;
  description: string;
  units: number;
  nav: number | null;
  amount: number;
  stampDuty: number;
  stt: number;
  tds: number;
  status: 'new' | 'duplicate' | 'error';
  error?: string;
  forced?: boolean;
}

export interface ReconRow {
  amc: string;
  folioNumber: string;
  schemeName: string;
  isin: string | null;
  statementClosing: number | null;
  existingBefore: number; // units already in Artha for this folio+plan before the import
  imported: number; // net units the import would add
  afterImport: number;
  diff: number | null; // afterImport − statementClosing
  openingMissing: boolean;
}

export interface PreparedImport {
  rows: ImportRow[];
  recon: ReconRow[];
  warnings: string[];
}

const dupKey = (r: { date: string; type: string; units: number; amount: number }) =>
  `${r.date}|${r.type}|${r.units}|${r.amount}`;

function existingFolioPlan(amc: string, folioNumber: string | null, planId: number | null) {
  if (!folioNumber || !planId)
    return { folioId: null as number | null, accountId: null as number | null };
  const f = findFolio(amc, folioNumber);
  return { folioId: f?.FolioId ?? null, accountId: f?.InvestmentAccountId ?? null };
}

/** Flag rows already present (same folio, plan, date, type, units, amount); count-based. */
function markDuplicates(rows: ImportRow[]): void {
  const cache = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.status === 'error' || !r.date) continue;
    const { folioId, accountId } = existingFolioPlan(r.amc, r.folioNumber, r.planId);
    if (!folioId || !accountId || !r.planId) continue;
    const ck = `${folioId}|${r.planId}`;
    if (!cache.has(ck)) {
      const m = new Map<string, number>();
      for (const t of holdingTxns(accountId, folioId, r.planId)) {
        const k = dupKey({
          date: t.TransactionDate,
          type: t.TransactionType,
          units: t.Units,
          amount: t.Amount,
        });
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      cache.set(ck, m);
    }
    const m = cache.get(ck)!;
    const k = dupKey({ date: r.date, type: r.type, units: r.units, amount: r.amount });
    const n = m.get(k) ?? 0;
    if (n > 0 && !r.forced) {
      m.set(k, n - 1);
      r.status = 'duplicate';
    }
  }
}

function rowError(r: ImportRow): string | undefined {
  if (!r.date) return 'Invalid date';
  if (r.type === 'IDCW_PAYOUT') return r.amount > 0 ? undefined : 'No amount';
  if (!(r.units > 0)) return 'No units';
  if (!r.nav) return 'No NAV';
  return undefined;
}

// ---------------------------------------------------------------- CAS

export function prepareCasImport(cas: CasResult): PreparedImport {
  const rows: ImportRow[] = [];
  let line = 0;
  for (const s of cas.schemes) {
    const plan = findPlan({ isin: s.isin });
    for (const t of s.transactions) {
      const r: ImportRow = {
        line: ++line,
        amc: s.amc,
        folioNumber: s.folioNumber ? normaliseFolio(s.folioNumber) : null,
        schemeName: s.schemeName,
        isin: s.isin,
        planId: plan?.MutualFundPlanId ?? null,
        date: t.date,
        type: t.type,
        description: t.description,
        units: t.units,
        nav: t.nav,
        amount:
          t.amount || (t.nav && t.units ? Math.round((t.units / 1e6) * (t.nav / 1e6) * 100) : 0),
        stampDuty: t.stampDuty,
        stt: t.stt,
        tds: t.tds,
        status: 'new',
      };
      r.error = rowError(r);
      if (r.error) r.status = 'error';
      rows.push(r);
    }
  }
  markDuplicates(rows);
  return { rows, recon: reconcile(cas, rows), warnings: cas.warnings };
}

function reconcile(cas: CasResult, rows: ImportRow[]): ReconRow[] {
  return cas.schemes.map((s) => {
    const folioNumber = normaliseFolio(s.folioNumber || '');
    const plan = findPlan({ isin: s.isin });
    const { folioId, accountId } = existingFolioPlan(
      s.amc,
      folioNumber,
      plan?.MutualFundPlanId ?? null,
    );
    const existingBefore =
      folioId && accountId && plan
        ? holdingTxns(accountId, folioId, plan.MutualFundPlanId).reduce(
            (sum, t) => sum + unitDelta(t),
            0,
          )
        : 0;
    const imported = rows
      .filter((r) => r.status === 'new' && r.isin === s.isin && r.folioNumber === folioNumber)
      .reduce((sum, r) => sum + unitDelta({ TransactionType: r.type, Units: r.units }), 0);
    const afterImport = existingBefore + imported;
    return {
      amc: s.amc,
      folioNumber,
      schemeName: s.schemeName,
      isin: s.isin,
      statementClosing: s.closingUnits,
      existingBefore,
      imported,
      afterImport,
      diff: s.closingUnits == null ? null : afterImport - s.closingUnits,
      openingMissing: (s.openingUnits ?? 0) > 0 && existingBefore === 0,
    };
  });
}

/** Create a fund + plan from a CAS scheme name when the ISIN is not known yet. */
function planForScheme(amc: string, schemeName: string, isin: string | null): number {
  const found = findPlan({ isin });
  if (found) return found.MutualFundPlanId;
  const fundName = cleanFundName(schemeName) || schemeName;
  const amcName = amc || 'Unknown AMC';
  const fundId =
    one<{ MutualFundId: number }>(
      'SELECT MutualFundId FROM MutualFund WHERE AMCName = ? AND FundName = ?',
      [amcName, fundName],
    )?.MutualFundId ?? createFund({ AMCName: amcName, FundName: fundName });
  const planType = inferPlanType(schemeName);
  const optionType = inferOptionType(schemeName);
  const sameVariant = one<{ MutualFundPlanId: number }>(
    'SELECT MutualFundPlanId FROM MutualFundPlan WHERE MutualFundId = ? AND PlanType = ? AND OptionType = ?',
    [fundId, planType, optionType],
  );
  if (sameVariant) {
    if (isin)
      run('UPDATE MutualFundPlan SET ISIN = COALESCE(ISIN, ?) WHERE MutualFundPlanId = ?', [
        isin,
        sameVariant.MutualFundPlanId,
      ]);
    return sameVariant.MutualFundPlanId;
  }
  return createPlan(fundId, { PlanType: planType, OptionType: optionType, ISIN: isin });
}

/** Pair SWITCH_OUT / SWITCH_IN legs on the same date and AMC with amounts within 1%. */
function pairSwitches(rows: ImportRow[]): Map<ImportRow, string> {
  const groups = new Map<ImportRow, string>();
  const outs = rows.filter((r) => r.type === 'SWITCH_OUT' && r.status === 'new');
  const ins = rows.filter((r) => r.type === 'SWITCH_IN' && r.status === 'new');
  for (const o of outs) {
    const i = ins.find(
      (x) =>
        !groups.has(x) &&
        x.amc === o.amc &&
        x.date != null &&
        o.date != null &&
        Math.abs(Date.parse(x.date) - Date.parse(o.date)) <= 3 * 86_400_000 &&
        Math.abs(x.amount + x.stampDuty - o.amount) <= Math.max(100, o.amount * 0.01),
    );
    if (i) {
      const g = crypto.randomUUID();
      groups.set(o, g);
      groups.set(i, g);
    }
  }
  return groups;
}

export function commitCasImport(
  prepared: PreparedImport,
  cas: CasResult,
  accountId: number,
  fileName: string,
): number {
  const toImport = prepared.rows.filter((r) => r.status === 'new');
  const switchGroups = pairSwitches(toImport);
  return tx(() => {
    const batchId = run(
      'INSERT INTO MFImportBatch (Source, FileName, RowCount, SkippedCount) VALUES (?, ?, ?, ?)',
      ['CAS_IMPORT', fileName, toImport.length, prepared.rows.length - toImport.length],
    ).lastId;
    const planCache = new Map<string, number>();
    for (const r of toImport) {
      const pk = `${r.amc}|${r.isin ?? r.schemeName}`;
      let planId = r.planId ?? planCache.get(pk);
      if (!planId) {
        planId = planForScheme(r.amc, r.schemeName, r.isin);
        planCache.set(pk, planId);
      }
      const folioId = r.folioNumber
        ? getOrCreateFolio(accountId, r.amc || 'Unknown AMC', r.folioNumber)
        : null;
      const folioAccount =
        (folioId &&
          one<{ InvestmentAccountId: number }>(
            'SELECT InvestmentAccountId FROM MFFolio WHERE FolioId = ?',
            [folioId],
          )?.InvestmentAccountId) ||
        accountId;
      insertMFTransactionRaw({
        MutualFundPlanId: planId,
        InvestmentAccountId: folioAccount,
        FolioId: folioId,
        TransactionDate: r.date!,
        TransactionType: r.type,
        NAV: r.nav,
        Units: r.type === 'IDCW_PAYOUT' ? 0 : r.units,
        Amount: r.amount,
        StampDuty: r.stampDuty,
        STT: r.stt,
        TDS: r.tds,
        FolioNumber: r.folioNumber,
        TransactionReference: r.description.slice(0, 200),
        SwitchGroupId: switchGroups.get(r) ?? null,
        Source: 'CAS_IMPORT',
        ImportBatchId: batchId,
      });
    }
    // Closing NAVs from the statement.
    for (const s of cas.schemes) {
      const plan = findPlan({ isin: s.isin });
      if (plan && s.closingNav && s.closingNavDate)
        upsertNav(plan.MutualFundPlanId, s.closingNavDate, s.closingNav, 'MANUAL');
    }
    return batchId;
  });
}

// ---------------------------------------------------------------- platform CSV

export interface MFCsvMapping {
  headerRow: number;
  dateCol: number;
  dateFormat: DateFormat;
  schemeCol: number;
  schemeKind: 'isin' | 'code' | 'name';
  typeCol: number;
  unitsCol: number;
  navCol?: number;
  amountCol: number;
  folioCol?: number;
  stampCol?: number;
}

const norm = (c: unknown) => (c == null ? '' : String(c).trim().toLowerCase());

export function guessMfCsvMapping(header: unknown[]): Partial<MFCsvMapping> {
  const h = header.map(norm);
  const find = (re: RegExp) => {
    const i = h.findIndex((c) => re.test(c));
    return i >= 0 ? i : undefined;
  };
  const isinCol = find(/isin/);
  const codeCol = find(/scheme code|amfi/);
  const nameCol = find(/scheme|fund|name/);
  return {
    dateCol: find(/date/),
    schemeCol: isinCol ?? codeCol ?? nameCol,
    schemeKind: isinCol != null ? 'isin' : codeCol != null ? 'code' : 'name',
    typeCol: find(/type|transaction|description|action/),
    unitsCol: find(/unit|quantity|qty/),
    navCol: find(/nav|price/),
    amountCol: find(/amount|value/),
    folioCol: find(/folio/),
    stampCol: find(/stamp/),
  };
}

function resolvePlan(kind: MFCsvMapping['schemeKind'], raw: string): number | null {
  const v = raw.trim();
  if (!v) return null;
  if (kind === 'isin') return findPlan({ isin: v.toUpperCase() })?.MutualFundPlanId ?? null;
  if (kind === 'code') return findPlan({ schemeCode: v })?.MutualFundPlanId ?? null;
  const fundName = cleanFundName(v).toLowerCase();
  const plan = inferPlanType(v);
  const option = inferOptionType(v);
  const candidates = listPlans({ includeInactive: true }).filter(
    (p) => p.FundName.toLowerCase() === fundName,
  );
  return (
    candidates.find((p) => p.PlanType === plan && p.OptionType === option)?.MutualFundPlanId ??
    (candidates.length === 1 ? candidates[0].MutualFundPlanId : null)
  );
}

export function prepareCsvImport(grid: Grid, m: MFCsvMapping): PreparedImport {
  const rows: ImportRow[] = [];
  for (let i = m.headerRow + 1; i < grid.length; i++) {
    const r = grid[i];
    if (!r || r.every((c) => c == null || String(c).trim() === '')) continue;
    const rawUnits = parseMicro(
      String(r[m.unitsCol] ?? '').replace(/[()]/g, (x) => (x === '(' ? '-' : '')),
    );
    const sign = rawUnits != null && rawUnits < 0 ? -1 : 1;
    const desc = String(r[m.typeCol] ?? '');
    const type = classifyDescription(desc, sign);
    let units = Math.abs(rawUnits ?? 0);
    let amount = Math.abs(parseStatementAmount(r[m.amountCol]) ?? 0);
    let nav = m.navCol != null ? parseMicro(String(r[m.navCol] ?? '')) : null;
    const stamp = m.stampCol != null ? Math.abs(parseStatementAmount(r[m.stampCol]) ?? 0) : 0;
    if (!nav && units && amount) nav = navFromAmountUnits(amount, units);
    if (!units && nav && amount && type !== 'IDCW_PAYOUT')
      units = unitsFromAmount(amount - stamp, nav);
    if (!amount && units && nav) amount = Math.round((units / 1e6) * (nav / 1e6) * 100);
    const schemeRaw = String(r[m.schemeCol] ?? '');
    const planId = resolvePlan(m.schemeKind, schemeRaw);
    const plan = planId
      ? listPlans({ includeInactive: true }).find((p) => p.MutualFundPlanId === planId)
      : undefined;
    const row: ImportRow = {
      line: i + 1,
      amc: plan?.AMCName ?? '',
      folioNumber:
        m.folioCol != null && r[m.folioCol] ? normaliseFolio(String(r[m.folioCol])) : null,
      schemeName: schemeRaw,
      isin: plan?.ISIN ?? null,
      planId,
      date: parseDate(r[m.dateCol], m.dateFormat),
      type,
      description: desc,
      units: type === 'IDCW_PAYOUT' ? 0 : units,
      nav,
      amount,
      stampDuty: stamp,
      stt: 0,
      tds: 0,
      status: 'new',
    };
    row.error = !planId ? 'Fund not found (add it under Funds first)' : rowError(row);
    if (row.error) row.status = 'error';
    rows.push(row);
  }
  markDuplicates(rows);
  return { rows, recon: [], warnings: [] };
}

export function commitCsvImport(
  prepared: PreparedImport,
  accountId: number,
  fileName: string,
): number {
  const toImport = prepared.rows.filter((r) => r.status === 'new');
  return tx(() => {
    const batchId = run(
      'INSERT INTO MFImportBatch (Source, FileName, RowCount, SkippedCount) VALUES (?, ?, ?, ?)',
      ['CSV_IMPORT', fileName, toImport.length, prepared.rows.length - toImport.length],
    ).lastId;
    for (const r of toImport) {
      const folioId =
        r.folioNumber && r.amc ? getOrCreateFolio(accountId, r.amc, r.folioNumber) : null;
      insertMFTransactionRaw({
        MutualFundPlanId: r.planId!,
        InvestmentAccountId: accountId,
        FolioId: folioId,
        TransactionDate: r.date!,
        TransactionType: r.type,
        NAV: r.nav,
        Units: r.units,
        Amount: r.amount,
        StampDuty: r.stampDuty,
        FolioNumber: r.folioNumber,
        TransactionReference: r.description.slice(0, 200),
        Source: 'CSV_IMPORT',
        ImportBatchId: batchId,
      });
    }
    return batchId;
  });
}

export function getMfMapping(platform: string): MFCsvMapping | null {
  const r = one<{ MappingJson: string }>(
    'SELECT MappingJson FROM MFImportMapping WHERE PlatformName = ?',
    [platform],
  );
  return r ? (JSON.parse(r.MappingJson) as MFCsvMapping) : null;
}

export function saveMfMapping(platform: string, m: MFCsvMapping) {
  run(
    `INSERT INTO MFImportMapping (PlatformName, MappingJson, UpdatedOn) VALUES (?, ?, ?)
     ON CONFLICT(PlatformName) DO UPDATE SET MappingJson = excluded.MappingJson, UpdatedOn = excluded.UpdatedOn`,
    [platform, JSON.stringify(m), nowUtc()],
  );
}

// ---------------------------------------------------------------- batches

export interface MFImportBatch {
  ImportBatchId: number;
  Source: 'CAS_IMPORT' | 'CSV_IMPORT';
  FileName: string;
  ImportedOn: string;
  RowCount: number;
  SkippedCount: number;
  UndoneOn: string | null;
  RemainingCount: number;
}

export function listMfImportBatches(): MFImportBatch[] {
  return all<MFImportBatch>(
    `SELECT b.*, (SELECT COUNT(*) FROM MFTransaction t WHERE t.ImportBatchId = b.ImportBatchId) AS RemainingCount
     FROM MFImportBatch b ORDER BY b.ImportBatchId DESC`,
  );
}

/** Delete every transaction created by the batch (both legs of switches it created). */
export function undoMfImport(batchId: number) {
  tx(() => {
    run('DELETE FROM MFTransaction WHERE ImportBatchId = ?', [batchId]);
    run('UPDATE MFImportBatch SET UndoneOn = ? WHERE ImportBatchId = ?', [nowUtc(), batchId]);
  });
}

/** Holdings that went negative (e.g. after undoing an import that earlier redemptions relied on). */
export function negativeHoldings(): { label: string; units: number }[] {
  return all<{ label: string; units: number }>(
    `SELECT f.FundName || ' · ' || COALESCE(fo.FolioNumber, 'no folio') AS label, h.UnitsHeld AS units
     FROM vMFHoldings h
     JOIN MutualFundPlan p ON p.MutualFundPlanId = h.MutualFundPlanId
     JOIN MutualFund f ON f.MutualFundId = p.MutualFundId
     LEFT JOIN MFFolio fo ON fo.FolioId = h.FolioId
     WHERE h.UnitsHeld < 0`,
  );
}

export { ADD_TYPES, REDUCE_TYPES };
