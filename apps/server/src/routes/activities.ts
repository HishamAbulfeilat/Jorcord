import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTIVITY_STATE_MAX_BYTES, snowflake, type ChannelActivity } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { channelAccess, has, need, Perm } from '../services/perms';
import { applyTttMove, initialTtt, readStored } from '../services/tictactoe';
import { activitiesSchema, normalizeActivities } from '../services/activities';
import { assertMayLaunchEmbedded } from '../services/embeddedActivities';

const activityDTO = (r: any): ChannelActivity => ({
  id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null, kind: r.kind, hostId: r.host_id,
  state: r.state ?? {}, startedAt: iso(r.started_at)!, updatedAt: iso(r.updated_at)!, ...(r.application_id ? { applicationId: r.application_id } : {}),
});

/** The state blob is opaque to the server, but it may not be used as bulk storage. */
const activityState = z.unknown().refine(
  (v) => Buffer.byteLength(JSON.stringify(v ?? null)) <= ACTIVITY_STATE_MAX_BYTES,
  `state must be at most ${ACTIVITY_STATE_MAX_BYTES} bytes`,
);
const activityKind = z.enum(['youtube', 'tictactoe']);
/** Watch Together state is a closed shape: it is rendered into a player command, so it is not free-form. */
const youtubeState = z.object({
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  position: z.number().finite().min(0).max(86_400 * 7).optional(),
  playing: z.boolean().optional(),
}).strict();
const activityParams = z.object({ id: idSchema });
const channelParams = z.object({ id: idSchema });

/** Being connected to the voice channel is what makes someone a participant (viewing the channel is not enough). */
async function requireInCall(ctx: Ctx, userId: string, channelId: string) {
  const vs = await ctx.voice.get(userId);
  if (vs?.channelId !== channelId) throw forbidden('Join the voice channel to use its activities');
}

async function loadActivity(ctx: Ctx, id: string) {
  const [row] = await ctx.db.query('SELECT * FROM channel_activities WHERE id = $1', [id]);
  if (!row) throw notFound('Activity');
  return row;
}

/**
 * Rich presence plus shared voice-channel activities.
 *
 * Rich presence: a user's own client (or a bot, for itself) publishes what it is doing; peers see it in presence events.
 * Nothing is stored beyond the live connection: activities are cleared when the last gateway session ends.
 *
 * Shared activities (Watch Together / games): every read and write resolves the channel through `channelAccess`, so a
 * caller without VIEW_CHANNEL gets the same 404 as a missing channel. Events go through `toChannel`, which only fan out
 * to members who can view it. Starting or changing an activity requires being connected to that voice channel. Only the
 * host may update Watch Together state; Tic-Tac-Toe moves are validated on the server (the host plays X, the first other
 * participant in the call to move plays O, turn order and cell legality are enforced). The host, or a member with
 * MANAGE_CHANNELS, may end a session.
 */
export function activityRoutes(app: FastifyInstance, ctx: Ctx) {
  app.put('/users/@me/activities', async (req) => {
    const { activities } = parse(z.object({ activities: activitiesSchema }).strict(), req.body);
    limitOrThrow(ctx.rl, `activity:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const list = normalizeActivities(activities);
    await ctx.db.query('UPDATE users SET activities = $2::jsonb WHERE id = $1', [req.userId, JSON.stringify(list)]);
    await ctx.hub.broadcastPresence(req.userId);
    return { activities: list };
  });
  app.get('/users/@me/activities', async (req) => {
    const [u] = await ctx.db.query('SELECT activities FROM users WHERE id = $1', [req.userId]);
    return { activities: Array.isArray(u?.activities) ? u.activities : [] };
  });
  app.delete('/users/@me/activities', async (req, reply) => {
    await ctx.db.query(`UPDATE users SET activities = '[]'::jsonb WHERE id = $1`, [req.userId]);
    await ctx.hub.broadcastPresence(req.userId);
    return reply.code(204).send();
  });

  app.get('/channels/:id/activities', async (req) => {
    const { id } = parse(channelParams, req.params);
    await channelAccess(ctx, req.userId, id);
    const rows = await ctx.db.query('SELECT * FROM channel_activities WHERE channel_id = $1 ORDER BY id', [id]);
    return { activities: rows.map(activityDTO) };
  });

  app.post('/channels/:id/activities', async (req, reply) => {
    const { id } = parse(channelParams, req.params);
    const b = parse(z.union([
      z.object({ kind: activityKind, state: activityState.optional() }).strict(),
      z.object({ applicationId: idSchema, state: activityState.optional() }).strict(), // third-party embedded activity
    ]), req.body);
    const acc = await channelAccess(ctx, req.userId, id);
    if (acc.channel.type !== 'voice' && acc.channel.type !== 'stage') throw badRequest('Not a voice channel');
    if (acc.channel.guild_id) need(acc.perms, Perm.USE_EMBEDDED_ACTIVITIES);
    limitOrThrow(ctx.rl, `activity-start:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    await requireInCall(ctx, req.userId, id);
    let initial: unknown, kind: string, applicationId: string | null = null;
    if ('applicationId' in b) {
      if (req.isBot) throw forbidden('Bots cannot launch activities');
      assertMayLaunchEmbedded(acc.perms);
      const [capp] = await ctx.db.query('SELECT id, owner_id, bot_public, activity_url FROM applications WHERE id = $1', [b.applicationId]);
      // an unlisted/private app is only launchable by its owner; an app without an activity URL has nothing to frame
      if (!capp || !capp.activity_url || (!capp.bot_public && capp.owner_id !== req.userId)) throw notFound('Application');
      kind = 'app'; applicationId = capp.id; initial = b.state ?? {};
    } else {
      kind = b.kind;
      if (b.kind === 'tictactoe') initial = initialTtt();
      else initial = parse(youtubeState, b.state);
    }
    const [existing] = await ctx.db.query(`SELECT 1 AS x FROM channel_activities WHERE channel_id = $1 AND kind = $2 AND COALESCE(application_id, '') = $3`, [id, kind, applicationId ?? '']);
    if (existing) throw new ApiError(409, 'ACTIVITY_EXISTS', 'That activity is already running in this channel');
    const aid = snowflake();
    const [row] = await ctx.db.query(
      'INSERT INTO channel_activities (id, channel_id, guild_id, kind, host_id, state, application_id) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING *',
      [aid, id, acc.channel.guild_id ?? null, kind, req.userId, JSON.stringify(initial), applicationId],
    );
    const dto = activityDTO(row);
    await ctx.hub.toChannel(id, 'ACTIVITY_START', dto);
    return reply.code(201).send(dto);
  });

  app.get('/activities/:id', async (req) => {
    const { id } = parse(activityParams, req.params);
    const row = await loadActivity(ctx, id);
    await channelAccess(ctx, req.userId, row.channel_id);
    return activityDTO(row);
  });

  app.patch('/activities/:id/state', async (req) => {
    const { id } = parse(activityParams, req.params);
    const b = parse(z.object({ state: activityState }).strict(), req.body);
    const row = await loadActivity(ctx, id);
    await channelAccess(ctx, req.userId, row.channel_id);
    limitOrThrow(ctx.rl, `activity-update:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    await requireInCall(ctx, req.userId, row.channel_id);
    let nextState: unknown;
    if (row.kind === 'app') { // shared document owned by the third-party activity: any participant in the call may write it (size-capped), last writer wins
      const [u] = await ctx.db.query('UPDATE channel_activities SET state = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *', [id, JSON.stringify(b.state ?? {})]);
      const dto = activityDTO(u);
      await ctx.hub.toChannel(row.channel_id, 'ACTIVITY_UPDATE', dto);
      return dto;
    }
    if (row.kind === 'tictactoe') nextState = applyTttMove(readStored(row.state), row.host_id, req.userId, b.state);
    else {
      if (row.host_id !== req.userId) throw forbidden('Only the host can change the activity');
      nextState = parse(youtubeState, b.state);
    }
    // Compare-and-set on the previous state so two simultaneous moves cannot both apply.
    const [updated] = await ctx.db.query(
      'UPDATE channel_activities SET state = $3::jsonb, updated_at = now() WHERE id = $1 AND state = $2::jsonb RETURNING *',
      [id, JSON.stringify(row.state ?? {}), JSON.stringify(nextState)]);
    if (!updated) throw new ApiError(409, 'ACTIVITY_CONFLICT', 'The activity changed; try again');
    const dto = activityDTO(updated);
    await ctx.hub.toChannel(row.channel_id, 'ACTIVITY_UPDATE', dto);
    return dto;
  });

  app.delete('/activities/:id', async (req, reply) => {
    const { id } = parse(activityParams, req.params);
    const row = await loadActivity(ctx, id);
    const acc = await channelAccess(ctx, req.userId, row.channel_id);
    if (row.host_id !== req.userId && !(acc.gp && has(acc.perms, Perm.MANAGE_CHANNELS))) throw forbidden('Only the host or a channel manager can end the activity');
    await ctx.db.query('DELETE FROM channel_activities WHERE id = $1', [id]);
    await ctx.hub.toChannel(row.channel_id, 'ACTIVITY_END', { id, channelId: row.channel_id, guildId: row.guild_id ?? null });
    return reply.code(204).send();
  });
}
