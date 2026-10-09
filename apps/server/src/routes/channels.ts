import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, has, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, limitParam, parse } from '../lib/ids';
import { randomToken, safeEqual } from '../lib/crypto';
import { audit, insertChannel, visibleChannelRows } from '../services/guilds';
import { createMessage } from '../services/messages';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, need, needOutrank, permsFor, loadOverwrites } from '../services/perms';
import { channelDTO, channelsDTO, messageDTO } from '../services/serializers';

const GUILD_TYPES = ['text', 'voice', 'announcement', 'stage', 'forum', 'category'] as const;
const permStr = z.string().regex(/^\d{1,20}$/);
const owSchema = z.object({ id: idSchema, type: z.enum(['role', 'member']), allow: permStr, deny: permStr }).strict();
const chanFields = {
  name: z.string().trim().min(1).max(100), topic: z.string().max(1024).nullable(), nsfw: z.boolean(), slowmode: z.number().int().min(0).max(21600),
  bitrate: z.number().int().min(8000).max(510000).nullable(), userLimit: z.number().int().min(0).max(99).nullable(), parentId: idSchema.nullable(), position: z.number().int().min(0).max(10000),
};
const createChannel = z.object({ ...chanFields, type: z.enum(GUILD_TYPES), overwrites: z.array(owSchema).max(100).optional() }).partial({ topic: true, nsfw: true, slowmode: true, bitrate: true, userLimit: true, parentId: true, position: true }).strict();

export function channelRoutes(app: FastifyInstance, ctx: Ctx) {
  async function validateParent(guildId: string, parentId: string | null | undefined, type: string) {
    if (!parentId) return;
    if (type === 'category') throw badRequest('Categories cannot be nested');
    const [p] = await ctx.db.query(`SELECT 1 AS x FROM channels WHERE id = $1 AND guild_id = $2 AND type = 'category'`, [parentId, guildId]);
    if (!p) throw badRequest('parentId must be a category in this guild');
  }
  /** Validates overwrite targets and that the actor is not granting bits they lack. */
  async function checkOverwrites(guildId: string, actorPerms: bigint, actor: Awaited<ReturnType<typeof loadGuildPerm>>, list: z.infer<typeof owSchema>[]) {
    for (const o of list) {
      const allow = BigInt(o.allow), deny = BigInt(o.deny);
      if (o.type === 'role') {
        const [r] = await ctx.db.query('SELECT position FROM roles WHERE id = $1 AND guild_id = $2', [o.id, guildId]);
        if (!r) throw badRequest('Unknown role in overwrite');
        if (o.id !== guildId && actor) needOutrank(actor, r.position);
      } else {
        const [m] = await ctx.db.query('SELECT 1 AS x FROM members WHERE user_id = $1 AND guild_id = $2', [o.id, guildId]);
        if (!m) throw badRequest('Unknown member in overwrite');
      }
      if (!has(actorPerms, Perm.ADMINISTRATOR) && (allow & ~actorPerms) !== 0n) throw forbidden('Cannot grant permissions you do not have', 'ESCALATION');
    }
  }
  const saveOverwrites = async (channelId: string, list: z.infer<typeof owSchema>[]) => {
    for (const o of list) await ctx.db.query(`INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (channel_id, target_id) DO UPDATE SET type = $3, allow = $4, deny = $5`, [channelId, o.id, o.type, o.allow, o.deny]);
  };

  app.get('/guilds/:id/channels', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await guildAccess(ctx, req.userId, id);
    return channelsDTO(ctx, await visibleChannelRows(ctx, id, req.userId));
  });

  app.post('/guilds/:id/channels', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(createChannel, req.body);
    const gp = await guildAccess(ctx, req.userId, id);
    const perms = guildPerms(gp);
    need(perms, Perm.MANAGE_CHANNELS);
    await validateParent(id, b.parentId, b.type);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n, coalesce(max(position), -1)::int AS mx FROM channels WHERE guild_id = $1 AND type <> \'thread\'', [id]);
    if (c.n >= 500) throw new ApiError(400, 'MAX_CHANNELS', 'Channel limit reached');
    await checkOverwrites(id, perms, gp, b.overwrites ?? []);
    const cid = await insertChannel(ctx.db, { guildId: id, type: b.type, name: b.name, topic: b.topic, position: b.position ?? c.mx + 1, parentId: b.parentId, nsfw: b.nsfw, slowmode: b.slowmode, bitrate: b.bitrate, userLimit: b.userLimit });
    await saveOverwrites(cid, b.overwrites ?? []);
    await audit(ctx, id, req.userId, 'CHANNEL_CREATE', cid, { name: b.name, type: b.type });
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [cid]);
    const dto = await channelDTO(ctx, row);
    await ctx.hub.toChannel(cid, 'CHANNEL_CREATE', dto);
    return reply.code(201).send(dto);
  });

  app.patch('/guilds/:id/channels', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const list = parse(z.array(z.object({ id: idSchema, position: z.number().int().min(0).max(10000), parentId: idSchema.nullable().optional() }).strict()).min(1).max(500), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_CHANNELS);
    const rows = await ctx.db.query(`SELECT id, type FROM channels WHERE guild_id = $1 AND type <> 'thread'`, [id]);
    const byId = new Map(rows.map((r) => [r.id, r.type as string]));
    for (const e of list) {
      if (!byId.has(e.id)) throw badRequest('Unknown channel in list');
      if (e.parentId !== undefined && e.parentId !== null && byId.get(e.parentId) !== 'category') throw badRequest('parentId must be a category');
      if (e.parentId && byId.get(e.id) === 'category') throw badRequest('Categories cannot be nested');
    }
    await ctx.db.tx(async (q) => {
      for (const e of list) {
        if (e.parentId !== undefined) await q.query('UPDATE channels SET position = $2, parent_id = $3 WHERE id = $1 AND guild_id = $4', [e.id, e.position, e.parentId, id]);
        else await q.query('UPDATE channels SET position = $2 WHERE id = $1 AND guild_id = $3', [e.id, e.position, id]);
      }
    });
    const out = await channelsDTO(ctx, await ctx.db.query('SELECT * FROM channels WHERE id = ANY($1::text[])', [list.map((l) => l.id)]));
    for (const ch of out) await ctx.hub.toChannel(ch.id, 'CHANNEL_UPDATE', ch);
    await audit(ctx, id, req.userId, 'CHANNEL_REORDER', null, list);
    return out;
  });

  app.get('/channels/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    return channelDTO(ctx, (await channelAccess(ctx, req.userId, id)).channel);
  });

  app.patch('/channels/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, id);
    const ch = a.channel;
    let allowed: z.ZodTypeAny;
    if (ch.type === 'thread') {
      if (ch.owner_id !== req.userId) need(a.perms, Perm.MANAGE_THREADS);
      allowed = z.object({ name: chanFields.name, archived: z.boolean(), slowmode: chanFields.slowmode }).partial().strict();
    } else if (ch.type === 'group_dm') {
      allowed = z.object({ name: chanFields.name.nullable() }).partial().strict();
    } else if (ch.type === 'dm') throw forbidden('Cannot edit a DM');
    else {
      need(a.perms, Perm.MANAGE_CHANNELS);
      allowed = z.object(chanFields).partial().strict();
    }
    const b = parse(allowed, req.body) as Record<string, any>;
    if (b.parentId !== undefined) await validateParent(ch.guild_id, b.parentId, ch.type);
    const col: Record<string, string> = { name: 'name', topic: 'topic', nsfw: 'nsfw', slowmode: 'slowmode', bitrate: 'bitrate', userLimit: 'user_limit', parentId: 'parent_id', position: 'position', archived: 'archived' };
    const sets: string[] = [], vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { if (!col[k]) continue; vals.push(v); sets.push(`${col[k]} = $${vals.length}`); }
    if (sets.length) await ctx.db.query(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1`, vals);
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
    const dto = await channelDTO(ctx, row);
    if (ch.guild_id) await audit(ctx, ch.guild_id, req.userId, ch.type === 'thread' ? 'THREAD_UPDATE' : 'CHANNEL_UPDATE', id, b);
    await ctx.hub.toChannel(id, ch.type === 'thread' ? 'THREAD_UPDATE' : 'CHANNEL_UPDATE', dto);
    return dto;
  });

  app.delete('/channels/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, id);
    const ch = a.channel;
    if (ch.type === 'dm') throw badRequest('DMs cannot be deleted');
    if (ch.type === 'group_dm') {
      await ctx.db.query('DELETE FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [id, req.userId]);
      await ctx.hub.toUser(req.userId, 'CHANNEL_DELETE', { id, guildId: null });
      const [left] = await ctx.db.query('SELECT count(*)::int AS n FROM dm_participants WHERE channel_id = $1', [id]);
      if (left.n === 0) await ctx.db.query('DELETE FROM channels WHERE id = $1', [id]);
      return reply.code(204).send();
    }
    if (ch.type === 'thread') { if (ch.owner_id !== req.userId) need(a.perms, Perm.MANAGE_THREADS); } else need(a.perms, Perm.MANAGE_CHANNELS);
    const [g] = await ctx.db.query('SELECT system_channel_id, rules_channel_id FROM guilds WHERE id = $1', [ch.guild_id]);
    await ctx.db.tx(async (q) => {
      await q.query('DELETE FROM channels WHERE parent_id = $1 AND type = \'thread\'', [id]);
      await q.query('UPDATE channels SET parent_id = NULL WHERE parent_id = $1', [id]);
      await q.query('UPDATE guilds SET system_channel_id = NULLIF(system_channel_id, $1), rules_channel_id = NULLIF(rules_channel_id, $1) WHERE id = $2', [id, ch.guild_id]);
      await q.query('DELETE FROM channels WHERE id = $1', [id]);
    });
    void g;
    await audit(ctx, ch.guild_id, req.userId, 'CHANNEL_DELETE', id, { name: ch.name, type: ch.type });
    await ctx.hub.toGuild(ch.guild_id, 'CHANNEL_DELETE', { id, guildId: ch.guild_id });
    return reply.code(204).send();
  });

  // ---------- permission overwrites ----------
  app.put('/channels/:id/permissions/:overwriteId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, overwriteId: idSchema }), req.params);
    const b = parse(z.object({ type: z.enum(['role', 'member']), allow: permStr, deny: permStr }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!a.channel.guild_id || a.channel.type === 'thread') throw badRequest('Overwrites apply to guild channels only');
    need(a.perms, Perm.MANAGE_ROLES);
    await checkOverwrites(a.channel.guild_id, a.perms, a.gp, [{ id: p.overwriteId, ...b }]);
    await saveOverwrites(p.id, [{ id: p.overwriteId, ...b }]);
    await audit(ctx, a.channel.guild_id, req.userId, 'OVERWRITE_UPDATE', p.id, { target: p.overwriteId, ...b });
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [p.id]);
    await ctx.hub.toChannel(p.id, 'CHANNEL_UPDATE', await channelDTO(ctx, row));
    return reply.code(204).send();
  });
  app.delete('/channels/:id/permissions/:overwriteId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, overwriteId: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!a.channel.guild_id) throw badRequest('Overwrites apply to guild channels only');
    need(a.perms, Perm.MANAGE_ROLES);
    const rows = await ctx.db.query('DELETE FROM overwrites WHERE channel_id = $1 AND target_id = $2 RETURNING type', [p.id, p.overwriteId]);
    if (!rows.length) throw notFound('Overwrite');
    await audit(ctx, a.channel.guild_id, req.userId, 'OVERWRITE_DELETE', p.id, { target: p.overwriteId });
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [p.id]);
    await ctx.hub.toChannel(p.id, 'CHANNEL_UPDATE', await channelDTO(ctx, row));
    return reply.code(204).send();
  });

  // ---------- webhooks ----------
  const hookDTO = (w: any, withToken: boolean) => ({ id: w.id, guildId: w.guild_id, channelId: w.channel_id, name: w.name, avatar: w.avatar ?? null, ...(withToken ? { token: w.token } : {}) });
  app.get('/channels/:id/webhooks', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, id);
    if (!a.channel.guild_id) throw badRequest('Webhooks are guild-only');
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    return (await ctx.db.query('SELECT * FROM webhooks WHERE channel_id = $1 ORDER BY id', [id])).map((w) => hookDTO(w, true));
  });
  app.post('/channels/:id/webhooks', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), avatar: assetUrl.nullable().optional() }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, id);
    if (!a.channel.guild_id || !['text', 'announcement'].includes(a.channel.type)) throw badRequest('Webhooks need a text channel');
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    const wid = snowflake(), botId = snowflake();
    await ctx.db.tx(async (q) => {
      await q.query(`INSERT INTO users (id, username, display_name, avatar, bot) VALUES ($1,$2,$3,$4,true)`, [botId, b.name, b.name, b.avatar ?? null]);
      await q.query('INSERT INTO webhooks (id, guild_id, channel_id, name, avatar, token, bot_user_id, creator_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [wid, a.channel.guild_id, id, b.name, b.avatar ?? null, randomToken(36), botId, req.userId]);
    });
    await audit(ctx, a.channel.guild_id, req.userId, 'WEBHOOK_CREATE', wid, { name: b.name });
    return reply.code(201).send(hookDTO((await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [wid]))[0], true));
  });
  app.delete('/channels/:id/webhooks/:webhookId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, webhookId: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    const rows = await ctx.db.query('DELETE FROM webhooks WHERE id = $1 AND channel_id = $2 RETURNING bot_user_id', [p.webhookId, p.id]);
    if (!rows.length) throw notFound('Webhook');
    await audit(ctx, a.channel.guild_id, req.userId, 'WEBHOOK_DELETE', p.webhookId);
    return reply.code(204).send();
  });

  // ---------- threads & forums ----------
  async function createThread(a: Awaited<ReturnType<typeof channelAccess>>, userId: string, id: string, name: string) {
    await insertChannel(ctx.db, { id, guildId: a.channel.guild_id, type: 'thread', name, parentId: a.channel.id, ownerId: userId, slowmode: 0 });
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
    const dto = await channelDTO(ctx, row);
    await ctx.hub.toChannel(id, 'THREAD_CREATE', dto);
    return { row, dto };
  }
  app.post('/channels/:id/messages/:mid/threads', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, mid: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100) }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!['text', 'announcement'].includes(a.channel.type)) throw badRequest('Threads can only be started in text channels');
    need(a.perms, Perm.CREATE_PUBLIC_THREADS, Perm.READ_MESSAGE_HISTORY);
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.thread_id) throw conflict('Message already has a thread', 'THREAD_EXISTS');
    const { dto } = await createThread(a, req.userId, p.mid, b.name); // thread id = message id (unique by construction)
    await ctx.db.query('UPDATE messages SET thread_id = $2 WHERE id = $1', [p.mid, p.mid]);
    const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    await ctx.hub.toChannel(p.id, 'MESSAGE_UPDATE', await messageDTO(ctx, fresh, null));
    await audit(ctx, a.channel.guild_id, req.userId, 'THREAD_CREATE', p.mid, { name: b.name });
    return reply.code(201).send(dto);
  });

  app.post('/channels/:id/forum/posts', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), content: z.string().min(1) }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, id);
    if (a.channel.type !== 'forum') throw badRequest('Not a forum channel');
    need(a.perms, Perm.CREATE_PUBLIC_THREADS, Perm.SEND_MESSAGES);
    const { row, dto } = await createThread(a, req.userId, snowflake(), b.name);
    const message = await createMessage(ctx, { channel: row, authorId: req.userId, content: b.content, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds });
    return reply.code(201).send({ channel: dto, message });
  });

  app.get('/channels/:id/threads', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ archived: z.enum(['true', 'false']).optional(), limit: z.coerce.number().optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const rows = await ctx.db.query(`SELECT * FROM channels WHERE parent_id = $1 AND type = 'thread' AND archived = $2 ORDER BY last_message_id DESC NULLS LAST, id DESC LIMIT $3`, [id, q.archived === 'true', limitParam(q.limit)]);
    return channelsDTO(ctx, rows);
  });
}

/** Executes webhook messages (no user auth; the token is the credential). */
export function webhookPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/webhooks/:id/:token', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, token: z.string().min(10).max(100) }), req.params);
    const b = parse(z.object({ content: z.string().min(1).max(4000) }).strict(), req.body);
    const [w] = await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]);
    if (!w || !safeEqual(w.token, p.token)) throw notFound('Webhook');
    const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [w.channel_id]);
    if (!channel) throw notFound('Webhook');
    const msg = await createMessage(ctx, { channel, authorId: w.bot_user_id, content: b.content, webhookId: w.id, senderPerms: 0n, skipChecks: true });
    return reply.code(200).send(msg);
  });
}
export { permsFor, loadOverwrites };
