import type { Database, SqlValue } from 'sql.js';

/** Query helpers over the in-memory, unlocked database. */

type Param = SqlValue | undefined | boolean;
export type Params = Param[];

let current: Database | null = null;
let txDepth = 0;
let pendingChange = false;
const listeners = new Set<() => void>();

export function setDb(db: Database | null) {
  current = db;
  txDepth = 0;
  pendingChange = false;
}

export function getDb(): Database {
  if (!current) throw new Error('Vault is locked');
  return current;
}

export function hasDb() {
  return current !== null;
}

/** Subscribe to data changes (used by autosave and UI refresh). */
export function onDbChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  if (txDepth > 0) {
    pendingChange = true;
    return;
  }
  pendingChange = false;
  listeners.forEach((l) => l());
}

function norm(params: Params = []): SqlValue[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function all<T = Record<string, SqlValue>>(sql: string, params?: Params): T[] {
  const stmt = getDb().prepare(sql);
  try {
    stmt.bind(norm(params));
    const rows: T[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as T);
    return rows;
  } finally {
    stmt.free();
  }
}

export function one<T = Record<string, SqlValue>>(sql: string, params?: Params): T | undefined {
  return all<T>(sql, params)[0];
}

export function scalar<T = SqlValue>(sql: string, params?: Params): T | undefined {
  const r = one<Record<string, SqlValue>>(sql, params);
  return r ? (Object.values(r)[0] as T) : undefined;
}

/** Execute a write. Returns rows changed and last insert id. */
export function run(sql: string, params?: Params): { changes: number; lastId: number } {
  const db = getDb();
  db.run(sql, norm(params));
  const changes = db.getRowsModified();
  const lastId = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
  notify();
  return { changes, lastId };
}

/** Run `fn` in a transaction (nesting-safe). Change listeners fire once on commit. */
export function tx<T>(fn: () => T): T {
  const db = getDb();
  if (txDepth === 0) db.run('BEGIN');
  txDepth++;
  try {
    const result = fn();
    txDepth--;
    if (txDepth === 0) {
      db.run('COMMIT');
      if (pendingChange) notify();
    }
    return result;
  } catch (e) {
    txDepth--;
    if (txDepth === 0) {
      db.run('ROLLBACK');
      pendingChange = false;
    }
    throw e;
  }
}
