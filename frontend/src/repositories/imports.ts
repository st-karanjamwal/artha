import { all, one, run, tx } from '@/db/sql';
import { nowUtc, parseDate, type DateFormat } from '@/lib/dates';
import { parseStatementAmount } from '@/lib/money';
import { addSnapshot } from './accounts';
import { createTransaction } from './transactions';

export type Cell = string | number | Date | null;
export type Grid = Cell[][];

export interface ImportMapping {
  headerRow: number; // 0-based index into the grid
  dateCol: number;
  dateFormat: DateFormat;
  descCol: number;
  amountMode: 'split' | 'signed' | 'drcr';
  debitCol?: number;
  creditCol?: number;
  amountCol?: number;
  drcrCol?: number;
  refCol?: number;
  balanceCol?: number;
}

export interface ParsedRow {
  line: number; // 1-based line in file for display
  date: string | null;
  description: string;
  debit: number;
  credit: number;
  ref: string | null;
  balance: number | null;
  error?: string;
  duplicate?: boolean;
}

// ---------------------------------------------------------------- file parsing

export async function readStatementFile(file: File): Promise<Grid> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const Papa = (await import('papaparse')).default;
    const text = await file.text();
    const res = Papa.parse<string[]>(text, { skipEmptyLines: false });
    return res.data;
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json<Cell[]>(sheet, { header: 1, raw: true, defval: null });
  }
  throw new Error('Upload a .csv or .xlsx statement');
}

const norm = (c: Cell) => (c == null ? '' : String(c).trim().toLowerCase());

/** First row that looks like a header (has a date column and an amount-like column). */
export function guessHeaderRow(grid: Grid): number {
  for (let i = 0; i < Math.min(grid.length, 60); i++) {
    const cells = (grid[i] ?? []).map(norm);
    const hasDate = cells.some((c) => /date/.test(c));
    const hasAmt = cells.some((c) => /(debit|withdraw|credit|deposit|amount|dr\b|cr\b)/.test(c));
    if (hasDate && hasAmt) return i;
  }
  return 0;
}

export function guessMapping(header: Cell[]): Partial<ImportMapping> {
  const h = header.map(norm);
  const find = (re: RegExp, exclude?: RegExp) =>
    h.findIndex((c) => re.test(c) && !(exclude && exclude.test(c)));
  const pick = (i: number) => (i >= 0 ? i : undefined);
  const m: Partial<ImportMapping> = {
    dateCol: pick(find(/(txn|tran|transaction)?\s*date/, /value/)) ?? pick(find(/date/)),
    descCol: pick(find(/(narration|description|particular|details|remarks)/)),
    refCol: pick(find(/(ref|chq|cheque|utr)/)),
    balanceCol: pick(find(/balance/)),
  };
  const debit = find(/(debit|withdraw)/);
  const credit = find(/(credit|deposit)/);
  if (debit >= 0 && credit >= 0) {
    m.amountMode = 'split';
    m.debitCol = debit;
    m.creditCol = credit;
  } else {
    const amt = find(/amount/);
    const drcr = find(/(dr\s*\/\s*cr|cr\s*\/\s*dr|type|dr|cr)/, /(date|desc)/);
    if (amt >= 0 && drcr >= 0 && drcr !== amt) {
      m.amountMode = 'drcr';
      m.amountCol = amt;
      m.drcrCol = drcr;
    } else if (amt >= 0) {
      m.amountMode = 'signed';
      m.amountCol = amt;
    }
  }
  return m;
}

export function sampleDateFormat(
  grid: Grid,
  mapping: Pick<ImportMapping, 'headerRow' | 'dateCol'>,
): DateFormat {
  const samples = grid
    .slice(mapping.headerRow + 1, mapping.headerRow + 30)
    .map((r) => r?.[mapping.dateCol])
    .filter((v) => v != null && v !== '');
  const formats: DateFormat[] = [
    'DD/MM/YYYY',
    'DD-MMM-YYYY',
    'DD MMM YYYY',
    'YYYY-MM-DD',
    'DD/MM/YY',
  ];
  let best: DateFormat = 'DD/MM/YYYY';
  let bestScore = -1;
  for (const f of formats) {
    const score = samples.filter((s) => parseDate(s, f)).length;
    if (score > bestScore) {
      best = f;
      bestScore = score;
    }
  }
  return best;
}

const isBlankRow = (r: Cell[] | undefined) =>
  !r || r.every((c) => c == null || String(c).trim() === '');

/** Apply mapping to grid rows after the header. Footer/summary lines without a date are dropped. */
export function applyMapping(grid: Grid, m: ImportMapping): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (let i = m.headerRow + 1; i < grid.length; i++) {
    const r = grid[i];
    if (isBlankRow(r)) continue;
    const rawDate = r[m.dateCol];
    const date = parseDate(rawDate, m.dateFormat);
    let debit = 0;
    let credit = 0;
    let amountError: string | undefined;
    if (m.amountMode === 'split') {
      const d = parseStatementAmount(r[m.debitCol!]);
      const c = parseStatementAmount(r[m.creditCol!]);
      debit = Math.abs(d ?? 0);
      credit = Math.abs(c ?? 0);
    } else {
      const a = parseStatementAmount(r[m.amountCol!]);
      if (a == null) amountError = 'No amount';
      else if (m.amountMode === 'signed') {
        if (a < 0) debit = -a;
        else credit = a;
      } else {
        const t = norm(r[m.drcrCol!]);
        if (/^(dr|d|debit|withdrawal)\.?$/.test(t)) debit = Math.abs(a);
        else if (/^(cr|c|credit|deposit)\.?$/.test(t)) credit = Math.abs(a);
        else amountError = `Unknown Dr/Cr value "${r[m.drcrCol!] ?? ''}"`;
      }
    }
    // Rows with neither a date nor an amount are summary/footer lines; skip silently.
    if (!date && debit === 0 && credit === 0) continue;
    const row: ParsedRow = {
      line: i + 1,
      date,
      description: String(r[m.descCol] ?? '')
        .replace(/\s+/g, ' ')
        .trim(),
      debit,
      credit,
      ref:
        m.refCol != null && r[m.refCol] != null && String(r[m.refCol]).trim() !== ''
          ? String(r[m.refCol]).trim()
          : null,
      balance: m.balanceCol != null ? parseStatementAmount(r[m.balanceCol]) : null,
    };
    if (!date) row.error = `Invalid date "${rawDate ?? ''}"`;
    else if (amountError) row.error = amountError;
    else if (debit > 0 && credit > 0) row.error = 'Both debit and credit present';
    else if (debit === 0 && credit === 0) row.error = 'Zero amount';
    else if (!row.description) row.description = row.ref ?? '(no description)';
    out.push(row);
  }
  return out;
}

/** Statements are often newest-first; return rows oldest-first (stable within a day). */
export function chronological(rows: ParsedRow[]): ParsedRow[] {
  const dated = rows.filter((r) => r.date);
  if (dated.length >= 2 && dated[0].date! > dated[dated.length - 1].date!)
    return [...rows].reverse();
  return rows;
}

const descKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 40);

function dupKey(date: string, debit: number, credit: number, ref: string | null, desc: string) {
  return `${date}|${debit}|${credit}|${ref ? 'r:' + ref.toLowerCase() : 'd:' + descKey(desc)}`;
}

/** Mark rows that already exist in the account (date + amount + reference, or description if no ref). */
export function markDuplicates(accountId: number, rows: ParsedRow[]): ParsedRow[] {
  const dates = rows.map((r) => r.date).filter(Boolean) as string[];
  if (!dates.length) return rows;
  const existing = all<{
    TxnDate: string;
    DebitAmount: number;
    CreditAmount: number;
    ReferenceNo: string | null;
    Description: string;
  }>(
    `SELECT TxnDate, DebitAmount, CreditAmount, ReferenceNo, Description FROM Transactions
     WHERE AccountId = ? AND TxnDate BETWEEN ? AND ?`,
    [accountId, dates.reduce((a, b) => (a < b ? a : b)), dates.reduce((a, b) => (a > b ? a : b))],
  );
  // Count-based so that two genuinely identical rows in the file are only flagged
  // as many times as they already exist in the account.
  const counts = new Map<string, number>();
  for (const e of existing) {
    const k = dupKey(e.TxnDate, e.DebitAmount, e.CreditAmount, e.ReferenceNo, e.Description);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return rows.map((r) => {
    if (!r.date || r.error) return r;
    const k = dupKey(r.date, r.debit, r.credit, r.ref, r.description);
    const n = counts.get(k) ?? 0;
    if (n > 0) {
      counts.set(k, n - 1);
      return { ...r, duplicate: true };
    }
    return { ...r, duplicate: false };
  });
}

/** Closing balance per statement: balance on the chronologically last row. */
export function statementClosing(rows: ParsedRow[]): { date: string; balance: number } | null {
  const withBal = rows.filter((r) => r.date && r.balance != null && !r.error);
  const last = withBal[withBal.length - 1];
  return last ? { date: last.date!, balance: last.balance! } : null;
}

// ---------------------------------------------------------------- persistence

export interface ImportBatch {
  ImportBatchId: number;
  AccountId: number;
  FileName: string;
  ImportedOn: string;
  RowCount: number;
  SkippedCount: number;
  UndoneOn: string | null;
  Notes: string | null;
  RemainingCount: number;
}

export function commitImport(
  accountId: number,
  fileName: string,
  rows: ParsedRow[],
  opts: { categoryId?: number | null; recordSnapshot?: boolean; skipped?: number } = {},
): number {
  const toImport = rows.filter((r) => !r.error && !r.duplicate);
  return tx(() => {
    const batchId = run(
      `INSERT INTO ImportBatches (AccountId, FileName, ImportedOn, RowCount, SkippedCount)
       VALUES (?, ?, ?, ?, ?)`,
      [
        accountId,
        fileName,
        nowUtc(),
        toImport.length,
        opts.skipped ?? rows.length - toImport.length,
      ],
    ).lastId;
    for (const r of toImport) {
      createTransaction(
        {
          AccountId: accountId,
          TxnDate: r.date!,
          Description: r.description,
          Amount: r.debit || r.credit,
          Direction: r.debit ? 'Debit' : 'Credit',
          ReferenceNo: r.ref ?? undefined,
          CategoryId: opts.categoryId ?? null,
        },
        batchId,
      );
    }
    const closing = statementClosing(rows);
    if (opts.recordSnapshot && closing) {
      addSnapshot(accountId, closing.date, closing.balance, `Statement import: ${fileName}`);
    }
    return batchId;
  });
}

export function undoImport(batchId: number) {
  tx(() => {
    // Unlink any transfer partners first so the other leg is not left half-linked.
    run(
      `UPDATE Transactions SET TransferGroupId = NULL
       WHERE TransferGroupId IN (SELECT TransferGroupId FROM Transactions
                                 WHERE ImportBatchId = ? AND TransferGroupId IS NOT NULL)`,
      [batchId],
    );
    run('DELETE FROM Transactions WHERE ImportBatchId = ?', [batchId]);
    run('UPDATE ImportBatches SET UndoneOn = ? WHERE ImportBatchId = ?', [nowUtc(), batchId]);
  });
}

export function listImportBatches(accountId?: number): ImportBatch[] {
  return all<ImportBatch>(
    `SELECT ib.*, (SELECT COUNT(*) FROM Transactions t WHERE t.ImportBatchId = ib.ImportBatchId) AS RemainingCount
     FROM ImportBatches ib ${accountId ? 'WHERE ib.AccountId = ?' : ''}
     ORDER BY ib.ImportBatchId DESC`,
    accountId ? [accountId] : [],
  );
}

export function getSavedMapping(bankId: number): ImportMapping | null {
  const r = one<{ MappingJson: string }>(
    'SELECT MappingJson FROM ImportMappings WHERE BankId = ?',
    [bankId],
  );
  return r ? (JSON.parse(r.MappingJson) as ImportMapping) : null;
}

export function saveMapping(bankId: number, m: ImportMapping) {
  run(
    `INSERT INTO ImportMappings (BankId, MappingJson, UpdatedOn) VALUES (?, ?, ?)
     ON CONFLICT(BankId) DO UPDATE SET MappingJson = excluded.MappingJson, UpdatedOn = excluded.UpdatedOn`,
    [bankId, JSON.stringify(m), nowUtc()],
  );
}
