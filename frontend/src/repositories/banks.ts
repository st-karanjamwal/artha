import { all, one, run } from '@/db/sql';
import { nowUtc } from '@/lib/dates';
import { blankToNull } from '@/lib/validators';

export interface Bank {
  BankId: number;
  BankName: string;
  BranchName: string | null;
  BranchAddress: string | null;
  IFSCCode: string | null;
  MICRCode: string | null;
  SwiftCode: string | null;
  BranchPhone: string | null;
  RelationshipManager: string | null;
  RMPhone: string | null;
  CustomerCareNo: string | null;
  Website: string | null;
  Notes: string | null;
  CreatedOn: string;
  UpdatedOn: string;
  IsActive: number;
}

export type BankInput = Omit<Bank, 'BankId' | 'CreatedOn' | 'UpdatedOn' | 'IsActive'>;

export interface BankListItem extends Bank {
  AccountCount: number;
}

export const bankLabel = (b: Pick<Bank, 'BankName' | 'BranchName'>) =>
  b.BranchName ? `${b.BankName} – ${b.BranchName}` : b.BankName;

export function listBanks(includeInactive = false): BankListItem[] {
  return all<BankListItem>(
    `SELECT b.*, (SELECT COUNT(*) FROM Accounts a WHERE a.BankId = b.BankId AND a.IsActive = 1)
       AS AccountCount
     FROM Banks b ${includeInactive ? '' : 'WHERE b.IsActive = 1'}
     ORDER BY b.IsActive DESC, b.BankName, b.BranchName`,
  );
}

export function getBank(id: number): Bank | undefined {
  return one<Bank>('SELECT * FROM Banks WHERE BankId = ?', [id]);
}

const COLS = [
  'BankName',
  'BranchName',
  'BranchAddress',
  'IFSCCode',
  'MICRCode',
  'SwiftCode',
  'BranchPhone',
  'RelationshipManager',
  'RMPhone',
  'CustomerCareNo',
  'Website',
  'Notes',
] as const;

function values(input: BankInput) {
  return COLS.map((c) => {
    const v = blankToNull(input[c]);
    return v && ['IFSCCode', 'MICRCode', 'SwiftCode'].includes(c) ? v.toUpperCase() : v;
  });
}

export function createBank(input: BankInput): number {
  const now = nowUtc();
  return run(
    `INSERT INTO Banks (${COLS.join(', ')}, CreatedOn, UpdatedOn)
     VALUES (${COLS.map(() => '?').join(', ')}, ?, ?)`,
    [...values(input), now, now],
  ).lastId;
}

export function updateBank(id: number, input: BankInput) {
  run(
    `UPDATE Banks SET ${COLS.map((c) => `${c} = ?`).join(', ')}, UpdatedOn = ? WHERE BankId = ?`,
    [...values(input), nowUtc(), id],
  );
}

export function setBankActive(id: number, active: boolean) {
  run('UPDATE Banks SET IsActive = ?, UpdatedOn = ? WHERE BankId = ?', [active, nowUtc(), id]);
}
