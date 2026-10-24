import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { authenticate, verifyGatewayToken } from './auth';
import { createBus } from './bus';
import { loadConfig, type Config } from './config';
import type { Ctx } from './ctx';
import { createDb } from './db';
import { migrate } from './db/migrate';
import { ApiError, fieldErrors } from './errors';
import { Hub } from './gateway/hub';
import { gatewayRoutes } from './gateway/ws';
import { RateLimiter, installRateLimit } from './lib/ratelimit';
import { authRoutes, publicAuthRoutes } from './routes/auth';
import { exportPublicRoutes, exportRoutes } from './routes/dataexport';
import { appealRoutes } from './routes/appeals';
import { passkeyPublicRoutes, passkeyRoutes } from './routes/passkeys';
import { remoteAuthPublicRoutes, remoteAuthRoutes } from './routes/remoteauth';
import { applicationRoutes, oauthPublicRoutes } from './routes/applications';
import { commandRoutes } from './routes/commands';
import { eventRoutes } from './routes/events';
import { interactionPublicRoutes, interactionRoutes } from './routes/interactions';
import { pollRoutes } from './routes/polls';
import { runSweeps } from './services/sweeper';
import { channelRoutes, webhookPublicRoutes } from './routes/channels';
import { clipRoutes } from './routes/clips';
import { scheduledMessageRoutes } from './routes/scheduledMessages';
import { e2eeRoutes } from './routes/e2ee';
import { digestRoutes } from './routes/digest';
import { guildPortRoutes } from './routes/guildport';
import { guildRoutes } from './routes/guilds';
import { invitePublicRoutes, memberRoutes } from './routes/members';
import { messageRoutes } from './routes/messages';
import { fileRoutes, miscRoutes, voiceWebhookRoutes } from './routes/misc';
import { pushPublicRoutes, pushRoutes } from './routes/push';
import { socialRoutes } from './routes/social';
import { accounts3PublicRoutes, accounts3Routes } from './routes/accounts3';
import { activityRoutes } from './routes/activities';
import { connectionRoutes, connectionOAuthPublicRoutes } from './routes/connections';
import { streamFeedRoutes } from './routes/streamfeeds';
import { favoriteRoutes } from './routes/favorites';
import { guildExtrasRoutes, widgetPublicRoutes } from './routes/guildextras';
import { followRoutes } from './routes/follows';
import { linkedRoleRoutes } from './routes/linkedroles';
import { directoryRoutes } from './routes/directory';
import { integrationRoutes } from './routes/integrations';
import { ensureSystemApps } from './services/sysbots';
import { modToolRoutes } from './routes/modtools';
import { onboardingRoutes } from './routes/onboarding';
import { safetyRoutes } from './routes/safety';
import { adminRoutes } from './routes/admin';
import { godModeAuditHook } from './services/godmode';
import { soundboardRoutes } from './routes/soundboard';
import { userRoutes } from './routes/users';
import { voiceRoutes } from './routes/voice';
import { createStorage } from './storage';
import { createState } from './state';
import { createLiveKitControl } from './services/livekit';
import { createMailer } from './services/mailer';
import { createPush } from './services/push';
import { PermCache } from './services/permcache';
import { createWebApp, hasWebBuild } from './lib/webapp';
import { livekitProxyRoutes, livekitConnectSources } from './routes/voice-livekit';
import { activityOriginsCached } from './services/embeddedActivities';
import { installAuditReason } from './lib/auditReason';
import { userInstallRoutes } from './routes/userInstalls';
import { appEmojiRoutes, emojiPublicRoutes } from './routes/appEmojis';
import { securityHeaders, logSerializers, LOG_REDACT } from './lib/security';

export interface BuildOptions { config?: Partial<Config>; memoryDb?: boolean; env?: NodeJS.ProcessEnv }

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: Ctx }> {
  const config = loadConfig(opts.config, opts.env);
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : {
      level: config.logLevel,
      redact: LOG_REDACT, serializers: logSerializers,
    },
    trustProxy: config.trustProxy, bodyLimit: 1_048_576, genReqId: () => crypto.randomUUID(),
    // REST compat: /api/v10 and /api/v9 are aliases of /api/v1 (same handlers, rate limits and bot gates, because the URL is rewritten before routing)
    rewriteUrl: (req) => { const u = req.url ?? '/'; return u.startsWith('/api/v') ? u.replace(/^\/api\/v(?:9|10)(?=\/|\?|$)/, '/api/v1') : u; },
  });
  // Bot libraries and curl always send content-type: application/json, even with no body: treat an empty body as {} (poisoned-prototype protection stays on).
  const defaultJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, {});
    defaultJson(req, body as string, done);
  });
  const db = await createDb({ ...config, memory: opts.memoryDb });
  await migrate(db, config.migrationsDir, app.log);
  const bus = await createBus(config.redisUrl);
  const hub = new Hub();
  const rl = new RateLimiter();
  const state = await createState(config.redisUrl, config.redisPrefix);
  const ctx: Ctx = {
    config, db, bus, storage: await createStorage(config), hub, rl, log: app.log,
    push: undefined as never, voice: state.voice, presence: state.presence, livekit: createLiveKitControl(config, app.log), mailer: await createMailer(config, app.log),
    pcache: new PermCache(),
    search: config.searchMode === 'auto' ? (db.kind === 'pg' ? 'fts' : 'ilike') : config.searchMode,
  };
  ctx.push = createPush(ctx);
  await ctx.pcache.init(bus, config.redisPrefix, !!config.redisUrl);
  await hub.init(ctx);
  await ensureSystemApps(ctx); // official built-in bots (Welcome, Moderation, Utility)

  await app.register(cors, {
    origin: config.corsOrigins, credentials: false, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], maxAge: 600,
    exposedHeaders: ['retry-after', 'content-range', 'accept-ranges', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-reset-after', 'x-ratelimit-bucket', 'x-ratelimit-global', 'x-ratelimit-scope'],
  });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 10, fields: 20, fieldSize: 64 * 1024 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  installAuditReason(app); // X-Audit-Log-Reason for every moderation/management route
  installRateLimit(app, rl, config.rateLimit, config.jwtSecret);

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    securityHeaders(reply, req, config);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) {
      if (err.headers) reply.headers(err.headers);
      return reply.code(err.status).send(err.toBody());
    }
    if (err instanceof ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request', details: err.issues, errorCode: 50035, errors: fieldErrors(err.issues) });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE' || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' });
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) return reply.code(err.statusCode).send({ code: String(err.code ?? 'BAD_REQUEST'), message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'INTERNAL', message: 'Internal server error' });
  });
  // Optional same-origin web client (WEB_DIST). Real routes win; this only sees what nothing else matched.
  let web = config.webDist ? createWebApp(config.webDist, { livekitConnect: livekitConnectSources(config.livekit.url), activityOrigins: () => activityOriginsCached(db) }) : null;
  if (config.webDist && !(await hasWebBuild(config.webDist))) { app.log.warn({ webDist: config.webDist }, 'WEB_DIST has no index.html: serving the API only'); web = null; }
  app.setNotFoundHandler(async (req, reply) => {
    if (web && await web.handle(req, reply)) return reply;
    return reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found' });
  });

  app.get('/health', async (req, reply) => {
    try {
      await db.query('SELECT 1');
      // anonymous callers (load balancers, the web client's server check) only learn status + db; uptime and session count are for signed-in users
      const h = req.headers.authorization;
      const authed = !!h?.startsWith('Bearer ') && !!(await verifyGatewayToken(ctx, h.slice(7)).catch(() => null));
      return authed ? { status: 'ok', db: db.kind, uptime: Math.round(process.uptime()), sessions: hub.sessions.size } : { status: 'ok', db: db.kind };
    }
    catch { return reply.code(503).send({ status: 'degraded', db: 'down' }); }
  });
  gatewayRoutes(app, ctx);
  livekitProxyRoutes(app, ctx); // same-origin LiveKit signalling (LIVEKIT_URL=auto)

  await app.register(async (api) => {
    publicAuthRoutes(api, ctx);
    passkeyPublicRoutes(api, ctx);
    exportPublicRoutes(api, ctx);
    remoteAuthPublicRoutes(api, ctx);
    accounts3PublicRoutes(api, ctx);
    pushPublicRoutes(api, ctx);
    invitePublicRoutes(api, ctx);
    webhookPublicRoutes(api, ctx);
    oauthPublicRoutes(api, ctx);
    connectionOAuthPublicRoutes(api, ctx);
    interactionPublicRoutes(api, ctx);
    emojiPublicRoutes(api, ctx);
    fileRoutes(api, ctx);
    widgetPublicRoutes(api, ctx);
    await api.register(async (scope) => voiceWebhookRoutes(scope, ctx));
    await api.register(async (priv) => {
      priv.addHook('preHandler', authenticate(ctx));
      priv.addHook('onResponse', godModeAuditHook(ctx));
      authRoutes(priv, ctx); passkeyRoutes(priv, ctx); appealRoutes(priv, ctx); exportRoutes(priv, ctx); remoteAuthRoutes(priv, ctx); userRoutes(priv, ctx); guildRoutes(priv, ctx); channelRoutes(priv, ctx);
      clipRoutes(priv, ctx);
      scheduledMessageRoutes(priv, ctx);
      e2eeRoutes(priv, ctx);
      digestRoutes(priv, ctx);
      accounts3Routes(priv, ctx);
      guildPortRoutes(priv, ctx);
      memberRoutes(priv, ctx); messageRoutes(priv, ctx); miscRoutes(priv, ctx); voiceRoutes(priv, ctx); pushRoutes(priv, ctx);
      applicationRoutes(priv, ctx); appEmojiRoutes(priv, ctx); userInstallRoutes(priv, ctx); commandRoutes(priv, ctx); interactionRoutes(priv, ctx); pollRoutes(priv, ctx); eventRoutes(priv, ctx); socialRoutes(priv, ctx); soundboardRoutes(priv, ctx); activityRoutes(priv, ctx); safetyRoutes(priv, ctx); onboardingRoutes(priv, ctx); followRoutes(priv, ctx); guildExtrasRoutes(priv, ctx); favoriteRoutes(priv, ctx); connectionRoutes(priv, ctx); streamFeedRoutes(priv, ctx); linkedRoleRoutes(priv, ctx); directoryRoutes(priv, ctx); integrationRoutes(priv, ctx); modToolRoutes(priv, ctx); adminRoutes(priv, ctx);
    });
  }, { prefix: '/api/v1' });

  // Time-driven lifecycles (poll expiry, scheduled events, idle stages, thread auto-archive). Atomic UPDATEs make this safe on several nodes.
  let sweeping = false;
  const sweepTimer = config.sweepIntervalMs > 0 ? setInterval(() => { if (sweeping) return; sweeping = true; void runSweeps(ctx).finally(() => { sweeping = false; }); }, config.sweepIntervalMs) : null;
  sweepTimer?.unref();
  app.addHook('onClose', async () => { if (sweepTimer) clearInterval(sweepTimer); hub.close(); ctx.pcache.close(); rl.close(); await ctx.push.flush().catch(() => {}); await bus.close(); await state.close(); await db.close(); });
  return { app, ctx };
}
