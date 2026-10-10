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
  /** Directory with the built web client (apps/web/dist). null = API only (dev). The Docker image sets WEB_DIST=/app/web. */
  webDist: string | null;
  /** SMTP connection URL (smtp://user:pass@host:587). Without it, mail is logged (dev) or dropped (prod). */
  smtpUrl: string | null; mailFrom: string;
  /** 'auto' = full-text search on Postgres, ILIKE on PGlite. */
  searchMode: 'auto' | 'fts' | 'ilike';
  storage: { driver: 'local' | 's3'; s3: { bucket: string; region: string; endpoint: string | null; accessKeyId: string | null; secretAccessKey: string | null; forcePathStyle: boolean; prefix: string } };
  /** Skip calls to the LiveKit RoomService (tests / deployments without a LiveKit API reachable from the server). */
  livekitControl: boolean;
  push: PushConfig;
  /** Background lifecycle sweeps (poll expiry, event start/end, thread auto-archive, stage cleanup). 0 disables the timer (tests call runSweeps directly). */
  sweepIntervalMs: number;
}

export interface PushConfig {
  /** Web Push (VAPID). Keys are generated into DATA_DIR/vapid.json when not supplied. */
  vapid: { publicKey: string | null; privateKey: string | null; subject: string };
  /** Raw FCM service-account JSON (Android; also iOS tokens issued by Firebase). null = FCM disabled. */
  fcmServiceAccount: string | null;
  /** APNs token auth (.p8). null = direct APNs disabled. */
  apns: { key: string; keyId: string; teamId: string; topic: string; production: boolean } | null;
}

/** Origins of the native wrappers and local dev servers; always allowed unless CORS_ORIGINS is '*'. */
export const DEFAULT_CORS_ORIGINS = [
  'capacitor://localhost', 'https://localhost', 'http://localhost', 'tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:5173',
];

const readMaybeFile = (inline: string | undefined, file: string | undefined): string | null => {
  if (inline?.trim()) return inline.trim();
  if (file) { try { return readFileSync(file, 'utf8'); } catch { return null; } }
  return null;
};

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
  if (isProd && jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
  const publicUrl = env.PUBLIC_URL ?? 'http://localhost:3000';
  let publicOrigin: string | null = null; try { publicOrigin = new URL(publicUrl).origin; } catch { /* invalid PUBLIC_URL is reported elsewhere */ }
  const corsEnv = env.CORS_ORIGINS?.trim();
  const corsOrigins: string[] | true = corsEnv === '*' ? true
    : [...new Set([...(corsEnv ? corsEnv.split(',').map((s) => s.trim()).filter(Boolean) : []), ...DEFAULT_CORS_ORIGINS, ...(publicOrigin ? [publicOrigin] : [])])];
  const apnsKey = readMaybeFile(env.APNS_KEY?.replace(/\\n/g, '\n'), env.APNS_KEY_FILE);
  const cfg: Config = {
    env: env.NODE_ENV ?? 'development', isProd,
    host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 3000), logLevel: env.LOG_LEVEL ?? 'info',
    jwtSecret, databaseUrl: env.DATABASE_URL || null, dataDir, redisUrl: env.REDIS_URL || null, redisPrefix: env.REDIS_PREFIX || 'jorcord',
    corsOrigins, publicUrl,
    trustProxy: env.TRUST_PROXY === 'true',
    rateLimit: env.RATE_LIMIT_ENABLED !== 'false',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES || LIMITS.maxUploadBytes),
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? 30_000),
    resumeWindowMs: 5 * 60_000, voiceGraceMs: Number(env.VOICE_GRACE_MS ?? 20_000), accessTtlSec: 15 * 60, refreshTtlSec: 30 * 24 * 3600,
    livekit: {
      url: env.LIVEKIT_URL ?? 'ws://localhost:7880',
      apiUrl: env.LIVEKIT_API_URL ?? (env.LIVEKIT_URL && env.LIVEKIT_URL.trim().toLowerCase() !== 'auto' ? env.LIVEKIT_URL : 'ws://localhost:7880'),
      apiKey: env.LIVEKIT_API_KEY ?? 'devkey', apiSecret: env.LIVEKIT_API_SECRET ?? 'secret',
    },
    tenorKey: env.TENOR_API_KEY || null, giphyKey: env.GIPHY_API_KEY || null,
    unfurlOnSend: true, allowPrivateUnfurl: false,
    migrationsDir: resolve(here, '../migrations'),
    webDist: env.WEB_DIST?.trim() ? resolve(env.WEB_DIST.trim()) : null,
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
    livekitControl: env.LIVEKIT_CONTROL !== 'false', sweepIntervalMs: Number(env.SWEEP_INTERVAL_MS ?? 10_000),
    push: {
      vapid: { publicKey: env.VAPID_PUBLIC_KEY || null, privateKey: env.VAPID_PRIVATE_KEY || null, subject: env.VAPID_SUBJECT || (publicUrl.startsWith('https://') ? publicUrl : 'mailto:admin@example.com') },
      fcmServiceAccount: readMaybeFile(env.FCM_SERVICE_ACCOUNT, env.FCM_SERVICE_ACCOUNT_FILE),
      apns: apnsKey && env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_BUNDLE_ID
        ? { key: apnsKey, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, topic: env.APNS_BUNDLE_ID, production: env.APNS_PRODUCTION === 'true' } : null,
    },
  };
  return { ...cfg, ...overrides };
}
