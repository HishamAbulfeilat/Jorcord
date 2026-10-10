import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUTO_ARCHIVE_DURATIONS, Perm, has, snowflake, type ForumTag } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { checkVerification } from '../services/safety';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, limitParam, parse } from '../lib/ids';
import { randomToken, safeEqual } from '../lib/crypto';
import { limitOrThrow } from '../lib/ratelimit';
import { audit, insertChannel, visibleChannelRows } from '../services/guilds';
import { createMessage } from '../services/messages';
import { addGroupRecipient, removeGroupRecipient } from '../services/dms';
import { trackVisibility } from '../services/visibility';
import { joinThread, leaveThread } from '../services/threads';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, need, needOutrank, permsFor, loadOverwrites, viewersAmong } from '../services/perms';
import { channelDTO, channelsDTO, messageDTO } from '../services/serializers';

const GUILD_TYPES = ['text', 'voice', 'announcement', 'stage', 'forum', 'category'] as const;
const permStr = z.string().regex(/^\d{1,20}$/);
const owSchema = z.object({ id: idSchema, type: z.enum(['role', 'member']), allow: permStr, deny: permStr }).strict();
const chanFields = {
  name: z.string().trim().min(1).max(100), topic: z.string().max(1024).nullable(), nsfw: z.boolean(), slowmode: z.number().int().min(0).max(21600),
  bitrate: z.number().int().min(8000).max(510000).nullable(), userLimit: z.number().int().min(0).max(99).nullable(), parentId: idSchema.nullable(), position: z.number().int().min(0).max(10000),
};
const tagSchema = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(20), emoji: z.string().max(64).nullable().optional(), moderated: z.boolean().optional() }).strict();
const archiveDuration = z.number().int().refine((n) => (AUTO_ARCHIVE_DURATIONS as readonly number[]).includes(n), 'must be 60, 1440, 4320 or 10080');
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
    await ctx.pcache.invalidate({ k: 'overwrites', channelId });
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
    for (const e of list) await ctx.pcache.invalidate({ k: 'channel', channelId: e.id });
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
      allowed = z.object({ name: chanFields.name, archived: z.boolean(), slowmode: chanFields.slowmode, autoArchiveDuration: archiveDuration, locked: z.boolean(), appliedTags: z.array(idSchema).max(5) }).partial().strict();
    } else if (ch.type === 'group_dm') {
      allowed = z.object({ name: chanFields.name.nullable() }).partial().strict();
    } else if (ch.type === 'dm') throw forbidden('Cannot edit a DM');
    else {
      need(a.perms, Perm.MANAGE_CHANNELS);
      allowed = ch.type === 'forum'
        ? z.object({ ...chanFields, availableTags: z.array(tagSchema).max(20), requireTag: z.boolean(), defaultAutoArchiveDuration: archiveDuration }).partial().strict()
        : z.object(chanFields).partial().strict();
    }
    const b = parse(allowed, req.body) as Record<string, any>;
    if (ch.type === 'thread') {
      // locked threads: only MANAGE_THREADS may (un)lock or unarchive; moderated forum tags need MANAGE_THREADS too
      if ((b.locked !== undefined || (ch.locked && b.archived === false)) && !has(a.perms, Perm.MANAGE_THREADS)) throw forbidden('Missing permissions').num(50083);
      if (b.appliedTags !== undefined) b.appliedTags = await checkAppliedTags(ch.parent_id, b.appliedTags, has(a.perms, Perm.MANAGE_THREADS), ch.applied_tags ?? []);
    }
    if (b.availableTags !== undefined) b.availableTags = await normaliseTags(id, ch.available_tags ?? [], b.availableTags);
    if (b.parentId !== undefined) await validateParent(ch.guild_id, b.parentId, ch.type);
    const col: Record<string, string> = { name: 'name', topic: 'topic', nsfw: 'nsfw', slowmode: 'slowmode', bitrate: 'bitrate', userLimit: 'user_limit', parentId: 'parent_id', position: 'position', archived: 'archived',
      requireTag: 'require_tag', defaultAutoArchiveDuration: 'default_auto_archive', autoArchiveDuration: 'auto_archive_minutes', locked: 'locked', availableTags: 'available_tags', appliedTags: 'applied_tags' };
    const sets: string[] = [], vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { if (!col[k]) continue; vals.push(k === 'availableTags' || k === 'appliedTags' ? JSON.stringify(v) : v); sets.push(`${col[k]} = $${vals.length}${k === 'availableTags' || k === 'appliedTags' ? '::jsonb' : ''}`); }
    if (ch.type === 'thread' && (b.archived === false || b.autoArchiveDuration !== undefined)) sets.push('activity_at = now()'); // unarchiving / changing the timer restarts the idle clock
    if (b.availableTags !== undefined) { // tags removed from the catalogue disappear from posts
      const keep = new Set((b.availableTags as ForumTag[]).map((t) => t.id));
      for (const gone of (ch.available_tags as ForumTag[]).filter((t) => !keep.has(t.id))) await ctx.db.query(`UPDATE channels SET applied_tags = applied_tags - $2::text WHERE parent_id = $1 AND type = 'thread'`, [id, gone.id]);
    }
    if (sets.length) { await ctx.db.query(`UPDATE channels SET ${sets.join(', ')} WHERE id = $1`, vals); await ctx.pcache.invalidate({ k: 'channel', channelId: id }); }
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
    const dto = await channelDTO(ctx, row);
    if (ch.guild_id) await audit(ctx, ch.guild_id, req.userId, ch.type === 'thread' ? 'THREAD_UPDATE' : b.availableTags !== undefined ? 'FORUM_TAG_UPDATE' : 'CHANNEL_UPDATE', id, b);
    await ctx.hub.toChannel(id, ch.type === 'thread' ? 'THREAD_UPDATE' : 'CHANNEL_UPDATE', dto);
    return dto;
  });

  app.delete('/channels/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, id);
    const ch = a.channel;
    if (ch.type === 'dm') throw badRequest('DMs cannot be deleted');
    if (ch.type === 'group_dm') {
      await removeGroupRecipient(ctx, ch, req.userId);
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
    await ctx.pcache.invalidate({ k: 'channel', channelId: id });
    await audit(ctx, ch.guild_id, req.userId, ch.type === 'thread' ? 'THREAD_DELETE' : 'CHANNEL_DELETE', id, { name: ch.name, type: ch.type });
    if (ch.type === 'thread') await ctx.hub.toGuild(ch.guild_id, 'THREAD_DELETE', { id, guildId: ch.guild_id, parentId: ch.parent_id ?? null });
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
    const settled = await trackVisibility(ctx, a.channel.guild_id, { channelIds: [p.id] });
    await saveOverwrites(p.id, [{ id: p.overwriteId, ...b }]);
    await settled();
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
    const settled = await trackVisibility(ctx, a.channel.guild_id, { channelIds: [p.id] });
    const rows = await ctx.db.query('DELETE FROM overwrites WHERE channel_id = $1 AND target_id = $2 RETURNING type', [p.id, p.overwriteId]);
    if (!rows.length) throw notFound('Overwrite');
    await ctx.pcache.invalidate({ k: 'overwrites', channelId: p.id });
    await settled();
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

  // ---------- group DM recipients ----------
  app.put('/channels/:id/recipients/:userId', async (req) => {
    const p = parse(z.object({ id: idSchema, userId: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.type !== 'group_dm') throw badRequest('Recipients can only be added to group DMs (create a new group DM instead)');
    return addGroupRecipient(ctx, a.channel, req.userId, p.userId);
  });
  app.delete('/channels/:id/recipients/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.type !== 'group_dm') throw badRequest('Only group DMs have removable recipients');
    const target = p.userId === '@me' ? req.userId : p.userId;
    if (target !== req.userId && a.channel.owner_id !== req.userId) throw forbidden('Only the group owner can remove other people', 'NOT_OWNER');
    await removeGroupRecipient(ctx, a.channel, target);
    return reply.code(204).send();
  });

  // ---------- threads & forums ----------
  /** Tag catalogue edit: keep ids of existing tags, mint ids for new ones. */
  async function normaliseTags(_channelId: string, current: ForumTag[], incoming: z.infer<typeof tagSchema>[]): Promise<ForumTag[]> {
    const known = new Map(current.map((t) => [t.id, t]));
    const out = incoming.map((t) => {
      if (t.id && !known.has(t.id)) throw badRequest('Unknown tag id', { id: t.id });
      return { id: t.id ?? snowflake(), name: t.name, emoji: t.emoji ?? null, moderated: t.moderated ?? false };
    });
    if (new Set(out.map((t) => t.id)).size !== out.length) throw badRequest('Duplicate tag id');
    if (new Set(out.map((t) => t.name.toLowerCase())).size !== out.length) throw badRequest('Duplicate tag name');
    return out;
  }
  /** Applied tags must exist on the parent forum; applying/removing a moderated tag needs MANAGE_THREADS. */
  async function checkAppliedTags(parentId: string | null, wanted: string[], canModerate: boolean, previous: string[] = []): Promise<string[]> {
    const uniq = [...new Set(wanted)];
    if (!parentId) return uniq.length ? (() => { throw badRequest('This channel has no tags'); })() : [];
    const [p] = await ctx.db.query('SELECT available_tags, type FROM channels WHERE id = $1', [parentId]);
    const tags = new Map(((p?.available_tags ?? []) as ForumTag[]).map((t) => [t.id, t]));
    for (const t of uniq) if (!tags.has(t)) throw badRequest('Unknown tag', { id: t });
    for (const t of [...uniq.filter((x) => !previous.includes(x)), ...previous.filter((x) => !uniq.includes(x))]) if (tags.get(t)?.moderated && !canModerate) throw forbidden('That tag can only be managed by moderators');
    return uniq;
  }
  async function createThread(a: Awaited<ReturnType<typeof channelAccess>>, userId: string, id: string, name: string, o: { autoArchive?: number; appliedTags?: string[] } = {}) {
    await insertChannel(ctx.db, { id, guildId: a.channel.guild_id, type: 'thread', name, parentId: a.channel.id, ownerId: userId, slowmode: 0 });
    await ctx.db.query('UPDATE channels SET auto_archive_minutes = $2, applied_tags = $3::jsonb, activity_at = now() WHERE id = $1', [id, o.autoArchive ?? a.channel.default_auto_archive ?? 1440, JSON.stringify(o.appliedTags ?? [])]);
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
    const dto = await channelDTO(ctx, row);
    await ctx.db.query('INSERT INTO thread_members (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, userId]);
    await ctx.hub.toChannel(id, 'THREAD_CREATE', dto);
    return { row, dto };
  }
  app.post('/channels/:id/messages/:mid/threads', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, mid: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), autoArchiveDuration: archiveDuration.optional() }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!['text', 'announcement'].includes(a.channel.type)) throw badRequest('Threads can only be started in text channels');
    need(a.perms, Perm.CREATE_PUBLIC_THREADS, Perm.READ_MESSAGE_HISTORY);
    await checkVerification(ctx, a.channel.guild_id, req.userId, a.perms);
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.thread_id) throw conflict('Message already has a thread', 'THREAD_EXISTS');
    const { dto } = await createThread(a, req.userId, p.mid, b.name, { autoArchive: b.autoArchiveDuration }); // thread id = message id (unique by construction)
    await ctx.db.query('UPDATE messages SET thread_id = $2 WHERE id = $1', [p.mid, p.mid]);
    const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    await ctx.hub.toChannel(p.id, 'MESSAGE_UPDATE', await messageDTO(ctx, fresh, null));
    await audit(ctx, a.channel.guild_id, req.userId, 'THREAD_CREATE', p.mid, { name: b.name });
    return reply.code(201).send(dto);
  });

  app.post('/channels/:id/forum/posts', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), content: z.string().min(1), appliedTags: z.array(idSchema).max(5).optional(), autoArchiveDuration: archiveDuration.optional() }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, id);
    if (a.channel.type !== 'forum') throw badRequest('Not a forum channel');
    need(a.perms, Perm.CREATE_PUBLIC_THREADS, Perm.SEND_MESSAGES);
    await checkVerification(ctx, a.channel.guild_id, req.userId, a.perms);
    const tags = await checkAppliedTags(id, b.appliedTags ?? [], has(a.perms, Perm.MANAGE_THREADS));
    if (a.channel.require_tag && !tags.length) throw badRequest('This forum requires at least one tag');
    const { row, dto } = await createThread(a, req.userId, snowflake(), b.name, { autoArchive: b.autoArchiveDuration, appliedTags: tags });
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

  /** Threads of one parent channel. `state` = active | archived; archived supports `before=<threadId>` paging. */
  app.get('/channels/:id/threads/:state', async (req) => {
    const p = parse(z.object({ id: idSchema, state: z.enum(['active', 'archived']) }), req.params);
    const q = parse(z.object({ before: idSchema.optional(), limit: z.coerce.number().optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!['text', 'announcement', 'forum'].includes(a.channel.type)) throw badRequest('Channel cannot have threads');
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const limit = limitParam(q.limit, 25);
    const rows = await ctx.db.query(
      `SELECT * FROM channels WHERE parent_id = $1 AND type = 'thread' AND archived = $2 AND ($3::text IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [p.id, p.state === 'archived', q.before ?? null, limit + 1]);
    const threads = await channelsDTO(ctx, rows.slice(0, limit));
    return { threads, members: await myThreadMembers(threads.map((t) => t.id), req.userId), hasMore: rows.length > limit };
  });

  /** Every active thread in a guild the caller can see (e.g. to populate a sidebar on connect). */
  app.get('/guilds/:id/threads/active', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await guildAccess(ctx, req.userId, id);
    const rows = (await visibleChannelRows(ctx, id, req.userId, Perm.READ_MESSAGE_HISTORY)).filter((c) => c.type === 'thread');
    const threads = await channelsDTO(ctx, rows);
    return { threads, members: await myThreadMembers(threads.map((t) => t.id), req.userId) };
  });
  const myThreadMembers = async (threadIds: string[], userId: string) => !threadIds.length ? [] :
    (await ctx.db.query('SELECT thread_id, user_id, joined_at FROM thread_members WHERE user_id = $2 AND thread_id = ANY($1::text[])', [threadIds, userId]))
      .map((r) => ({ threadId: r.thread_id as string, userId: r.user_id as string, joinedAt: new Date(r.joined_at).toISOString() }));

  // ---------- thread membership ----------
  const threadAccess = async (userId: string, id: string) => {
    const a = await channelAccess(ctx, userId, id);
    if (a.channel.type !== 'thread') throw badRequest('Not a thread');
    return a;
  };
  app.get('/channels/:id/thread-members', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ after: idSchema.optional(), limit: z.coerce.number().optional() }), req.query);
    await threadAccess(req.userId, id);
    const rows = await ctx.db.query('SELECT user_id, joined_at FROM thread_members WHERE thread_id = $1 AND ($2::text IS NULL OR user_id > $2) ORDER BY user_id LIMIT $3', [id, q.after ?? null, limitParam(q.limit, 100)]);
    return rows.map((r) => ({ threadId: id, userId: r.user_id as string, joinedAt: new Date(r.joined_at).toISOString() }));
  });
  app.put('/channels/:id/thread-members/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    const a = await threadAccess(req.userId, p.id);
    if (a.channel.archived) throw badRequest('Thread is archived');
    const target = p.userId === '@me' ? req.userId : p.userId;
    if (target !== req.userId) {
      if (a.channel.owner_id !== req.userId) need(a.perms, Perm.MANAGE_THREADS);
      const ok = await viewersAmong(ctx, a.channel, [target]); // only people who can actually see the thread
      if (!ok.length) throw notFound('Member');
    }
    await joinThread(ctx, a.channel, target);
    return reply.code(204).send();
  });
  app.delete('/channels/:id/thread-members/:userId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, userId: z.union([idSchema, z.literal('@me')]) }), req.params);
    const a = await threadAccess(req.userId, p.id);
    const target = p.userId === '@me' ? req.userId : p.userId;
    if (target !== req.userId && a.channel.owner_id !== req.userId) need(a.perms, Perm.MANAGE_THREADS);
    await leaveThread(ctx, a.channel, target);
    return reply.code(204).send();
  });
}

/** Executes webhook messages (no user auth; the token is the credential). */
export function webhookPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/webhooks/:id/:token', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, token: z.string().min(10).max(100) }), req.params);
    const b = parse(z.object({
      content: z.string().min(1).max(4000),
      username: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/, 'invalid characters').optional(),
      avatarUrl: assetUrl.optional(), avatar_url: assetUrl.optional(),
    }).strict(), req.body);
    const [w] = await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]);
    if (!w || !safeEqual(w.token, p.token)) throw notFound('Webhook');
    limitOrThrow(ctx.rl, `webhook:${w.id}`, 60, 60_000, ctx.config.rateLimit);
    const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [w.channel_id]);
    if (!channel) throw notFound('Webhook');
    const msg = await createMessage(ctx, { channel, authorId: w.bot_user_id, content: b.content, webhookId: w.id, senderPerms: 0n, skipChecks: true, webhookUsername: b.username ?? null, webhookAvatar: b.avatarUrl ?? b.avatar_url ?? null });
    return reply.code(200).send(msg);
  });
}
export { permsFor, loadOverwrites };
