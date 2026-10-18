import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ACTIVITY_STATE_MAX_BYTES, snowflake, type ChannelActivity } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { channelAccess } from '../services/perms';
import { activitiesSchema, normalizeActivities } from '../services/activities';

const activityDTO = (r: any): ChannelActivity => ({
  id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null, kind: r.kind, hostId: r.host_id,
  state: r.state ?? {}, startedAt: iso(r.started_at)!, updatedAt: iso(r.updated_at)!,
});

/** The state blob is opaque to the server, but it may not be used as bulk storage. */
const activityState = z.unknown().refine(
  (v) => Buffer.byteLength(JSON.stringify(v ?? null)) <= ACTIVITY_STATE_MAX_BYTES,
  `state must be at most ${ACTIVITY_STATE_MAX_BYTES} bytes`,
);
const activityKind = z.enum(['youtube', 'tictactoe']);
const activityParams = z.object({ id: idSchema });
const channelParams = z.object({ id: idSchema });

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
 * to members who can view it. Only the host may update the shared state or end the session.
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
    const b = parse(z.object({ kind: activityKind, state: activityState.optional() }).strict(), req.body);
    const acc = await channelAccess(ctx, req.userId, id);
    if (acc.channel.type !== 'voice' && acc.channel.type !== 'stage') throw badRequest('Not a voice channel');
    limitOrThrow(ctx.rl, `activity-start:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const [existing] = await ctx.db.query('SELECT 1 AS x FROM channel_activities WHERE channel_id = $1 AND kind = $2', [id, b.kind]);
    if (existing) throw new ApiError(409, 'ACTIVITY_EXISTS', 'That activity is already running in this channel');
    const aid = snowflake();
    const [row] = await ctx.db.query(
      'INSERT INTO channel_activities (id, channel_id, guild_id, kind, host_id, state) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',
      [aid, id, acc.channel.guild_id ?? null, b.kind, req.userId, JSON.stringify(b.state ?? {})],
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
    if (row.host_id !== req.userId) throw forbidden('Only the host can change the activity');
    limitOrThrow(ctx.rl, `activity-update:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const [updated] = await ctx.db.query('UPDATE channel_activities SET state = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *', [id, JSON.stringify(b.state ?? {})]);
    const dto = activityDTO(updated);
    await ctx.hub.toChannel(row.channel_id, 'ACTIVITY_UPDATE', dto);
    return dto;
  });

  app.delete('/activities/:id', async (req, reply) => {
    const { id } = parse(activityParams, req.params);
    const row = await loadActivity(ctx, id);
    await channelAccess(ctx, req.userId, row.channel_id);
    if (row.host_id !== req.userId) throw forbidden('Only the host can end the activity');
    await ctx.db.query('DELETE FROM channel_activities WHERE id = $1', [id]);
    await ctx.hub.toChannel(row.channel_id, 'ACTIVITY_END', { id, channelId: row.channel_id, guildId: row.guild_id ?? null });
    return reply.code(204).send();
  });
}
