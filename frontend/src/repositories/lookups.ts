import { all, one, run } from '@/db/sql';

export interface Lookup {
  LookupValueId: number;
  Category: string;
  Code: string;
  Label: string;
  SortOrder: number;
  IsActive: number;
}

export const LOOKUP_CATEGORIES = [
  'Relationship',
  'Gender',
  'AccountType',
  'AccountRole',
  'CredentialChannel',
  'TxnMode',
  'InvestmentPlatform',
] as const;
export type LookupCategory = (typeof LOOKUP_CATEGORIES)[number];

export function listLookups(category: LookupCategory, includeInactive = false): Lookup[] {
  return all<Lookup>(
    `SELECT * FROM LookupValues WHERE Category = ? ${includeInactive ? '' : 'AND IsActive = 1'}
     ORDER BY SortOrder, Label`,
    [category],
  );
}

export function lookupLabel(category: LookupCategory, code: string | null | undefined): string {
  if (!code) return '';
  return (
    one<{ Label: string }>('SELECT Label FROM LookupValues WHERE Category = ? AND Code = ?', [
      category,
      code,
    ])?.Label ?? code
  );
}

export function addLookup(category: LookupCategory, label: string): number {
  const code = label.trim().replace(/[^A-Za-z0-9]+/g, '');
  if (!code) throw new Error('Label must contain letters or numbers');
  if (one('SELECT 1 FROM LookupValues WHERE Category = ? AND Code = ?', [category, code])) {
    throw new Error(`"${label}" already exists`);
  }
  const max = one<{ m: number }>(
    'SELECT COALESCE(MAX(SortOrder), 0) AS m FROM LookupValues WHERE Category = ?',
    [category],
  )!.m;
  return run('INSERT INTO LookupValues (Category, Code, Label, SortOrder) VALUES (?, ?, ?, ?)', [
    category,
    code,
    label.trim(),
    max + 1,
  ]).lastId;
}

export function updateLookup(id: number, label: string, isActive: boolean) {
  run('UPDATE LookupValues SET Label = ?, IsActive = ? WHERE LookupValueId = ?', [
    label.trim(),
    isActive,
    id,
  ]);
}
