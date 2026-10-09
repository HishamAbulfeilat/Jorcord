import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Db } from './db';
import type { EventBus } from './bus';
import type { Storage } from './storage';
import type { Hub } from './gateway/hub';
import type { RateLimiter } from './lib/ratelimit';
import type { PresenceStore, VoiceStore } from './state';
import type { LiveKitControl } from './services/livekit';
import type { Mailer } from './services/mailer';

export interface Ctx { config: Config; db: Db; bus: EventBus; storage: Storage; hub: Hub; rl: RateLimiter; log: FastifyBaseLogger;
  voice: VoiceStore; presence: PresenceStore; livekit: LiveKitControl; mailer: Mailer;
  /** Message search backend: Postgres full-text (pg) or ILIKE (PGlite). */
  search: 'fts' | 'ilike';
}
