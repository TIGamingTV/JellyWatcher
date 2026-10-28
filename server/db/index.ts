import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';

export type DB = Database.Database;

export const nowIso = (): string => new Date().toISOString();

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled build: dist/server/migrations. Source tree: server/db/migrations.
  for (const candidate of [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Migrations directory not found near ${here}`);
}

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  return db;
}

/**
 * Applies pending SQL migrations in order. Before migrating an existing database a
 * consistent copy is written to <dataDir>/backups so an upgrade can always be rolled back.
 */
export async function migrate(db: DB, opts: { backupDir?: string; log?: Logger; dir?: string } = {}): Promise<string[]> {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const dir = opts.dir ?? migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) return [];

  if (applied.size > 0 && opts.backupDir) {
    fs.mkdirSync(opts.backupDir, { recursive: true });
    const target = path.join(opts.backupDir, `pre-migration-${nowIso().replace(/[:.]/g, '-')}.db`);
    await db.backup(target);
    opts.log?.info({ target }, 'database backed up before migration');
  }

  for (const file of pending) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(file, nowIso());
    })();
    opts.log?.info({ migration: file }, 'migration applied');
  }
  return pending;
}

/** Parses a JSON column, returning the fallback on null or malformed content. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
