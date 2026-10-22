import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { ALL_INTENTS, GatewayClose, HEARTBEAT_INTERVAL_MS, Intents, Op, PRIVILEGED_INTENTS, Perm, has, type Activity, type Presence, type ReadyPayload, type VoiceStateUpdatePayload } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { verifyGatewayToken } from '../auth';
import { randomToken } from '../lib/crypto';
import { RateLimiter } from '../lib/ratelimit';
import { idSchema } from '../lib/ids';
import { notFound } from '../errors';
import { buildGuildFull } from '../services/guilds';
import { channelPermsLite, guildAccess } from '../services/perms';
import { channelsDTO, membersDTO, publicActivities, selfUserDTO } from '../services/serializers';
import { updateVoiceState, clearVoiceAfterGrace } from '../services/voice';
import { activeRingsFor } from '../services/calls';
import { relationshipDTOs } from '../routes/users';
import type { GwSession } from './hub';
import { shapeReady } from './intents';
import { threadListSync } from '../services/threads';
import { activitiesSchema, normalizeActivities } from '../services/activities';

const withActivities = (a: Activity[]) => (a.length ? { activities: a } : {});

async function buildReady(ctx: Ctx, userId: string, sessionId: string): Promise<ReadyPayload> {
  const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [userId]);
  const guildIds = (await ctx.db.query('SELECT guild_id FROM members WHERE user_id = $1 ORDER BY joined_at', [userId])).map((r) => r.guild_id as string);
  const guilds = [];
  for (let i = 0; i < guildIds.length; i += 4) guilds.push(...(await Promise.all(guildIds.slice(i, i + 4).map((id) => buildGuildFull(ctx, id, userId))))); // bounded parallelism: keeps READY fast without draining the pool
  const dms = await ctx.db.query('SELECT c.* FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = $1 AND NOT (p.request AND c.last_message_id IS NULL) ORDER BY c.last_message_id DESC NULLS LAST', [userId]);
  const requestIds = (await ctx.db.query('SELECT channel_id FROM dm_participants WHERE user_id = $1 AND request', [userId])).map((r) => r.channel_id as string);
  const privateChannels = await channelsDTO(ctx, dms);
  const rs = await ctx.db.query('SELECT * FROM read_states WHERE user_id = $1', [userId]);
  const peers = await ctx.db.query(
    `SELECT DISTINCT x.uid, u.presence, u.activities, u.privacy FROM (
        SELECT m2.user_id AS uid FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1 AND m2.user_id <> $1
        UNION SELECT other_id FROM relationships WHERE user_id = $1 AND type = 'friend') x JOIN users u ON u.id = x.uid LIMIT 5000`, [userId]);
  if (ctx.config.redisUrl) ctx.hub.markOnline(await ctx.presence.onlineAmong(peers.map((p) => p.uid as string)));
  const presences = peers.filter((p) => ctx.hub.isOnline(p.uid)).map((p) => ({ userId: p.uid as string, presence: ctx.hub.publicPresence(p.uid, p.presence), ...withActivities(publicActivities(ctx, p.uid as string, p)) }));
  presences.push({ userId, presence: (u.presence || 'online') as Presence, ...withActivities(Array.isArray(u.activities) ? u.activities : []) }); // you are online to yourself (invisible stays invisible)
  const visible = new Set<string>([...guilds.flatMap((g) => g.channels.map((c) => c.id)), ...privateChannels.map((c) => c.id)]);
  const voiceStates = (await ctx.voice.all()).filter((v) => v.channelId && visible.has(v.channelId));
  return {
    sessionId, user: selfUserDTO(ctx, u), guilds, privateChannels, relationships: await relationshipDTOs(ctx, userId),
    messageRequests: requestIds, readStates: rs.map((r) => ({ channelId: r.channel_id, lastReadId: r.last_read_id ?? null, mentionCount: r.mention_count })), presences, voiceStates, calls: activeRingsFor(ctx, userId),
  };
}

const requestMembersSchema = z.object({
  guildId: idSchema, query: z.string().max(64).optional(), userIds: z.array(idSchema).max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(), after: idSchema.optional(), nonce: z.string().max(64).optional(),
}).strict();

/** Gateway REQUEST_MEMBERS: replies with GUILD_MEMBERS_CHUNK to the asking session only. Requires guild membership. */
async function requestMembers(ctx: Ctx, session: GwSession, d: unknown) {
  const p = requestMembersSchema.parse(d);
  if (session.intents != null && !(session.intents & Intents.GUILD_MEMBERS)) throw Object.assign(new Error('REQUEST_MEMBERS needs the GUILD_MEMBERS intent'), { code: 'MISSING_INTENT' });
  await guildAccess(ctx, session.userId, p.guildId);
  const limit = p.limit ?? 100;
  let rows: any[];
  if (p.userIds?.length) {
    rows = await ctx.db.query('SELECT * FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])', [p.guildId, p.userIds]);
  } else if (p.query) {
    const like = `${p.query.replace(/[\\%_]/g, '\\$&')}%`;
    rows = await ctx.db.query(
      `SELECT m.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND (u.username ILIKE $2 OR u.display_name ILIKE $2 OR m.nick ILIKE $2) ORDER BY u.username LIMIT $3`, [p.guildId, like, limit]);
  } else {
    rows = await ctx.db.query('SELECT * FROM members WHERE guild_id = $1 AND ($2::text IS NULL OR user_id > $2) ORDER BY user_id LIMIT $3', [p.guildId, p.after ?? null, limit]);
  }
  const members = await membersDTO(ctx, rows);
  const notFound = (p.userIds ?? []).filter((id) => !members.some((m) => m.user.id === id));
  ctx.hub.sendTo(session, 'GUILD_MEMBERS_CHUNK', { guildId: p.guildId, members, notFound, chunkIndex: 0, chunkCount: 1, ...(p.nonce ? { nonce: p.nonce } : {}) });
}

const frameSchema = z.object({ op: z.number().int(), d: z.unknown().optional() });
const identifySchema = z.object({ token: z.string().max(4096), sessionId: z.string().max(100).optional(), seq: z.number().int().min(0).optional(), intents: z.number().int().min(0).max(0x7fffffff).optional() }).passthrough();

export function gatewayRoutes(app: FastifyInstance, ctx: Ctx) {
  const wsLimiter = new RateLimiter();
  app.addHook('onClose', async () => wsLimiter.close());
  const hbInterval = ctx.config.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;
  /** Open sockets per client IP (pre- and post-identify): bounds slow-loris style socket exhaustion. */
  const openByIp = new Map<string, number>();
  const MAX_SOCKETS_PER_IP = 100, MAX_ATTACHED_PER_USER = 25;

  app.get('/gateway', { websocket: true }, (socket: WebSocket, req) => {
    const send = (f: object) => { if (socket.readyState === 1) socket.send(JSON.stringify(f)); };
    const ip = req.ip;
    if (ctx.config.rateLimit && (openByIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) { socket.close(4008, 'too many connections'); return; }
    openByIp.set(ip, (openByIp.get(ip) ?? 0) + 1);
    let session: GwSession | null = null;
    let queue: Promise<void> = Promise.resolve();
    const connId = randomToken(8);
    send({ op: Op.HELLO, d: { heartbeatInterval: hbInterval } });

    const identifyTimer = setTimeout(() => { if (!session) socket.close(4003, 'identify timeout'); }, 20_000);
    let hbTimer: NodeJS.Timeout | undefined;
    const armHeartbeat = () => { clearTimeout(hbTimer); hbTimer = setTimeout(() => socket.close(4009, 'heartbeat timeout'), hbInterval * 2 + 5000); };
    armHeartbeat();

    async function attach(s: GwSession) {
      session = s; s.socket = socket; s.detachedAt = null;
      clearTimeout(identifyTimer);
      if ((await ctx.hub.sessionAttached(s)) === 1) await ctx.hub.broadcastPresence(s.userId);
    }

    async function identify(d: unknown) {
      const p = identifySchema.safeParse(d);
      if (!p.success) return socket.close(4002, 'invalid payload');
      const claims = await verifyGatewayToken(ctx, p.data.token);
      if (!claims) return socket.close(4004, 'authentication failed');
      if (ctx.config.rateLimit && ctx.hub.attachedCount(claims.userId) >= MAX_ATTACHED_PER_USER) return socket.close(4008, 'too many sessions');
      if (p.data.sessionId && p.data.seq !== undefined) {
        if (await tryResume(claims.userId, p.data.sessionId, p.data.seq)) return;
      }
      // Intents apply to bots only; a user session always receives everything it is entitled to.
      let intents: number | null = null;
      if (claims.sessionId.startsWith('bot:') && p.data.intents !== undefined) {
        if ((p.data.intents & ~ALL_INTENTS) !== 0) return socket.close(GatewayClose.INVALID_INTENTS, 'invalid intents');
        const [appRow] = await ctx.db.query('SELECT privileged_intents FROM applications WHERE id = $1', [claims.sessionId.slice(4)]);
        if ((p.data.intents & PRIVILEGED_INTENTS & ~(appRow?.privileged_intents ?? 0)) !== 0) return socket.close(GatewayClose.DISALLOWED_INTENTS, 'disallowed intents: enable the privileged intents for this application first');
        intents = p.data.intents;
      }
      const s: GwSession = { id: randomToken(16), userId: claims.userId, authSessionId: claims.sessionId, seq: 0, buffer: [], socket: null, detachedAt: null, intents };
      ctx.hub.sessions.set(s.id, s);
      await attach(s);
      const ready = await buildReady(ctx, s.userId, s.id);
      ctx.hub.sendTo(s, 'READY', shapeReady(s, ready));
      // THREAD_LIST_SYNC: authoritative active-thread list per guild, so clients drop threads they lost access to while offline
      for (const g of s.intents == null || (s.intents & 1) ? ready.guilds : []) { // GUILDS intent = bit 0
        const threads = g.channels.filter((c) => c.type === 'thread');
        if (!threads.length) continue;
        const sync = await threadListSync(ctx, g.id, await ctx.db.query('SELECT * FROM channels WHERE id = ANY($1::text[])', [threads.map((t) => t.id)]), s.userId);
        ctx.hub.sendTo(s, 'THREAD_LIST_SYNC', sync);
      }
    }

    async function tryResume(userId: string, sessionId: string, seq: number): Promise<boolean> {
      const s = ctx.hub.sessions.get(sessionId);
      if (!s || s.userId !== userId) return false;
      const oldest = s.buffer[0]?.s ?? s.seq + 1;
      if (seq > s.seq || oldest > seq + 1) return false;
      if (s.socket && s.socket !== socket) s.socket.close(4005, 'session taken over');
      await attach(s);
      for (const e of s.buffer) if (e.s > seq && e.t !== 'READY') send({ op: Op.DISPATCH, t: e.t, s: e.s, d: e.d });
      send({ op: Op.DISPATCH, t: 'RESUMED', d: { sessionId: s.id, seq: s.seq } });
      return true;
    }

    async function resume(d: unknown) {
      const p = identifySchema.safeParse(d);
      const claims = p.success ? await verifyGatewayToken(ctx, p.data.token) : null;
      if (!p.success || !claims || !p.data.sessionId || p.data.seq === undefined || !(await tryResume(claims.userId, p.data.sessionId, p.data.seq))) {
        send({ op: Op.RECONNECT, d: { resumable: false } });
        socket.close(4007, 'invalid session');
      }
    }

    async function handle(raw: string) {
      let json: unknown; try { json = JSON.parse(raw); } catch { return socket.close(4002, 'invalid json'); }
      const f = frameSchema.safeParse(json);
      if (!f.success) return socket.close(4002, 'invalid frame');
      const { op, d } = f.data;
      if (op === Op.HEARTBEAT) { armHeartbeat(); return send({ op: Op.HEARTBEAT_ACK }); }
      if (op === Op.IDENTIFY) { if (session) return socket.close(4005, 'already identified'); return identify(d); }
      if (op === Op.RESUME) { if (session) return socket.close(4005, 'already identified'); return resume(d); }
      if (!session) return socket.close(4003, 'not authenticated');
      const uid = session.userId;
      try {
        // re-validate the auth session so revoked tokens can't keep a socket alive
        if (op === Op.PRESENCE_UPDATE) {
          const { presence, activities } = z.object({ presence: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(), activities: activitiesSchema.optional() }).refine((v) => v.presence || v.activities, 'presence or activities required').parse(d);
          if (presence) await ctx.db.query('UPDATE users SET presence = $2 WHERE id = $1', [uid, presence]);
          if (activities) await ctx.db.query('UPDATE users SET activities = $2::jsonb WHERE id = $1', [uid, JSON.stringify(normalizeActivities(activities))]);
          await ctx.hub.broadcastPresence(uid);
        } else if (op === Op.VOICE_STATE_UPDATE) {
          const v = z.object({ guildId: idSchema.nullable().optional(), channelId: idSchema.nullable(), selfMute: z.boolean().optional(), selfDeaf: z.boolean().optional(), video: z.boolean().optional(), streaming: z.boolean().optional() }).parse(d);
          await updateVoiceState(ctx, uid, { guildId: v.guildId ?? null, ...v } as VoiceStateUpdatePayload);
        } else if (op === Op.REQUEST_MEMBERS) {
          await requestMembers(ctx, session, d);
        } else if (op === Op.TYPING) {
          const { channelId } = z.object({ channelId: idSchema }).parse(d);
          const a = await channelPermsLite(ctx, uid, channelId); // cached: no DB queries on the typing hot path
          if (!a) throw notFound('Channel');
          if (has(a.perms, a.channel.type === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES)) await ctx.hub.toChannel(channelId, 'TYPING_START', { channelId, userId: uid, timestamp: Date.now() }, { exclude: uid });
        }
      } catch (e: any) {
        send({ op: Op.DISPATCH, t: 'ERROR', d: { op, code: e?.code ?? 'BAD_REQUEST', message: e?.message ?? 'error' } });
      }
    }

    socket.on('message', (data) => {
      if (ctx.config.rateLimit && wsLimiter.hit(connId, 120, 60_000)) return socket.close(4008, 'rate limited');
      const raw = data.toString();
      queue = queue.then(() => handle(raw)).catch((e) => ctx.log.error({ err: e }, 'gateway handler failed'));
    });
    socket.on('close', () => {
      clearTimeout(identifyTimer); clearTimeout(hbTimer);
      const left = (openByIp.get(ip) ?? 1) - 1; if (left <= 0) openByIp.delete(ip); else openByIp.set(ip, left);
      const s = session as GwSession | null;
      if (!s || s.socket !== socket) return;
      s.socket = null; s.detachedAt = Date.now();
      void ctx.hub.sessionDetached(s).then(async (left) => {
        if (left > 0) return;
        await ctx.db.query(`UPDATE users SET activities = '[]'::jsonb WHERE id = $1`, [s.userId]); // activities live and die with the connection
        clearVoiceAfterGrace(ctx, s.userId); // a flaky network must not eject someone whose LiveKit connection survives
        await ctx.hub.broadcastPresence(s.userId);
      }).catch((e) => ctx.log.warn({ err: e }, 'presence detach failed'));
    });
    socket.on('error', (e) => req.log.debug({ err: e }, 'ws error'));
  });
}
