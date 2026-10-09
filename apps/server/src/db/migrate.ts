import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index';

/** Applies migrations/*.sql in filename order; each runs once (tracked in schema_migrations). */
export async function migrate(db: Db, dir: string, log?: { info: (m: string) => void }) {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.exec(`BEGIN;\n${sql}\nINSERT INTO schema_migrations(name) VALUES ('${f.replace(/'/g, '')}');\nCOMMIT;`);
    log?.info(`applied migration ${f}`);
  }
}
