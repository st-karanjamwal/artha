import { all, one, run, tx } from '@/db/sql';
import { encryptSecret } from '@/crypto/secrets';
import { nowUtc } from '@/lib/dates';
import { blankToNull, last4 } from '@/lib/validators';

export interface Account {
  AccountId: number;
  BankId: number;
  AccountType: string;
  AccountNumber_Enc: string;
  AccountNumberLast4: string | null;
  CustomerId: string | null;
  OpenedOn: string | null;
  MaturityDate: string | null;
  InterestRate: string | null;
  OpeningBalance: number;
  OpeningBalanceDate: string | null;
  DebitCardLast4: string | null;
  Notes: string | null;
  CreatedOn: string;
  UpdatedOn: string;
  IsActive: number;
}

export interface AccountListItem extends Account {
  BankName: string;
  BranchName: string | null;
  IFSCCode: string | null;
  TypeLabel: string;
  CurrentBalance: number;
  PrimaryPersonId: number | null;
  PrimaryHolder: string | null;
  Holders: string | null;
}

export interface AccountInput {
  BankId: number;
  AccountType: string;
  /** Plaintext; empty on update = keep existing. */
  AccountNumber?: string;
  CustomerId?: string;
  OpenedOn?: string;
  MaturityDate?: string;
  InterestRate?: string;
  OpeningBalance: number;
  OpeningBalanceDate?: string;
  DebitCardLast4?: string;
  Notes?: string;
}

export type HolderRole = 'Primary' | 'Joint' | 'Nominee' | 'Guardian';

export interface AccountPersonInput {
  PersonId: number;
  Role: HolderRole;
  SharePercent?: string | null;
}

export interface AccountPerson extends AccountPersonInput {
  AccountPersonId: number;
  AccountId: number;
  PersonName: string;
  Relationship: string;
}

export const accountLabel = (
  a: Pick<AccountListItem, 'BankName' | 'TypeLabel' | 'AccountNumberLast4'>,
) => `${a.BankName} · ${a.TypeLabel} ··${a.AccountNumberLast4 ?? ''}`;

const LIST_SQL = `
SELECT a.*, b.BankName, b.BranchName, b.IFSCCode,
       COALESCE(l.Label, a.AccountType) AS TypeLabel,
       COALESCE(v.CurrentBalance, a.OpeningBalance) AS CurrentBalance,
       pp.PersonId AS PrimaryPersonId,
       TRIM(pp.FirstName || ' ' || COALESCE(pp.LastName, '')) AS PrimaryHolder,
       (SELECT GROUP_CONCAT(p2.FirstName, ', ') FROM AccountPersons ap2
          JOIN Persons p2 ON p2.PersonId = ap2.PersonId
         WHERE ap2.AccountId = a.AccountId AND ap2.Role IN ('Primary', 'Joint')) AS Holders
FROM Accounts a
JOIN Banks b ON b.BankId = a.BankId
LEFT JOIN LookupValues l ON l.Category = 'AccountType' AND l.Code = a.AccountType
LEFT JOIN vAccountBalances v ON v.AccountId = a.AccountId
LEFT JOIN Persons pp ON pp.PersonId = (
  SELECT ap.PersonId FROM AccountPersons ap
   WHERE ap.AccountId = a.AccountId AND ap.Role = 'Primary' ORDER BY ap.AccountPersonId LIMIT 1)
`;

export function listAccounts(
  opts: { includeInactive?: boolean; personId?: number; bankId?: number } = {},
): AccountListItem[] {
  const where: string[] = [];
  const params: number[] = [];
  if (!opts.includeInactive) where.push('a.IsActive = 1');
  if (opts.bankId) {
    where.push('a.BankId = ?');
    params.push(opts.bankId);
  }
  if (opts.personId) {
    where.push(
      'EXISTS (SELECT 1 FROM AccountPersons x WHERE x.AccountId = a.AccountId AND x.PersonId = ?)',
    );
    params.push(opts.personId);
  }
  return all<AccountListItem>(
    `${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.IsActive DESC, b.BankName, l.SortOrder, a.AccountId`,
    params,
  );
}

export function getAccount(id: number): AccountListItem | undefined {
  return one<AccountListItem>(`${LIST_SQL} WHERE a.AccountId = ?`, [id]);
}

function validateHolders(holders: AccountPersonInput[]) {
  if (!holders.some((h) => h.Role === 'Primary'))
    throw new Error('An account needs a primary holder');
  if (holders.filter((h) => h.Role === 'Primary').length > 1) {
    throw new Error('Only one primary holder is allowed');
  }
  const keys = holders.map((h) => `${h.PersonId}|${h.Role}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('Same person added twice with the same role');
  const share = holders
    .filter((h) => h.Role === 'Nominee' && h.SharePercent)
    .reduce((s, h) => s + Math.round(Number(h.SharePercent) * 100), 0);
  if (share > 10000) throw new Error('Nominee shares add up to more than 100%');
}

function accountValues(input: AccountInput) {
  return [
    input.BankId,
    input.AccountType,
    blankToNull(input.CustomerId),
    blankToNull(input.OpenedOn),
    blankToNull(input.MaturityDate),
    blankToNull(input.InterestRate),
    input.OpeningBalance,
    blankToNull(input.OpeningBalanceDate),
    blankToNull(input.DebitCardLast4),
    blankToNull(input.Notes),
  ];
}

export async function createAccount(
  input: AccountInput,
  holders: AccountPersonInput[],
): Promise<number> {
  const number = input.AccountNumber?.replace(/\s/g, '');
  if (!number) throw new Error('Account number is required');
  validateHolders(holders);
  const enc = await encryptSecret(number);
  const now = nowUtc();
  return tx(() => {
    const id = run(
      `INSERT INTO Accounts (BankId, AccountType, CustomerId, OpenedOn, MaturityDate, InterestRate,
         OpeningBalance, OpeningBalanceDate, DebitCardLast4, Notes, AccountNumber_Enc,
         AccountNumberLast4, CreatedOn, UpdatedOn)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...accountValues(input), enc, last4(number), now, now],
    ).lastId;
    writeHolders(id, holders);
    return id;
  });
}

export async function updateAccount(id: number, input: AccountInput): Promise<void> {
  const number = input.AccountNumber?.replace(/\s/g, '');
  const enc = number ? await encryptSecret(number) : null;
  run(
    `UPDATE Accounts SET BankId = ?, AccountType = ?, CustomerId = ?, OpenedOn = ?, MaturityDate = ?,
       InterestRate = ?, OpeningBalance = ?, OpeningBalanceDate = ?, DebitCardLast4 = ?, Notes = ?,
       AccountNumber_Enc = COALESCE(?, AccountNumber_Enc),
       AccountNumberLast4 = COALESCE(?, AccountNumberLast4), UpdatedOn = ?
     WHERE AccountId = ?`,
    [...accountValues(input), enc, number ? last4(number) : null, nowUtc(), id],
  );
}

export function setAccountNotes(id: number, notes: string) {
  run('UPDATE Accounts SET Notes = ?, UpdatedOn = ? WHERE AccountId = ?', [
    blankToNull(notes),
    nowUtc(),
    id,
  ]);
}

export function setAccountActive(id: number, active: boolean) {
  run('UPDATE Accounts SET IsActive = ?, UpdatedOn = ? WHERE AccountId = ?', [
    active,
    nowUtc(),
    id,
  ]);
}

// ---------------------------------------------------------------- holders & nominees

export function listAccountPersons(accountId: number): AccountPerson[] {
  return all<AccountPerson>(
    `SELECT ap.*, TRIM(p.FirstName || ' ' || COALESCE(p.LastName, '')) AS PersonName, p.Relationship
     FROM AccountPersons ap JOIN Persons p ON p.PersonId = ap.PersonId
     WHERE ap.AccountId = ?
     ORDER BY CASE ap.Role WHEN 'Primary' THEN 1 WHEN 'Joint' THEN 2 WHEN 'Guardian' THEN 3 ELSE 4 END,
              ap.AccountPersonId`,
    [accountId],
  );
}

function writeHolders(accountId: number, holders: AccountPersonInput[]) {
  run('DELETE FROM AccountPersons WHERE AccountId = ?', [accountId]);
  for (const h of holders) {
    run(
      'INSERT INTO AccountPersons (AccountId, PersonId, Role, SharePercent) VALUES (?, ?, ?, ?)',
      [
        accountId,
        h.PersonId,
        h.Role,
        h.Role === 'Nominee' ? blankToNull(h.SharePercent ?? '') : null,
      ],
    );
  }
}

export function setAccountPersons(accountId: number, holders: AccountPersonInput[]) {
  validateHolders(holders);
  tx(() => {
    writeHolders(accountId, holders);
    run('UPDATE Accounts SET UpdatedOn = ? WHERE AccountId = ?', [nowUtc(), accountId]);
  });
}

// ---------------------------------------------------------------- credentials

export interface Credential {
  CredentialId: number;
  AccountId: number;
  Channel: string;
  LoginId_Enc: string | null;
  Password_Enc: string | null;
  MPIN_Enc: string | null;
  TxnPassword_Enc: string | null;
  LastChangedOn: string | null;
  Notes: string | null;
  CreatedOn: string;
  UpdatedOn: string;
  IsActive: number;
}

export interface CredentialInput {
  Channel: string;
  /** Plaintext secrets; empty on update = keep existing. */
  LoginId?: string;
  Password?: string;
  MPIN?: string;
  TxnPassword?: string;
  LastChangedOn?: string;
  Notes?: string;
}

export function listCredentials(accountId: number): Credential[] {
  return all<Credential>(
    `SELECT c.* FROM AccountCredentials c
     LEFT JOIN LookupValues l ON l.Category = 'CredentialChannel' AND l.Code = c.Channel
     WHERE c.AccountId = ? AND c.IsActive = 1 ORDER BY l.SortOrder, c.CredentialId`,
    [accountId],
  );
}

const enc = async (v?: string) => (v && v !== '' ? encryptSecret(v) : null);

export async function createCredential(accountId: number, input: CredentialInput): Promise<number> {
  const [l, p, m, t] = await Promise.all([
    enc(input.LoginId),
    enc(input.Password),
    enc(input.MPIN),
    enc(input.TxnPassword),
  ]);
  const now = nowUtc();
  return run(
    `INSERT INTO AccountCredentials (AccountId, Channel, LoginId_Enc, Password_Enc, MPIN_Enc,
       TxnPassword_Enc, LastChangedOn, Notes, CreatedOn, UpdatedOn)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      accountId,
      input.Channel,
      l,
      p,
      m,
      t,
      blankToNull(input.LastChangedOn),
      blankToNull(input.Notes),
      now,
      now,
    ],
  ).lastId;
}

export async function updateCredential(id: number, input: CredentialInput): Promise<void> {
  const [l, p, m, t] = await Promise.all([
    enc(input.LoginId),
    enc(input.Password),
    enc(input.MPIN),
    enc(input.TxnPassword),
  ]);
  run(
    `UPDATE AccountCredentials SET Channel = ?,
       LoginId_Enc = COALESCE(?, LoginId_Enc), Password_Enc = COALESCE(?, Password_Enc),
       MPIN_Enc = COALESCE(?, MPIN_Enc), TxnPassword_Enc = COALESCE(?, TxnPassword_Enc),
       LastChangedOn = ?, Notes = ?, UpdatedOn = ?
     WHERE CredentialId = ?`,
    [
      input.Channel,
      l,
      p,
      m,
      t,
      blankToNull(input.LastChangedOn),
      blankToNull(input.Notes),
      nowUtc(),
      id,
    ],
  );
}

export function clearCredentialField(
  id: number,
  field: 'LoginId_Enc' | 'Password_Enc' | 'MPIN_Enc' | 'TxnPassword_Enc',
) {
  run(`UPDATE AccountCredentials SET ${field} = NULL, UpdatedOn = ? WHERE CredentialId = ?`, [
    nowUtc(),
    id,
  ]);
}

export function deactivateCredential(id: number) {
  run('UPDATE AccountCredentials SET IsActive = 0, UpdatedOn = ? WHERE CredentialId = ?', [
    nowUtc(),
    id,
  ]);
}

// ---------------------------------------------------------------- security questions

export interface SecurityQuestion {
  SecurityQuestionId: number;
  AccountId: number;
  Question: string;
  Answer_Enc: string;
  SortOrder: number;
}

export function listSecurityQuestions(accountId: number): SecurityQuestion[] {
  return all<SecurityQuestion>(
    'SELECT * FROM SecurityQuestions WHERE AccountId = ? ORDER BY SortOrder, SecurityQuestionId',
    [accountId],
  );
}

export async function addSecurityQuestion(accountId: number, question: string, answer: string) {
  const a = await encryptSecret(answer);
  const now = nowUtc();
  const max =
    one<{ m: number }>(
      'SELECT COALESCE(MAX(SortOrder), 0) AS m FROM SecurityQuestions WHERE AccountId = ?',
      [accountId],
    )?.m ?? 0;
  return run(
    `INSERT INTO SecurityQuestions (AccountId, Question, Answer_Enc, SortOrder, CreatedOn, UpdatedOn)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [accountId, question.trim(), a, max + 1, now, now],
  ).lastId;
}

export async function updateSecurityQuestion(id: number, question: string, answer?: string) {
  const a = answer ? await encryptSecret(answer) : null;
  run(
    `UPDATE SecurityQuestions SET Question = ?, Answer_Enc = COALESCE(?, Answer_Enc), UpdatedOn = ?
     WHERE SecurityQuestionId = ?`,
    [question.trim(), a, nowUtc(), id],
  );
}

export function deleteSecurityQuestion(id: number) {
  run('DELETE FROM SecurityQuestions WHERE SecurityQuestionId = ?', [id]);
}

// ---------------------------------------------------------------- balances & reconciliation

export interface BalanceSnapshot {
  BalanceSnapshotId: number;
  AccountId: number;
  AsOfDate: string;
  Balance: number;
  Notes: string | null;
  ComputedBalance: number;
}

/** Calculated balance at end of `date` (inclusive). */
export function balanceAsOf(accountId: number, date: string): number {
  return (
    one<{ b: number }>(
      `SELECT a.OpeningBalance + COALESCE(SUM(t.CreditAmount - t.DebitAmount), 0) AS b
       FROM Accounts a LEFT JOIN Transactions t ON t.AccountId = a.AccountId AND t.TxnDate <= ?
       WHERE a.AccountId = ? GROUP BY a.AccountId`,
      [date, accountId],
    )?.b ?? 0
  );
}

export function listSnapshots(accountId: number): BalanceSnapshot[] {
  return all<Omit<BalanceSnapshot, 'ComputedBalance'>>(
    'SELECT * FROM BalanceSnapshots WHERE AccountId = ? ORDER BY AsOfDate DESC, BalanceSnapshotId DESC',
    [accountId],
  ).map((s) => ({ ...s, ComputedBalance: balanceAsOf(accountId, s.AsOfDate) }));
}

export function addSnapshot(accountId: number, asOfDate: string, balance: number, notes?: string) {
  return run(
    'INSERT INTO BalanceSnapshots (AccountId, AsOfDate, Balance, Notes) VALUES (?, ?, ?, ?)',
    [accountId, asOfDate, balance, blankToNull(notes)],
  ).lastId;
}

export function deleteSnapshot(id: number) {
  run('DELETE FROM BalanceSnapshots WHERE BalanceSnapshotId = ?', [id]);
}
