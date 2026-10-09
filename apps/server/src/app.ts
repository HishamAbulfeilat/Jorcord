import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authenticate } from './auth';
import { createBus } from './bus';
import { loadConfig, type Config } from './config';
import type { Ctx } from './ctx';
import { createDb } from './db';
import { migrate } from './db/migrate';
import { ApiError } from './errors';
import { Hub } from './gateway/hub';
import { gatewayRoutes } from './gateway/ws';
import { RateLimiter, installRateLimit } from './lib/ratelimit';
import { authRoutes, publicAuthRoutes } from './routes/auth';
import { channelRoutes, webhookPublicRoutes } from './routes/channels';
import { guildRoutes } from './routes/guilds';
import { invitePublicRoutes, memberRoutes } from './routes/members';
import { messageRoutes } from './routes/messages';
import { fileRoutes, miscRoutes, voiceWebhookRoutes } from './routes/misc';
import { userRoutes } from './routes/users';
import { voiceRoutes } from './routes/voice';
import { createStorage } from './storage';
import { createState } from './state';
import { createLiveKitControl } from './services/livekit';
import { createMailer } from './services/mailer';

export interface BuildOptions { config?: Partial<Config>; memoryDb?: boolean; env?: NodeJS.ProcessEnv }

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const config = loadConfig(opts.config, opts.env);
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: config.trustProxy, bodyLimit: 1_048_576, genReqId: () => crypto.randomUUID(),
  });
  const db = await createDb({ ...config, memory: opts.memoryDb });
  await migrate(db, config.migrationsDir, app.log);
  const bus = await createBus(config.redisUrl);
  const hub = new Hub();
  const rl = new RateLimiter();
  const state = await createState(config.redisUrl, config.redisPrefix);
  const ctx: Ctx = {
    config, db, bus, storage: await createStorage(config), hub, rl, log: app.log,
    voice: state.voice, presence: state.presence, livekit: createLiveKitControl(config, app.log), mailer: await createMailer(config, app.log),
    search: config.searchMode === 'auto' ? (db.kind === 'pg' ? 'fts' : 'ilike') : config.searchMode,
  };
  await hub.init(ctx);

  await app.register(cors, { origin: config.corsOrigins, credentials: false, exposedHeaders: ['retry-after', 'content-range', 'accept-ranges'] });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 10, fields: 20, fieldSize: 64 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  installRateLimit(app, rl, config.rateLimit);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.status).send(err.toBody());
    }
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' });
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ code: String(err.code ?? 'BAD_REQUEST'), message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL', message: 'Internal server error' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found' }));

  app.get('/health', async (_req, reply) => {
    try { await db.query('SELECT 1'); return { status: 'ok', db: db.kind, uptime: Math.round(process.uptime()), sessions: hub.sessions.size }; }
    catch { return reply.code(503).send({ status: 'degraded', db: 'down' }); }
  });
  gatewayRoutes(app, ctx);

  await app.register(async (api) => {
    publicAuthRoutes(api, ctx);
    invitePublicRoutes(api, ctx);
    webhookPublicRoutes(api, ctx);
    fileRoutes(api, ctx);
    await api.register(async (scope) => voiceWebhookRoutes(scope, ctx));
    await api.register(async (priv) => {
      priv.addHook('preHandler', authenticate(ctx));
      authRoutes(priv, ctx); userRoutes(priv, ctx); guildRoutes(priv, ctx); channelRoutes(priv, ctx);
      memberRoutes(priv, ctx); messageRoutes(priv, ctx); miscRoutes(priv, ctx); voiceRoutes(priv, ctx);
    });
  }, { prefix: '/api/v1' });

  app.addHook('onClose', async () => { hub.close(); rl.close(); await bus.close(); await state.close(); await db.close(); });
  return { app, ctx };
}
