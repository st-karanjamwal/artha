import { all, one, run, tx } from '@/db/sql';
import { encryptSecret } from '@/crypto/secrets';
import { ageFrom, nowUtc } from '@/lib/dates';
import { blankToNull } from '@/lib/validators';

export interface InvestmentAccount {
  InvestmentAccountId: number;
  PersonId: number;
  AccountName: string;
  PlatformName: string | null;
  AccountNumber: string | null;
  HolderName: string | null;
  LinkedBankAccountId: number | null;
  LoginId_Enc: string | null;
  Password_Enc: string | null;
  AssetClass: 'MF' | 'EQUITY' | 'BOND' | 'MIXED';
  Status: 'ACTIVE' | 'CLOSED';
  Notes: string | null;
}

export interface InvestmentAccountItem extends InvestmentAccount {
  PersonName: string;
  FolioCount: number;
}

export interface InvestmentAccountInput {
  PersonId: number;
  AccountName: string;
  PlatformName?: string;
  AccountNumber?: string;
  HolderName?: string;
  LinkedBankAccountId?: number | null;
  /** Plaintext; empty on update = keep. */
  LoginId?: string;
  Password?: string;
  AssetClass?: InvestmentAccount['AssetClass'];
  Status?: InvestmentAccount['Status'];
  Notes?: string;
}

const ACCOUNT_SQL = `
SELECT ia.*, TRIM(p.FirstName || ' ' || COALESCE(p.LastName, '')) AS PersonName,
       (SELECT COUNT(*) FROM MFFolio f WHERE f.InvestmentAccountId = ia.InvestmentAccountId) AS FolioCount
FROM InvestmentAccount ia JOIN Persons p ON p.PersonId = ia.PersonId`;

export function listInvestmentAccounts(includeClosed = false): InvestmentAccountItem[] {
  return all<InvestmentAccountItem>(
    `${ACCOUNT_SQL} ${includeClosed ? '' : "WHERE ia.Status = 'ACTIVE'"}
     ORDER BY ia.Status, p.PersonId, ia.AccountName`,
  );
}

export function getInvestmentAccount(id: number): InvestmentAccountItem | undefined {
  return one<InvestmentAccountItem>(`${ACCOUNT_SQL} WHERE ia.InvestmentAccountId = ?`, [id]);
}

export const investmentAccountLabel = (
  a: Pick<InvestmentAccountItem, 'AccountName' | 'PersonName'>,
) =>
  a.AccountName.includes(a.PersonName.split(' ')[0])
    ? a.AccountName
    : `${a.AccountName} (${a.PersonName})`;

async function accountValues(i: InvestmentAccountInput) {
  const [login, pw] = await Promise.all([
    i.LoginId ? encryptSecret(i.LoginId) : null,
    i.Password ? encryptSecret(i.Password) : null,
  ]);
  return {
    login,
    pw,
    values: [
      i.PersonId,
      i.AccountName.trim(),
      blankToNull(i.PlatformName),
      blankToNull(i.AccountNumber),
      blankToNull(i.HolderName),
      i.LinkedBankAccountId ?? null,
      i.AssetClass ?? 'MF',
      i.Status ?? 'ACTIVE',
      blankToNull(i.Notes),
    ],
  };
}

export async function createInvestmentAccount(i: InvestmentAccountInput): Promise<number> {
  if (!i.AccountName.trim()) throw new Error('Account name is required');
  const { login, pw, values } = await accountValues(i);
  return run(
    `INSERT INTO InvestmentAccount (PersonId, AccountName, PlatformName, AccountNumber, HolderName,
       LinkedBankAccountId, AssetClass, Status, Notes, LoginId_Enc, Password_Enc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...values, login, pw],
  ).lastId;
}

export async function updateInvestmentAccount(
  id: number,
  i: InvestmentAccountInput,
): Promise<void> {
  const { login, pw, values } = await accountValues(i);
  run(
    `UPDATE InvestmentAccount SET PersonId = ?, AccountName = ?, PlatformName = ?, AccountNumber = ?,
       HolderName = ?, LinkedBankAccountId = ?, AssetClass = ?, Status = ?, Notes = ?,
       LoginId_Enc = COALESCE(?, LoginId_Enc), Password_Enc = COALESCE(?, Password_Enc), UpdatedOn = ?
     WHERE InvestmentAccountId = ?`,
    [...values, login, pw, nowUtc(), id],
  );
}

// ---------------------------------------------------------------- folios

export type FolioRole = 'PRIMARY' | 'JOINT' | 'NOMINEE' | 'GUARDIAN';
export const FOLIO_ROLE_LABEL: Record<FolioRole, string> = {
  PRIMARY: 'Primary holder',
  JOINT: 'Joint holder',
  NOMINEE: 'Nominee',
  GUARDIAN: 'Guardian',
};

export interface Folio {
  FolioId: number;
  InvestmentAccountId: number;
  AMCName: string;
  FolioNumber: string;
  ModeOfHolding: 'SINGLE' | 'JOINT' | 'ANYONE_OR_SURVIVOR';
  BankAccountId: number | null;
  Status: 'ACTIVE' | 'CLOSED';
  Notes: string | null;
}

export interface FolioItem extends Folio {
  AccountName: string;
  PersonId: number;
  PersonName: string;
  Holders: string | null;
  HasGuardian: number;
}

export interface FolioPersonInput {
  PersonId: number;
  Role: FolioRole;
  SharePercent?: string | null;
}

export interface FolioPerson extends FolioPersonInput {
  FolioPersonId: number;
  PersonName: string;
}

const FOLIO_SQL = `
SELECT f.*, ia.AccountName, ia.PersonId, TRIM(p.FirstName || ' ' || COALESCE(p.LastName, '')) AS PersonName,
       (SELECT GROUP_CONCAT(pp.FirstName || ' (' || LOWER(fp.Role) || ')', ', ')
          FROM MFFolioPerson fp JOIN Persons pp ON pp.PersonId = fp.PersonId
         WHERE fp.FolioId = f.FolioId) AS Holders,
       EXISTS (SELECT 1 FROM MFFolioPerson g WHERE g.FolioId = f.FolioId AND g.Role = 'GUARDIAN') AS HasGuardian
FROM MFFolio f
JOIN InvestmentAccount ia ON ia.InvestmentAccountId = f.InvestmentAccountId
JOIN Persons p ON p.PersonId = ia.PersonId`;

export function listFolios(
  opts: { accountId?: number; includeClosed?: boolean } = {},
): FolioItem[] {
  const where: string[] = [];
  const params: number[] = [];
  if (opts.accountId) {
    where.push('f.InvestmentAccountId = ?');
    params.push(opts.accountId);
  }
  if (!opts.includeClosed) where.push("f.Status = 'ACTIVE'");
  return all<FolioItem>(
    `${FOLIO_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY f.AMCName, f.FolioNumber`,
    params,
  );
}

export function getFolio(id: number): FolioItem | undefined {
  return one<FolioItem>(`${FOLIO_SQL} WHERE f.FolioId = ?`, [id]);
}

export function findFolio(amc: string, folioNumber: string): Folio | undefined {
  return one<Folio>('SELECT * FROM MFFolio WHERE AMCName = ? AND FolioNumber = ?', [
    amc.trim(),
    normaliseFolio(folioNumber),
  ]);
}

/** "12345678 / 90" → "12345678/90" */
export const normaliseFolio = (s: string) =>
  s
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ')
    .trim();

export function listFolioPersons(folioId: number): FolioPerson[] {
  return all<FolioPerson>(
    `SELECT fp.*, TRIM(p.FirstName || ' ' || COALESCE(p.LastName, '')) AS PersonName
     FROM MFFolioPerson fp JOIN Persons p ON p.PersonId = fp.PersonId
     WHERE fp.FolioId = ?
     ORDER BY CASE fp.Role WHEN 'PRIMARY' THEN 1 WHEN 'JOINT' THEN 2 WHEN 'GUARDIAN' THEN 3 ELSE 4 END`,
    [folioId],
  );
}

/** One primary holder; a guardian is required when the primary holder is a minor. */
export function validateFolioPersons(persons: FolioPersonInput[]) {
  const primaries = persons.filter((p) => p.Role === 'PRIMARY');
  if (primaries.length !== 1) throw new Error('A folio needs exactly one primary holder');
  const keys = persons.map((p) => `${p.PersonId}|${p.Role}`);
  if (new Set(keys).size !== keys.length)
    throw new Error('Same person added twice with the same role');
  const dob = one<{ DateOfBirth: string | null }>(
    'SELECT DateOfBirth FROM Persons WHERE PersonId = ?',
    [primaries[0].PersonId],
  )?.DateOfBirth;
  const age = ageFrom(dob);
  if (age != null && age < 18 && !persons.some((p) => p.Role === 'GUARDIAN')) {
    throw new Error('The primary holder is a minor; add a guardian');
  }
  const share = persons
    .filter((p) => p.Role === 'NOMINEE' && p.SharePercent)
    .reduce((s, p) => s + Math.round(Number(p.SharePercent) * 100), 0);
  if (share > 10000) throw new Error('Nominee shares add up to more than 100%');
}

export interface FolioInput {
  InvestmentAccountId: number;
  AMCName: string;
  FolioNumber: string;
  ModeOfHolding?: Folio['ModeOfHolding'];
  BankAccountId?: number | null;
  Status?: Folio['Status'];
  Notes?: string;
}

function writeFolioPersons(folioId: number, persons: FolioPersonInput[]) {
  run('DELETE FROM MFFolioPerson WHERE FolioId = ?', [folioId]);
  for (const p of persons) {
    run('INSERT INTO MFFolioPerson (FolioId, PersonId, Role, SharePercent) VALUES (?, ?, ?, ?)', [
      folioId,
      p.PersonId,
      p.Role,
      p.Role === 'NOMINEE' ? blankToNull(p.SharePercent ?? '') : null,
    ]);
  }
}

export function createFolio(f: FolioInput, persons?: FolioPersonInput[]): number {
  const folioNumber = normaliseFolio(f.FolioNumber);
  if (!f.AMCName.trim() || !folioNumber) throw new Error('AMC and folio number are required');
  if (findFolio(f.AMCName, folioNumber)) throw new Error('This folio already exists');
  const owner = one<{ PersonId: number }>(
    'SELECT PersonId FROM InvestmentAccount WHERE InvestmentAccountId = ?',
    [f.InvestmentAccountId],
  );
  const ps = persons ?? (owner ? [{ PersonId: owner.PersonId, Role: 'PRIMARY' as const }] : []);
  if (persons) validateFolioPersons(ps);
  return tx(() => {
    const id = run(
      `INSERT INTO MFFolio (InvestmentAccountId, AMCName, FolioNumber, ModeOfHolding, BankAccountId, Status, Notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        f.InvestmentAccountId,
        f.AMCName.trim(),
        folioNumber,
        f.ModeOfHolding ?? 'SINGLE',
        f.BankAccountId ?? null,
        f.Status ?? 'ACTIVE',
        blankToNull(f.Notes),
      ],
    ).lastId;
    writeFolioPersons(id, ps);
    return id;
  });
}

export function updateFolio(id: number, f: FolioInput, persons: FolioPersonInput[]) {
  validateFolioPersons(persons);
  const folioNumber = normaliseFolio(f.FolioNumber);
  const dup = findFolio(f.AMCName, folioNumber);
  if (dup && dup.FolioId !== id) throw new Error('Another folio already has this AMC and number');
  tx(() => {
    run(
      `UPDATE MFFolio SET InvestmentAccountId = ?, AMCName = ?, FolioNumber = ?, ModeOfHolding = ?,
         BankAccountId = ?, Status = ?, Notes = ?, UpdatedOn = ? WHERE FolioId = ?`,
      [
        f.InvestmentAccountId,
        f.AMCName.trim(),
        folioNumber,
        f.ModeOfHolding ?? 'SINGLE',
        f.BankAccountId ?? null,
        f.Status ?? 'ACTIVE',
        blankToNull(f.Notes),
        nowUtc(),
        id,
      ],
    );
    writeFolioPersons(id, persons);
  });
}

/** Find a folio by AMC + number or create it under the given investment account. */
export function getOrCreateFolio(accountId: number, amc: string, folioNumber: string): number {
  const f = findFolio(amc, folioNumber);
  if (f) return f.FolioId;
  return createFolio({ InvestmentAccountId: accountId, AMCName: amc, FolioNumber: folioNumber });
}
