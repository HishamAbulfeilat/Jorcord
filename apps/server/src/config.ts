import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LIMITS } from '@jorcord/shared';

export interface Config {
  env: string; isProd: boolean; host: string; port: number; logLevel: string;
  jwtSecret: string; databaseUrl: string | null; dataDir: string; redisUrl: string | null;
  /** Namespace for every Redis key / channel, so several Jorcord clusters can share one Redis. */
  redisPrefix: string;
  corsOrigins: string[] | true; publicUrl: string; trustProxy: boolean; rateLimit: boolean;
  maxUploadBytes: number; heartbeatIntervalMs: number; resumeWindowMs: number;
  /** How long a user stays in voice after their last gateway socket drops (0 = clear immediately). */
  voiceGraceMs: number;
  accessTtlSec: number; refreshTtlSec: number;
  /** `url` is what clients connect to (handed out in voice tokens); `apiUrl` is how this server reaches LiveKit's RoomService. */
  livekit: { url: string; apiUrl: string; apiKey: string; apiSecret: string };
  tenorKey: string | null; giphyKey: string | null; unfurlOnSend: boolean; allowPrivateUnfurl: boolean;
  migrationsDir: string;
  /** SMTP connection URL (smtp://user:pass@host:587). Without it, mail is logged (dev) or dropped (prod). */
  smtpUrl: string | null; mailFrom: string;
  /** 'auto' = full-text search on Postgres, ILIKE on PGlite. */
  searchMode: 'auto' | 'fts' | 'ilike';
  storage: { driver: 'local' | 's3'; s3: { bucket: string; region: string; endpoint: string | null; accessKeyId: string | null; secretAccessKey: string | null; forcePathStyle: boolean; prefix: string } };
  /** Skip calls to the LiveKit RoomService (tests / deployments without a LiveKit API reachable from the server). */
  livekitControl: boolean;
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
    jwtSecret, databaseUrl: env.DATABASE_URL || null, dataDir, redisUrl: env.REDIS_URL || null, redisPrefix: env.REDIS_PREFIX || 'jorcord',
    corsOrigins: cors === '*' ? true : cors.split(',').map((s) => s.trim()).filter(Boolean),
    publicUrl: env.PUBLIC_URL ?? 'http://localhost:3000',
    trustProxy: env.TRUST_PROXY === 'true',
    rateLimit: env.RATE_LIMIT_ENABLED !== 'false',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || LIMITS.maxUploadBytes),
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? 30_000),
    resumeWindowMs: 5 * 60_000, voiceGraceMs: Number(env.VOICE_GRACE_MS ?? 20_000), accessTtlSec: 15 * 60, refreshTtlSec: 30 * 24 * 3600,
    livekit: {
      url: env.LIVEKIT_URL ?? 'ws://localhost:7880',
      apiUrl: env.LIVEKIT_API_URL ?? env.LIVEKIT_URL ?? 'ws://localhost:7880',
      apiKey: env.LIVEKIT_API_KEY ?? 'devkey', apiSecret: env.LIVEKIT_API_SECRET ?? 'secret',
    },
    tenorKey: env.TENOR_API_KEY || null, giphyKey: env.GIPHY_API_KEY || null,
    unfurlOnSend: true, allowPrivateUnfurl: false,
    migrationsDir: resolve(here, '../migrations'),
    smtpUrl: env.SMTP_URL || null, mailFrom: env.MAIL_FROM ?? 'Jorcord <no-reply@localhost>',
    searchMode: (['fts', 'ilike'].includes(env.SEARCH_MODE ?? '') ? env.SEARCH_MODE : 'auto') as Config['searchMode'],
    storage: {
      driver: (env.STORAGE_DRIVER ?? (env.S3_BUCKET ? 's3' : 'local')) === 's3' ? 's3' : 'local',
      s3: {
        bucket: env.S3_BUCKET ?? '', region: env.S3_REGION ?? 'us-east-1', endpoint: env.S3_ENDPOINT || null,
        accessKeyId: env.S3_ACCESS_KEY_ID || null, secretAccessKey: env.S3_SECRET_ACCESS_KEY || null,
        forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true', prefix: env.S3_PREFIX ?? '',
      },
    },
    livekitControl: env.LIVEKIT_CONTROL !== 'false',
  };
  return { ...cfg, ...overrides };
}
