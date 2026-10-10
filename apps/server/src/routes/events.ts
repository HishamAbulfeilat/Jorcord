import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, ScheduledEventEntityType as ET, ScheduledEventStatus as ST, has, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { channelAccess, guildAccess, guildPerms, need } from '../services/perms';
import { visibleChannelRows } from '../services/guilds';
import { activateEvent, eventDTO, finishEvent, loadEventDTO, publishEvent } from '../services/scheduled';
import { endStage, stageDTO, startStage } from '../services/stage';
import { membersDTO, usersByIds } from '../services/serializers';

const isoTime = z.string().datetime({ offset: true });
const eventFields = {
  name: z.string().trim().min(1).max(100), description: z.string().max(1000).nullable(), entityType: z.number().int().min(1).max(3), channelId: idSchema.nullable(),
  scheduledStartTime: isoTime, scheduledEndTime: isoTime.nullable(), location: z.string().trim().min(1).max(100).nullable(), image: assetUrl.nullable(), privacyLevel: z.literal(2),
};
const MAX_OPEN_EVENTS = 100;
const ep = z.object({ id: idSchema, eid: idSchema });

export function eventRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Discord's per-entity-type permission rules (public docs, guild-scheduled-event "Permissions"). */
  async function checkEventPerms(userId: string, guildId: string, entityType: number, channelId: string | null, mode: 'create' | 'modify', creatorId?: string, lenientChannel = false) {
    const gp = await guildAccess(ctx, userId, guildId);
    const guildP = guildPerms(gp);
    if (mode === 'create') need(guildP, Perm.CREATE_EVENTS); else if (creatorId === userId) { if (!has(guildP, Perm.CREATE_EVENTS) && !has(guildP, Perm.MANAGE_EVENTS)) throw forbidden(); } else need(guildP, Perm.MANAGE_EVENTS);
    if (entityType === ET.EXTERNAL) return;
    let a: Awaited<ReturnType<typeof channelAccess>>;
    try { a = await channelAccess(ctx, userId, channelId!); }
    catch (e) { if (lenientChannel && e instanceof ApiError && e.status === 404) return; throw e; } // cleanup of an event whose channel is gone/hidden still needs the guild-level rights checked above
    if (a.channel.guild_id !== guildId) throw notFound('Channel');
    if (entityType === ET.STAGE_INSTANCE) { if (a.channel.type !== 'stage') throw badRequest('channelId must be a stage channel'); need(a.perms, Perm.MANAGE_CHANNELS, Perm.MUTE_MEMBERS, Perm.MOVE_MEMBERS); }
    else { if (a.channel.type !== 'voice') throw badRequest('channelId must be a voice channel'); need(a.perms, Perm.VIEW_CHANNEL, Perm.CONNECT); }
  }
  function checkShape(f: { entityType: number; channelId: string | null; scheduledStartTime: string; scheduledEndTime: string | null; location: string | null }, requireFuture: boolean) {
    const start = Date.parse(f.scheduledStartTime), end = f.scheduledEndTime ? Date.parse(f.scheduledEndTime) : null;
    if (requireFuture && start <= Date.now()) throw badRequest('scheduledStartTime must be in the future');
    if (end !== null && end <= start) throw badRequest('scheduledEndTime must be after scheduledStartTime');
    if (f.entityType === ET.EXTERNAL) { if (f.channelId) throw badRequest('External events have no channel'); if (!f.location) throw badRequest('External events need a location'); if (end === null) throw badRequest('External events need scheduledEndTime'); }
    else { if (!f.channelId) throw badRequest('channelId is required for stage and voice events'); if (f.location) throw badRequest('Only external events have a location'); }
  }
  /** Which events can this viewer see? Channel-bound events follow VIEW_CHANNEL; external events are visible to every member. */
  async function visibleEvent(userId: string, row: any) {
    await guildAccess(ctx, userId, row.guild_id);
    if (row.channel_id) { try { await channelAccess(ctx, userId, row.channel_id); } catch { throw notFound('Scheduled event'); } }
  }
  async function load(guildId: string, eid: string) {
    const [r] = await ctx.db.query('SELECT * FROM guild_scheduled_events WHERE id = $1 AND guild_id = $2', [eid, guildId]);
    if (!r) throw notFound('Scheduled event');
    return r;
  }

  app.get('/guilds/:id/scheduled-events', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await guildAccess(ctx, req.userId, id);
    const rows = await ctx.db.query('SELECT * FROM guild_scheduled_events WHERE guild_id = $1 AND status IN (1,2) ORDER BY scheduled_start, id LIMIT 200', [id]);
    const vis = new Set((await visibleChannelRows(ctx, id, req.userId)).map((c) => c.id as string));
    const ok = rows.filter((r) => !r.channel_id || vis.has(r.channel_id));
    return Promise.all(ok.map((r) => loadEventDTO(ctx, r, req.userId)));
  });

  app.post('/guilds/:id/scheduled-events', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ ...eventFields, description: eventFields.description.optional(), channelId: eventFields.channelId.optional(), scheduledEndTime: eventFields.scheduledEndTime.optional(), location: eventFields.location.optional(), image: eventFields.image.optional(), privacyLevel: eventFields.privacyLevel.optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `event-create:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const f = { ...b, channelId: b.channelId ?? null, scheduledEndTime: b.scheduledEndTime ?? null, location: b.location ?? null };
    checkShape(f, true);
    await checkEventPerms(req.userId, id, f.entityType, f.channelId, 'create');
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM guild_scheduled_events WHERE guild_id = $1 AND status IN (1,2)', [id]);
    if (c.n >= MAX_OPEN_EVENTS) throw new ApiError(400, 'MAX_EVENTS', `At most ${MAX_OPEN_EVENTS} upcoming events per server`);
    const eid = snowflake();
    await ctx.db.query(
      `INSERT INTO guild_scheduled_events (id, guild_id, channel_id, creator_id, name, description, scheduled_start, scheduled_end, entity_type, location, image) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [eid, id, f.channelId, req.userId, f.name, f.description ?? null, f.scheduledStartTime, f.scheduledEndTime, f.entityType, f.location, f.image ?? null]);
    const row = await load(id, eid);
    await publishEvent(ctx, 'GUILD_SCHEDULED_EVENT_CREATE', row);
    await audit(ctx, id, req.userId, 'GUILD_SCHEDULED_EVENT_CREATE', eid, { name: f.name, entityType: f.entityType });
    return reply.code(201).send(await loadEventDTO(ctx, row, req.userId));
  });

  app.get('/guilds/:id/scheduled-events/:eid', async (req) => {
    const p = parse(ep, req.params);
    const row = await load(p.id, p.eid); await visibleEvent(req.userId, row);
    return loadEventDTO(ctx, row, req.userId);
  });

  app.patch('/guilds/:id/scheduled-events/:eid', async (req) => {
    const p = parse(ep, req.params);
    const b = parse(z.object({ ...eventFields, status: z.number().int().min(1).max(4) }).partial().strict(), req.body);
    const cur = await load(p.id, p.eid);
    if (cur.status === ST.COMPLETED || cur.status === ST.CANCELED) throw new ApiError(400, 'EVENT_FINISHED', 'A completed or canceled event can no longer be updated');
    const f = {
      entityType: b.entityType ?? cur.entity_type, channelId: b.channelId !== undefined ? b.channelId : cur.channel_id,
      scheduledStartTime: b.scheduledStartTime ?? new Date(cur.scheduled_start).toISOString(), scheduledEndTime: b.scheduledEndTime !== undefined ? b.scheduledEndTime : cur.scheduled_end ? new Date(cur.scheduled_end).toISOString() : null,
      location: b.location !== undefined ? b.location : cur.location,
    };
    // switching entity type away from external must clear its fields explicitly; keep stored values consistent
    if (f.entityType !== ET.EXTERNAL && b.entityType !== undefined && b.location === undefined) f.location = null;
    if (f.entityType === ET.EXTERNAL && b.entityType !== undefined && b.channelId === undefined) f.channelId = null;
    if (cur.status === ST.ACTIVE && (b.entityType !== undefined || b.channelId !== undefined || b.scheduledStartTime !== undefined)) throw badRequest('An active event cannot change its type, channel or start time');
    checkShape(f, b.scheduledStartTime !== undefined);
    await checkEventPerms(req.userId, p.id, f.entityType, f.channelId, 'modify', cur.creator_id);
    if (b.status !== undefined) {
      const ok = (cur.status === ST.SCHEDULED && (b.status === ST.ACTIVE || b.status === ST.CANCELED)) || (cur.status === ST.ACTIVE && b.status === ST.COMPLETED) || b.status === cur.status;
      if (!ok) throw new ApiError(400, 'INVALID_STATUS_TRANSITION', 'Invalid status transition (SCHEDULED->ACTIVE|CANCELED, ACTIVE->COMPLETED)');
    }
    const col: Record<string, string> = { name: 'name', description: 'description', image: 'image' };
    const sets: string[] = [], vals: unknown[] = [p.eid];
    const set = (c: string, v: unknown) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
    for (const [k, c] of Object.entries(col)) if ((b as any)[k] !== undefined) set(c, (b as any)[k]);
    if (b.entityType !== undefined) set('entity_type', f.entityType);
    if (b.channelId !== undefined || b.entityType !== undefined) set('channel_id', f.channelId);
    if (b.location !== undefined || b.entityType !== undefined) set('location', f.location);
    if (b.scheduledStartTime !== undefined) set('scheduled_start', f.scheduledStartTime);
    if (b.scheduledEndTime !== undefined) set('scheduled_end', f.scheduledEndTime);
    if (sets.length) await ctx.db.query(`UPDATE guild_scheduled_events SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (b.status === ST.ACTIVE) await activateEvent(ctx, p.eid, req.userId);
    else if (b.status === ST.COMPLETED || b.status === ST.CANCELED) await finishEvent(ctx, p.eid, b.status, req.userId);
    const row = await load(p.id, p.eid);
    if (sets.length) { await publishEvent(ctx, 'GUILD_SCHEDULED_EVENT_UPDATE', row); await audit(ctx, p.id, req.userId, 'GUILD_SCHEDULED_EVENT_UPDATE', p.eid, b); }
    return loadEventDTO(ctx, row, req.userId);
  });

  app.delete('/guilds/:id/scheduled-events/:eid', async (req, reply) => {
    const p = parse(ep, req.params);
    const cur = await load(p.id, p.eid);
    await checkEventPerms(req.userId, p.id, cur.entity_type, cur.channel_id, 'modify', cur.creator_id, true); // a deleted channel must not block cleanup, but non-members / missing rights always fail
    if (cur.stage_instance_id) await endStage(ctx, cur.channel_id, req.userId);
    await ctx.db.query('DELETE FROM guild_scheduled_events WHERE id = $1', [p.eid]);
    await publishEvent(ctx, 'GUILD_SCHEDULED_EVENT_DELETE', cur);
    await audit(ctx, p.id, req.userId, 'GUILD_SCHEDULED_EVENT_DELETE', p.eid, { name: cur.name });
    return reply.code(204).send();
  });

  // ---------- interested users ----------
  app.get('/guilds/:id/scheduled-events/:eid/users', async (req) => {
    const p = parse(ep, req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), after: idSchema.optional(), withMember: z.enum(['true', 'false']).optional() }), req.query);
    const row = await load(p.id, p.eid); await visibleEvent(req.userId, row);
    const rows = await ctx.db.query('SELECT user_id FROM guild_scheduled_event_users WHERE event_id = $1 AND ($2::text IS NULL OR user_id > $2) ORDER BY user_id LIMIT $3', [p.eid, q.after ?? null, limitParam(q.limit, 100)]);
    const users = await usersByIds(ctx, rows.map((r) => r.user_id));
    const members = q.withMember === 'true' ? await membersDTO(ctx, await ctx.db.query('SELECT * FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])', [p.id, rows.map((r) => r.user_id)])) : [];
    return rows.map((r) => ({ guildScheduledEventId: p.eid, user: users.get(r.user_id), ...(q.withMember === 'true' ? { member: members.find((m) => m.user.id === r.user_id) ?? null } : {}) }));
  });
  app.put('/guilds/:id/scheduled-events/:eid/users/@me', async (req, reply) => {
    const p = parse(ep, req.params);
    limitOrThrow(ctx.rl, `event-interest:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const row = await load(p.id, p.eid); await visibleEvent(req.userId, row);
    if (row.status !== ST.SCHEDULED && row.status !== ST.ACTIVE) throw conflict('This event is over', 'EVENT_FINISHED');
    const ins = await ctx.db.query('INSERT INTO guild_scheduled_event_users (event_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [p.eid, req.userId]);
    if (ins.length) await ctx.hub.toGuild(p.id, 'GUILD_SCHEDULED_EVENT_USER_ADD', { guildScheduledEventId: p.eid, userId: req.userId, guildId: p.id }, row.channel_id ? { channelId: row.channel_id } : {});
    return reply.code(204).send();
  });
  app.delete('/guilds/:id/scheduled-events/:eid/users/@me', async (req, reply) => {
    const p = parse(ep, req.params);
    const row = await load(p.id, p.eid); await visibleEvent(req.userId, row);
    const del = await ctx.db.query('DELETE FROM guild_scheduled_event_users WHERE event_id = $1 AND user_id = $2 RETURNING user_id', [p.eid, req.userId]);
    if (del.length) await ctx.hub.toGuild(p.id, 'GUILD_SCHEDULED_EVENT_USER_REMOVE', { guildScheduledEventId: p.eid, userId: req.userId, guildId: p.id }, row.channel_id ? { channelId: row.channel_id } : {});
    return reply.code(204).send();
  });

  // ---------- stage instances ----------
  async function stageAccess(userId: string, channelId: string, moderate: boolean) {
    const a = await channelAccess(ctx, userId, channelId);
    if (a.channel.type !== 'stage' || !a.channel.guild_id) throw notFound('Channel');
    if (moderate) need(a.perms, Perm.MANAGE_CHANNELS, Perm.MUTE_MEMBERS, Perm.MOVE_MEMBERS); // Discord's "stage moderator" definition
    return a;
  }
  const topic = z.string().trim().min(1).max(120);
  app.post('/stage-instances', async (req, reply) => {
    const b = parse(z.object({ channelId: idSchema, topic, privacyLevel: z.literal(2).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `stage-create:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const a = await stageAccess(req.userId, b.channelId, true);
    const dto = await startStage(ctx, { id: snowflake(), guildId: a.channel.guild_id, channelId: b.channelId, topic: b.topic, createdBy: req.userId });
    if (!dto) throw conflict('A stage instance already exists in this channel', 'STAGE_EXISTS');
    return reply.code(201).send(dto);
  });
  app.get('/stage-instances/:channelId', async (req) => {
    const { channelId } = parse(z.object({ channelId: idSchema }), req.params);
    await stageAccess(req.userId, channelId, false);
    const [r] = await ctx.db.query('SELECT * FROM stage_instances WHERE channel_id = $1', [channelId]);
    if (!r) throw notFound('Stage instance');
    return stageDTO(r);
  });
  app.get('/guilds/:id/stage-instances', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await guildAccess(ctx, req.userId, id);
    const vis = new Set((await visibleChannelRows(ctx, id, req.userId)).map((c) => c.id as string));
    return (await ctx.db.query('SELECT * FROM stage_instances WHERE guild_id = $1 ORDER BY id', [id])).filter((r) => vis.has(r.channel_id)).map(stageDTO);
  });
  app.patch('/stage-instances/:channelId', async (req) => {
    const { channelId } = parse(z.object({ channelId: idSchema }), req.params);
    const b = parse(z.object({ topic, privacyLevel: z.literal(2) }).partial().strict(), req.body);
    const a = await stageAccess(req.userId, channelId, true);
    const [r] = b.topic ? await ctx.db.query('UPDATE stage_instances SET topic = $2 WHERE channel_id = $1 RETURNING *', [channelId, b.topic]) : await ctx.db.query('SELECT * FROM stage_instances WHERE channel_id = $1', [channelId]);
    if (!r) throw notFound('Stage instance');
    const dto = stageDTO(r);
    if (b.topic) { await ctx.hub.toChannel(channelId, 'STAGE_INSTANCE_UPDATE', dto); await audit(ctx, a.channel.guild_id, req.userId, 'STAGE_INSTANCE_UPDATE', r.id, { topic: b.topic }); }
    return dto;
  });
  app.delete('/stage-instances/:channelId', async (req, reply) => {
    const { channelId } = parse(z.object({ channelId: idSchema }), req.params);
    await stageAccess(req.userId, channelId, true);
    if (!(await endStage(ctx, channelId, req.userId))) throw notFound('Stage instance');
    return reply.code(204).send();
  });
}
export { eventDTO };
