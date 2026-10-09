import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config';

export interface Queryable { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> }
export interface Db extends Queryable {
  kind: 'pg' | 'pglite';
  exec(sql: string): Promise<void>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDb(cfg: Pick<Config, 'databaseUrl' | 'dataDir'> & { memory?: boolean }): Promise<Db> {
  if (cfg.databaseUrl) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: cfg.databaseUrl, max: 10 });
    return {
      kind: 'pg',
      async query(sql, params) { return (await pool.query(sql, params as any[])).rows; },
      async exec(sql) { await pool.query(sql); },
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn({ query: async (s, p) => (await c.query(s, p as any[])).rows });
          await c.query('COMMIT');
          return r;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      },
      close: () => pool.end(),
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  let dir: string | undefined;
  if (!cfg.memory) { dir = join(cfg.dataDir, 'db'); mkdirSync(cfg.dataDir, { recursive: true }); }
  const lite = new PGlite(dir);
  await lite.waitReady;
  return {
    kind: 'pglite',
    async query(sql, params) { return (await lite.query(sql, params as any[])).rows as any[]; },
    async exec(sql) { await lite.exec(sql); },
    async tx(fn) { return lite.transaction(async (t) => fn({ query: async (s, p) => (await t.query(s, p as any[])).rows as any[] })); },
    close: () => lite.close(),
  };
}
