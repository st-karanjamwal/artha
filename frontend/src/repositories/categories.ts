import { all, run } from '@/db/sql';

export type CategoryKind = 'Income' | 'Expense' | 'Transfer' | 'Investment';
export const CATEGORY_KINDS: CategoryKind[] = ['Income', 'Expense', 'Transfer', 'Investment'];

export interface Category {
  CategoryId: number;
  Name: string;
  ParentCategoryId: number | null;
  Kind: CategoryKind;
  IsActive: number;
  /** "Utilities › Electricity" */
  FullName: string;
}

export function listCategories(includeInactive = false): Category[] {
  return all<Category>(
    `SELECT c.*, CASE WHEN p.Name IS NULL THEN c.Name ELSE p.Name || ' › ' || c.Name END AS FullName
     FROM Categories c LEFT JOIN Categories p ON p.CategoryId = c.ParentCategoryId
     ${includeInactive ? '' : 'WHERE c.IsActive = 1'}
     ORDER BY CASE c.Kind WHEN 'Income' THEN 1 WHEN 'Expense' THEN 2 WHEN 'Investment' THEN 3 ELSE 4 END,
              FullName`,
  );
}

export function createCategory(name: string, kind: CategoryKind, parentId: number | null) {
  return run('INSERT INTO Categories (Name, Kind, ParentCategoryId) VALUES (?, ?, ?)', [
    name.trim(),
    kind,
    parentId,
  ]).lastId;
}

export function updateCategory(id: number, name: string, kind: CategoryKind, isActive: boolean) {
  run('UPDATE Categories SET Name = ?, Kind = ?, IsActive = ? WHERE CategoryId = ?', [
    name.trim(),
    kind,
    isActive,
    id,
  ]);
}

export function transferCategoryId(): number | null {
  return (
    all<{ CategoryId: number }>(
      "SELECT CategoryId FROM Categories WHERE Kind = 'Transfer' AND IsActive = 1 ORDER BY CategoryId LIMIT 1",
    )[0]?.CategoryId ?? null
  );
}
