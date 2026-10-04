import { all, one, run, tx, type Params } from '@/db/sql';
import { nowUtc } from '@/lib/dates';
import { blankToNull } from '@/lib/validators';
import { transferCategoryId } from './categories';

export interface Transaction {
  TransactionId: number;
  AccountId: number;
  TxnDate: string;
  TxnTime: string | null;
  Description: string;
  DebitAmount: number;
  CreditAmount: number;
  Mode: string | null;
  ReferenceNo: string | null;
  CounterParty: string | null;
  CategoryId: number | null;
  TransferGroupId: string | null;
  LinkedEntity: string | null;
  LinkedEntityId: number | null;
  ImportBatchId: number | null;
  Notes: string | null;
  CreatedOn: string;
  UpdatedOn: string;
}

export interface TransactionRow extends Transaction {
  RunningBalance: number;
  AccountLabel: string;
  CategoryName: string | null;
  CategoryKind: string | null;
  /** For transfers: label of the other account. */
  OtherAccountLabel: string | null;
}

export interface TxnFilter {
  accountId?: number;
  from?: string;
  to?: string;
  categoryId?: number | 'none';
  minAmount?: number; // paise
  maxAmount?: number; // paise
  search?: string;
  limit?: number;
}

export interface TransactionInput {
  AccountId: number;
  TxnDate: string;
  TxnTime?: string;
  Description: string;
  /** Positive paise. */
  Amount: number;
  Direction: 'Debit' | 'Credit';
  Mode?: string;
  ReferenceNo?: string;
  CounterParty?: string;
  CategoryId?: number | null;
  Notes?: string;
}

const ACCOUNT_LABEL = `b.BankName || ' · ' || COALESCE(l.Label, a.AccountType) || ' ··' || COALESCE(a.AccountNumberLast4, '')`;

export function listTransactions(f: TxnFilter = {}): TransactionRow[] {
  const where: string[] = [];
  const params: Params = [];
  if (f.accountId) {
    where.push('rb.AccountId = ?');
    params.push(f.accountId);
  }
  if (f.from) {
    where.push('rb.TxnDate >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('rb.TxnDate <= ?');
    params.push(f.to);
  }
  if (f.categoryId === 'none') where.push('rb.CategoryId IS NULL');
  else if (f.categoryId) {
    where.push('(rb.CategoryId = ? OR c.ParentCategoryId = ?)');
    params.push(f.categoryId, f.categoryId);
  }
  if (f.minAmount != null) {
    where.push('MAX(rb.DebitAmount, rb.CreditAmount) >= ?');
    params.push(f.minAmount);
  }
  if (f.maxAmount != null) {
    where.push('MAX(rb.DebitAmount, rb.CreditAmount) <= ?');
    params.push(f.maxAmount);
  }
  if (f.search?.trim()) {
    where.push(
      "(rb.Description LIKE ? ESCAPE '\\' OR rb.ReferenceNo LIKE ? ESCAPE '\\' OR rb.CounterParty LIKE ? ESCAPE '\\' OR rb.Notes LIKE ? ESCAPE '\\')",
    );
    const q = `%${f.search.trim().replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    params.push(q, q, q, q);
  }
  params.push(f.limit ?? 1000);
  return all<TransactionRow>(
    `WITH rb AS (
       SELECT t.*, a.OpeningBalance + SUM(t.CreditAmount - t.DebitAmount) OVER (
           PARTITION BY t.AccountId ORDER BY t.TxnDate, COALESCE(t.TxnTime, ''), t.TransactionId
           ROWS UNBOUNDED PRECEDING) AS RunningBalance
       FROM Transactions t JOIN Accounts a ON a.AccountId = t.AccountId
     )
     SELECT rb.*, ${ACCOUNT_LABEL} AS AccountLabel,
            CASE WHEN pc.Name IS NULL THEN c.Name ELSE pc.Name || ' › ' || c.Name END AS CategoryName,
            c.Kind AS CategoryKind,
            (SELECT ${ACCOUNT_LABEL.replace(/\b(a|b|l)\./g, '$1x.')}
               FROM Transactions o JOIN Accounts ax ON ax.AccountId = o.AccountId
               JOIN Banks bx ON bx.BankId = ax.BankId
               LEFT JOIN LookupValues lx ON lx.Category = 'AccountType' AND lx.Code = ax.AccountType
              WHERE o.TransferGroupId = rb.TransferGroupId AND o.TransactionId <> rb.TransactionId
              LIMIT 1) AS OtherAccountLabel
     FROM rb
     JOIN Accounts a ON a.AccountId = rb.AccountId
     JOIN Banks b ON b.BankId = a.BankId
     LEFT JOIN LookupValues l ON l.Category = 'AccountType' AND l.Code = a.AccountType
     LEFT JOIN Categories c ON c.CategoryId = rb.CategoryId
     LEFT JOIN Categories pc ON pc.CategoryId = c.ParentCategoryId
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY rb.TxnDate DESC, COALESCE(rb.TxnTime, '') DESC, rb.TransactionId DESC
     LIMIT ?`,
    params,
  );
}

export function getTransaction(id: number): Transaction | undefined {
  return one<Transaction>('SELECT * FROM Transactions WHERE TransactionId = ?', [id]);
}

function validate(input: TransactionInput) {
  if (!Number.isSafeInteger(input.Amount) || input.Amount <= 0) {
    throw new Error('Amount must be greater than zero');
  }
  if (!input.Description.trim()) throw new Error('Description is required');
}

export function createTransaction(
  input: TransactionInput,
  importBatchId: number | null = null,
): number {
  validate(input);
  const now = nowUtc();
  return run(
    `INSERT INTO Transactions (AccountId, TxnDate, TxnTime, Description, DebitAmount, CreditAmount,
       Mode, ReferenceNo, CounterParty, CategoryId, ImportBatchId, Notes, CreatedOn, UpdatedOn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.AccountId,
      input.TxnDate,
      blankToNull(input.TxnTime),
      input.Description.trim(),
      input.Direction === 'Debit' ? input.Amount : 0,
      input.Direction === 'Credit' ? input.Amount : 0,
      blankToNull(input.Mode),
      blankToNull(input.ReferenceNo),
      blankToNull(input.CounterParty),
      input.CategoryId ?? null,
      importBatchId,
      blankToNull(input.Notes),
      now,
      now,
    ],
  ).lastId;
}

export function updateTransaction(id: number, input: TransactionInput) {
  validate(input);
  const existing = getTransaction(id);
  if (!existing) throw new Error('Transaction not found');
  tx(() => {
    run(
      `UPDATE Transactions SET AccountId = ?, TxnDate = ?, TxnTime = ?, Description = ?,
         DebitAmount = ?, CreditAmount = ?, Mode = ?, ReferenceNo = ?, CounterParty = ?,
         CategoryId = ?, Notes = ?, UpdatedOn = ?
       WHERE TransactionId = ?`,
      [
        input.AccountId,
        input.TxnDate,
        blankToNull(input.TxnTime),
        input.Description.trim(),
        input.Direction === 'Debit' ? input.Amount : 0,
        input.Direction === 'Credit' ? input.Amount : 0,
        blankToNull(input.Mode),
        blankToNull(input.ReferenceNo),
        blankToNull(input.CounterParty),
        input.CategoryId ?? null,
        blankToNull(input.Notes),
        nowUtc(),
        id,
      ],
    );
    // Keep the other leg of a self-transfer in sync (amount, date, description, reference).
    if (existing.TransferGroupId) {
      run(
        `UPDATE Transactions SET TxnDate = ?, TxnTime = ?, Description = ?, ReferenceNo = ?, Mode = ?,
           DebitAmount = CASE WHEN DebitAmount > 0 THEN ? ELSE 0 END,
           CreditAmount = CASE WHEN CreditAmount > 0 THEN ? ELSE 0 END, UpdatedOn = ?
         WHERE TransferGroupId = ? AND TransactionId <> ?`,
        [
          input.TxnDate,
          blankToNull(input.TxnTime),
          input.Description.trim(),
          blankToNull(input.ReferenceNo),
          blankToNull(input.Mode),
          input.Amount,
          input.Amount,
          nowUtc(),
          existing.TransferGroupId,
          id,
        ],
      );
    }
  });
}

/** Deletes the transaction (and the other leg if it is a self-transfer). */
export function deleteTransaction(id: number) {
  const t = getTransaction(id);
  if (!t) return;
  if (t.TransferGroupId)
    run('DELETE FROM Transactions WHERE TransferGroupId = ?', [t.TransferGroupId]);
  else run('DELETE FROM Transactions WHERE TransactionId = ?', [id]);
}

export interface TransferInput {
  FromAccountId: number;
  ToAccountId: number;
  Amount: number;
  TxnDate: string;
  Description: string;
  Mode?: string;
  ReferenceNo?: string;
  Notes?: string;
}

/** Self-transfer between own accounts: two linked legs sharing a TransferGroupId. */
export function createTransfer(input: TransferInput): string {
  if (input.FromAccountId === input.ToAccountId) throw new Error('Choose two different accounts');
  const group = crypto.randomUUID();
  const categoryId = transferCategoryId();
  tx(() => {
    for (const [accountId, dir] of [
      [input.FromAccountId, 'Debit'],
      [input.ToAccountId, 'Credit'],
    ] as const) {
      const id = createTransaction({
        AccountId: accountId,
        TxnDate: input.TxnDate,
        Description: input.Description,
        Amount: input.Amount,
        Direction: dir,
        Mode: input.Mode,
        ReferenceNo: input.ReferenceNo,
        CategoryId: categoryId,
        Notes: input.Notes,
      });
      run('UPDATE Transactions SET TransferGroupId = ? WHERE TransactionId = ?', [group, id]);
    }
  });
  return group;
}

/** Link two existing transactions (e.g. both imported from statements) as one self-transfer. */
export function linkAsTransfer(debitTxnId: number, creditTxnId: number) {
  const d = getTransaction(debitTxnId);
  const c = getTransaction(creditTxnId);
  if (!d || !c) throw new Error('Transaction not found');
  if (d.DebitAmount === 0 || c.CreditAmount === 0 || d.DebitAmount !== c.CreditAmount) {
    throw new Error('Pick one debit and one credit of the same amount');
  }
  if (d.AccountId === c.AccountId) throw new Error('Both legs are in the same account');
  const group = crypto.randomUUID();
  run(
    'UPDATE Transactions SET TransferGroupId = ?, CategoryId = ?, UpdatedOn = ? WHERE TransactionId IN (?, ?)',
    [group, transferCategoryId(), nowUtc(), debitTxnId, creditTxnId],
  );
}

export function setTransactionCategory(ids: number[], categoryId: number | null) {
  tx(() => {
    for (const id of ids) {
      run('UPDATE Transactions SET CategoryId = ?, UpdatedOn = ? WHERE TransactionId = ?', [
        categoryId,
        nowUtc(),
        id,
      ]);
    }
  });
}
