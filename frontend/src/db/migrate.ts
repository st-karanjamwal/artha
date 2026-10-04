import type { Database } from 'sql.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Bundled migrations: src/db/migrations/NNN_description.sql. Never edit an applied one. */
export function bundledMigrations(): Migration[] {
  const files = import.meta.glob('./migrations/*.sql', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  return Object.entries(files)
    .map(([path, sql]) => {
      const m = /\/(\d{3})_([\w-]+)\.sql$/.exec(path);
      if (!m) throw new Error(`Bad migration filename: ${path}`);
      return { version: Number(m[1]), name: m[2], sql };
    })
    .sort((a, b) => a.version - b.version);
}

export const LATEST_SCHEMA_VERSION = Math.max(0, ...bundledMigrations().map((m) => m.version));

export function schemaVersion(db: Database): number {
  db.run(`CREATE TABLE IF NOT EXISTS SchemaVersion (
    Version INTEGER PRIMARY KEY, Name TEXT NOT NULL, AppliedOn TEXT NOT NULL)`);
  const r = db.exec('SELECT COALESCE(MAX(Version), 0) FROM SchemaVersion');
  return Number(r[0].values[0][0]);
}

/** Apply pending migrations in order, each in its own transaction. Returns applied versions. */
export function migrate(db: Database, migrations: Migration[] = bundledMigrations()): number[] {
  const current = schemaVersion(db);
  const versions = migrations.map((m) => m.version);
  if (new Set(versions).size !== versions.length) throw new Error('Duplicate migration version');
  const latest = Math.max(0, ...versions);
  if (current > latest) {
    throw new Error(
      `Vault schema v${current} is newer than this app (v${latest}). Update the app first.`,
    );
  }
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.run('BEGIN');
    try {
      db.exec(m.sql);
      db.run('INSERT INTO SchemaVersion (Version, Name, AppliedOn) VALUES (?, ?, ?)', [
        m.version,
        m.name,
        new Date().toISOString(),
      ]);
      db.run('COMMIT');
    } catch (e) {
      db.run('ROLLBACK');
      throw new Error(`Migration ${m.version}_${m.name} failed: ${(e as Error).message}`, {
        cause: e,
      });
    }
    applied.push(m.version);
  }
  const fk = db.exec('PRAGMA foreign_key_check');
  if (fk.length) throw new Error('Foreign key check failed after migration');
  return applied;
}
