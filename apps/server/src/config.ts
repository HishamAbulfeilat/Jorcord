import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIMITS } from '@jorcord/shared';

export interface Config {
  env: string; isProd: boolean; host: string; port: number; logLevel: string;
  jwtSecret: string; databaseUrl: string | null; dataDir: string; redisUrl: string | null;
  corsOrigins: string[] | true; publicUrl: string; trustProxy: boolean; rateLimit: boolean;
  maxUploadBytes: number; heartbeatIntervalMs: number; resumeWindowMs: number;
  accessTtlSec: number; refreshTtlSec: number;
  livekit: { url: string; apiKey: string; apiSecret: string };
  tenorKey: string | null; giphyKey: string | null; unfurlOnSend: boolean; allowPrivateUnfurl: boolean;
  migrationsDir: string;
}

const here = new URL('.', import.meta.url).pathname;

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = (env.NODE_ENV ?? 'development') === 'production';
  const dataDir = resolve(overrides.dataDir ?? env.DATA_DIR ?? './data');
  let jwtSecret = overrides.jwtSecret ?? env.JWT_SECRET ?? '';
  if (!jwtSecret) {
    if (isProd) throw new Error('JWT_SECRET is required in production');
    mkdirSync(dataDir, { recursive: true });
    const p = join(dataDir, 'secret');
    if (existsSync(p)) jwtSecret = readFileSync(p, 'utf8').trim();
    else { jwtSecret = randomBytes(48).toString('hex'); writeFileSync(p, jwtSecret, { mode: 0o600 }); }
  }
  if (jwtSecret.length < 16) throw new Error('JWT_SECRET too short');
  const cors = env.CORS_ORIGINS ?? '*';
  const cfg: Config = {
    env: env.NODE_ENV ?? 'development', isProd,
    host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 3000), logLevel: env.LOG_LEVEL ?? 'info',
    jwtSecret, databaseUrl: env.DATABASE_URL || null, dataDir, redisUrl: env.REDIS_URL || null,
    corsOrigins: cors === '*' ? true : cors.split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:3000',
    trustProxy: env.TRUST_PROXY === 'true',
    rateLimit: env.RATE_LIMIT_ENABLED !== 'false',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || LIMITS.maxUploadBytes),
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? 30_000),
    resumeWindowMs: 5 * 60_000, accessTtlSec: 15 * 60, refreshTtlSec: 30 * 24 * 3600,
    livekit: {
      url: env.LIVEKIT_URL ?? 'ws://localhost:7880',
      apiKey: env.LIVEKIT_API_KEY ?? 'devkey', apiSecret: env.LIVEKIT_API_SECRET ?? 'secret',
    },
    tenorKey: env.TENOR_API_KEY || null, giphyKey: env.GIPHY_API_KEY || null,
    unfurlOnSend: true, allowPrivateUnfurl: false,
    migrationsDir: resolve(here, '../migrations'),
  };
  return { ...cfg, ...overrides };
}
