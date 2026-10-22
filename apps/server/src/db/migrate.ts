import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './index';

/**
 * Applies migrations/*.sql in filename order; each runs once (tracked in schema_migrations). Serialised across nodes with a Postgres advisory lock.
 * Files named `*.pg.sql` only run against a real Postgres (not embedded PGlite).
 * Files named `*.concurrent.sql` hold ONLY `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS ...` / `DROP INDEX CONCURRENTLY IF EXISTS ...`
 * statements. On Postgres they run one statement at a time OUTSIDE a transaction (CONCURRENTLY cannot run inside one), so
 * building an index never takes a write lock; the migration is recorded only after every statement succeeded, and because every
 * statement is idempotent a crash part-way simply re-runs it. A half-built (INVALID) index left by a failed attempt is dropped and
 * rebuilt. On PGlite (tests/dev, single process, no concurrent writers) CONCURRENTLY is stripped and the file runs transactionally.
 * Use this suffix for every future index migration on a populated table. See docs/OPERATIONS.md.
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
    if (f.endsWith('.concurrent.sql') && db.kind === 'pg') { await runConcurrent(db, f, sql); log?.info(`applied migration ${f} (concurrent)`); continue; }
    if (f.endsWith('.concurrent.sql')) { await runTx(db, f, stripConcurrently(sql)); log?.info(`applied migration ${f}`); continue; }
    await runTx(db, f, sql);
    log?.info(`applied migration ${f}`);
  }
}

const record = (f: string) => `INSERT INTO schema_migrations(name) VALUES ('${f.replace(/'/g, '')}')`;
async function runTx(db: Db, f: string, sql: string) {
  await db.exec(`BEGIN;\n${sql}\n${record(f)};\nCOMMIT;`);
}

const stripComments = (sql: string) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
export const stripConcurrently = (sql: string) => sql.replace(/\b(INDEX)\s+CONCURRENTLY\b/gi, '$1');
const CREATE_RE = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+("?[a-z_][a-z0-9_]*"?)\s/i;
const DROP_RE = /^DROP\s+INDEX\s+CONCURRENTLY\s+IF\s+EXISTS\s+"?[a-z_][a-z0-9_]*"?$/i;

/** Splits and validates a `.concurrent.sql` file into its statements (exported for tests). */
export function concurrentStatements(f: string, sql: string): string[] {
  const stmts = stripComments(sql).split(';').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
  for (const st of stmts) if (!CREATE_RE.test(st + ' ') && !DROP_RE.test(st)) throw new Error(`${f}: only idempotent CREATE INDEX CONCURRENTLY IF NOT EXISTS / DROP INDEX CONCURRENTLY IF EXISTS statements are allowed in a .concurrent.sql migration (got: ${st.slice(0, 80)})`);
  return stmts;
}

async function runConcurrent(db: Db, f: string, sql: string) {
  for (const st of concurrentStatements(f, sql)) {
    const m = CREATE_RE.exec(st + ' ');
    if (m) {
      const name = m[1]!.replace(/"/g, '');
      // a previous attempt that died mid-build leaves an INVALID index that IF NOT EXISTS would silently keep
      const bad = await db.query(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND NOT i.indisvalid`, [name.toLowerCase()]);
      if (bad.length) await db.exec(`DROP INDEX CONCURRENTLY IF EXISTS "${name.toLowerCase()}"`);
    }
    await db.exec(st);
  }
  await db.exec(record(f));
}
