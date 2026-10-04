import { all, one } from '@/db/sql';
import { addDays, todayLocal } from '@/lib/dates';

export interface GroupTotal {
  Id: number | null;
  Name: string;
  Total: number;
  AccountCount: number;
}

/** Bank balances attributed to each account's primary holder. */
export function balanceByPerson(): GroupTotal[] {
  return all<GroupTotal>(
    `SELECT p.PersonId AS Id,
            COALESCE(TRIM(p.FirstName || ' ' || COALESCE(p.LastName, '')), 'Unassigned') AS Name,
            SUM(v.CurrentBalance) AS Total, COUNT(*) AS AccountCount
     FROM Accounts a
     JOIN vAccountBalances v ON v.AccountId = a.AccountId
     LEFT JOIN AccountPersons ap ON ap.AccountPersonId = (
       SELECT x.AccountPersonId FROM AccountPersons x
        WHERE x.AccountId = a.AccountId AND x.Role = 'Primary' ORDER BY x.AccountPersonId LIMIT 1)
     LEFT JOIN Persons p ON p.PersonId = ap.PersonId
     WHERE a.IsActive = 1
     GROUP BY p.PersonId ORDER BY Total DESC`,
  );
}

export function balanceByBank(): GroupTotal[] {
  return all<GroupTotal>(
    `SELECT b.BankId AS Id, b.BankName AS Name, SUM(v.CurrentBalance) AS Total, COUNT(*) AS AccountCount
     FROM Accounts a JOIN Banks b ON b.BankId = a.BankId
     JOIN vAccountBalances v ON v.AccountId = a.AccountId
     WHERE a.IsActive = 1
     GROUP BY b.BankName ORDER BY Total DESC`,
  );
}

export function totalBankBalance(): number {
  return (
    one<{ t: number }>(
      `SELECT COALESCE(SUM(v.CurrentBalance), 0) AS t FROM Accounts a
       JOIN vAccountBalances v ON v.AccountId = a.AccountId WHERE a.IsActive = 1`,
    )?.t ?? 0
  );
}

export interface Maturity {
  AccountId: number;
  BankName: string;
  TypeLabel: string;
  AccountNumberLast4: string | null;
  MaturityDate: string;
  Holder: string | null;
  CurrentBalance: number;
}

export function upcomingMaturities(): Maturity[] {
  return all<Maturity>(
    `SELECT a.AccountId, b.BankName, COALESCE(l.Label, a.AccountType) AS TypeLabel,
            a.AccountNumberLast4, a.MaturityDate, v.CurrentBalance,
            (SELECT p.FirstName FROM AccountPersons ap JOIN Persons p ON p.PersonId = ap.PersonId
              WHERE ap.AccountId = a.AccountId AND ap.Role = 'Primary' LIMIT 1) AS Holder
     FROM Accounts a JOIN Banks b ON b.BankId = a.BankId
     JOIN vAccountBalances v ON v.AccountId = a.AccountId
     LEFT JOIN LookupValues l ON l.Category = 'AccountType' AND l.Code = a.AccountType
     WHERE a.IsActive = 1 AND a.MaturityDate IS NOT NULL
     ORDER BY a.MaturityDate`,
  );
}

/** Self-transfers and Transfer-kind categories are neither income nor expense. */
const FLOW_FILTER = `t.TransferGroupId IS NULL AND COALESCE(c.Kind, '') <> 'Transfer'`;

export interface Flow {
  Income: number;
  Expense: number;
  Invested: number;
}

export function incomeExpense(from: string, to: string = todayLocal()): Flow {
  return (
    one<Flow>(
      `SELECT
         COALESCE(SUM(CASE WHEN COALESCE(c.Kind, '') <> 'Investment' THEN t.CreditAmount END), 0) AS Income,
         COALESCE(SUM(CASE WHEN COALESCE(c.Kind, '') <> 'Investment' THEN t.DebitAmount END), 0) AS Expense,
         COALESCE(SUM(CASE WHEN c.Kind = 'Investment' THEN t.DebitAmount - t.CreditAmount END), 0) AS Invested
       FROM Transactions t JOIN Accounts a ON a.AccountId = t.AccountId
       LEFT JOIN Categories c ON c.CategoryId = t.CategoryId
       WHERE ${FLOW_FILTER} AND t.TxnDate BETWEEN ? AND ?`,
      [from, to],
    ) ?? { Income: 0, Expense: 0, Invested: 0 }
  );
}

export const last30Days = () => incomeExpense(addDays(todayLocal(), -29));

export interface MonthlyFlow extends Flow {
  Month: string; // YYYY-MM
}

export function monthlyFlows(months = 6): MonthlyFlow[] {
  const today = todayLocal();
  const [y, m] = today.split('-').map(Number);
  const start = new Date(y, m - months, 1);
  const from = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
  const rows = all<MonthlyFlow>(
    `SELECT substr(t.TxnDate, 1, 7) AS Month,
         COALESCE(SUM(CASE WHEN COALESCE(c.Kind, '') <> 'Investment' THEN t.CreditAmount END), 0) AS Income,
         COALESCE(SUM(CASE WHEN COALESCE(c.Kind, '') <> 'Investment' THEN t.DebitAmount END), 0) AS Expense,
         COALESCE(SUM(CASE WHEN c.Kind = 'Investment' THEN t.DebitAmount - t.CreditAmount END), 0) AS Invested
     FROM Transactions t LEFT JOIN Categories c ON c.CategoryId = t.CategoryId
     WHERE ${FLOW_FILTER} AND t.TxnDate >= ? AND t.TxnDate <= ?
     GROUP BY Month ORDER BY Month`,
    [from, today],
  );
  const byMonth = new Map(rows.map((r) => [r.Month, r]));
  const out: MonthlyFlow[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(byMonth.get(key) ?? { Month: key, Income: 0, Expense: 0, Invested: 0 });
  }
  return out;
}

export function topExpenseCategories(from: string, limit = 6) {
  return all<{ Name: string; Total: number }>(
    `SELECT COALESCE(CASE WHEN pc.Name IS NULL THEN c.Name ELSE pc.Name END, 'Uncategorised') AS Name,
            SUM(t.DebitAmount) AS Total
     FROM Transactions t
     LEFT JOIN Categories c ON c.CategoryId = t.CategoryId
     LEFT JOIN Categories pc ON pc.CategoryId = c.ParentCategoryId
     WHERE ${FLOW_FILTER} AND COALESCE(c.Kind, 'Expense') = 'Expense' AND t.DebitAmount > 0 AND t.TxnDate >= ?
     GROUP BY 1 ORDER BY Total DESC LIMIT ?`,
    [from, limit],
  );
}
