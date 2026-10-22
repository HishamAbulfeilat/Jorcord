import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concurrentStatements, migrate, stripConcurrently } from '../src/db/migrate';
import { createDb, type Db } from '../src/db';

describe('non-transactional index migrations', () => {
  it('only accepts idempotent CONCURRENTLY index statements', () => {
    expect(concurrentStatements('x.concurrent.sql', '-- c\nCREATE INDEX CONCURRENTLY IF NOT EXISTS a_idx ON t (a); -- t\nCREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS b_idx ON t (b) WHERE b IS NOT NULL;\nDROP INDEX CONCURRENTLY IF EXISTS old_idx;')).toHaveLength(3);
    for (const bad of ['CREATE INDEX a_idx ON t (a)', 'CREATE INDEX CONCURRENTLY a_idx ON t (a)', 'ALTER TABLE t ADD COLUMN x int', 'DROP TABLE t', 'CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t(a); DELETE FROM t'])
      expect(() => concurrentStatements('x.concurrent.sql', bad)).toThrow();
    expect(stripConcurrently('CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON t (a)')).toBe('CREATE INDEX IF NOT EXISTS i ON t (a)');
  });

  it('runs statement by statement outside a transaction on Postgres and records the migration last', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    try {
      writeFileSync(join(dir, '001_t.sql'), 'CREATE TABLE t (a int);');
      writeFileSync(join(dir, '002_idx.concurrent.sql'), 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_a ON t (a);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS t_b ON t (a, a);');
      const calls: string[] = [];
      const db: Db = {
        kind: 'pg', async query(sql) { calls.push(`Q ${sql.slice(0, 20)}`); return sql.startsWith('SELECT name') ? [] : sql.includes('indisvalid') ? [{ x: 1 }] : []; },
        async exec(sql) { calls.push(`E ${sql.split('\n')[0]!.slice(0, 40)}`); }, async tx() { throw new Error('no tx'); }, withLock: (_k, fn) => fn(), close: async () => {},
      };
      await migrate(db, dir);
      const concurrent = calls.filter((c) => c.includes('INDEX') || c.includes('002'));
      expect(concurrent.some((c) => c.includes('BEGIN'))).toBe(false);
      // the invalid-index probe made it drop and rebuild before each create; the record comes last
      expect(calls.filter((c) => c.startsWith('E DROP INDEX CONCURRENTLY'))).toHaveLength(2);
      expect(calls.filter((c) => c.startsWith('E CREATE INDEX CONCURRENTLY'))).toHaveLength(2);
      expect(calls.at(-1)).toContain('INSERT INTO schema_migrations');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('applies the same file transactionally on PGlite and creates the index', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    const db = await createDb({ databaseUrl: undefined as any, dataDir: dir, memory: true });
    try {
      writeFileSync(join(dir, '001_t.sql'), 'CREATE TABLE t (a int);');
      writeFileSync(join(dir, '002_idx.concurrent.sql'), 'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_a ON t (a);');
      await migrate(db, dir);
      expect(await db.query(`SELECT 1 FROM pg_indexes WHERE indexname = 't_a'`)).toHaveLength(1);
      expect((await db.query('SELECT name FROM schema_migrations ORDER BY name')).map((r: any) => r.name)).toEqual(['001_t.sql', '002_idx.concurrent.sql']);
      await migrate(db, dir); // idempotent
    } finally { await db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
