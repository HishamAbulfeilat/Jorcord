import type { FastifyBaseLogger } from 'fastify';
import type { Config } from './config';
import type { Db } from './db';
import type { EventBus } from './bus';
import type { Storage } from './storage';
import type { Hub } from './gateway/hub';
import type { RateLimiter } from './lib/ratelimit';

export interface Ctx { config: Config; db: Db; bus: EventBus; storage: Storage; hub: Hub; rl: RateLimiter; log: FastifyBaseLogger }
