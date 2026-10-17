import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index';

/**
 * Applies migrations/*.sql in filename order; each runs once (tracked in schema_migrations). Serialised across nodes with a Postgres advisory lock.
 * Files named `*.pg.sql` only run against a real Postgres (not embedded PGlite).
 */
export const MIGRATION_LOCK_KEY = 727_001_001;
export async function migrate(db: Db, dir: string, log?: { info: (m: string) => void }) {
  // Two nodes booting together: the second waits here, then finds every migration already recorded and applies nothing.
  return db.withLock(MIGRATION_LOCK_KEY, () => run(db, dir, log));
}

async function run(db: Db, dir: string, log?: { info: (m: string) => void }) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    if (f.endsWith('.pg.sql') && db.kind !== 'pg') continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(name) VALUES ('${f.replace(/'/g, '')}');\nCOMMIT;`);
    log?.info(`applied migration ${f}`);
  }
}
