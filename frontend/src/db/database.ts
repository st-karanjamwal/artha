import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

let sqlPromise: Promise<SqlJsStatic> | null = null;
let wasmUrl: string | undefined;

/** Browser entry sets the bundled wasm URL (no CDN). Node/tests use the default resolution. */
export function configureWasm(url: string) {
  wasmUrl = url;
}

export function getSql(): Promise<SqlJsStatic> {
  sqlPromise ??= initSqlJs(wasmUrl ? { locateFile: () => wasmUrl! } : undefined);
  return sqlPromise;
}

export function applyPragmas(db: Database) {
  db.run('PRAGMA foreign_keys = ON;');
}

export async function openDb(bytes?: Uint8Array): Promise<Database> {
  const SQL = await getSql();
  const db = new SQL.Database(bytes);
  applyPragmas(db);
  return db;
}

/** sql.js export() closes/reopens the DB, which resets pragmas — re-apply them. */
export function exportDb(db: Database): Uint8Array {
  const bytes = db.export();
  applyPragmas(db);
  return bytes;
}
