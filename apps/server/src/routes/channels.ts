import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUTO_ARCHIVE_DURATIONS, Perm, has, snowflake, type ForumTag } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { checkVerification } from '../services/safety';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, limitParam, parse } from '../lib/ids';
import { randomToken, safeEqual } from '../lib/crypto';
import { assertNotLocked, recordFailure, webhookGuardKeys } from '../lib/bruteforce';
import { limitOrThrow } from '../lib/ratelimit';
import { audit, insertChannel, visibleChannelRows } from '../services/guilds';
import { createMessage, isMediaAttachment } from '../services/messages';
import { claimAttachments } from '../services/files';
import { parseEmbeds } from '../lib/embeds';
import { parseComponents } from '../lib/components';
import { addGroupRecipient, removeGroupRecipient } from '../services/dms';
import { trackVisibility } from '../services/visibility';
import { joinThread, leaveThread } from '../services/threads';
import { channelAccess, guildAccess, guildPerms, loadGuildPerm, need, needOutrank, permsFor, loadOverwrites, viewersAmong } from '../services/perms';
import { channelDTO, channelsDTO, messageDTO } from '../services/serializers';

const GUILD_TYPES = ['text', 'voice', 'announcement', 'stage', 'forum', 'media', 'category'] as const;
const permStr = z.string().regex(/^\d{1,20}$/);
const owSchema = z.object({ id: idSchema, type: z.enum(['role', 'member']), allow: permStr, deny: permStr }).strict();
const chanFields = {
  name: z.string().trim().min(1).max(100), topic: z.string().max(1024).nullable(), nsfw: z.boolean(), slowmode: z.number().int().min(0).max(21600),
  bitrate: z.number().int().min(8000).max(510000).nullable(), userLimit: z.number().int().min(0).max(99).nullable(), parentId: idSchema.nullable(), position: z.number().int().min(0).max(10000),
  isClipsChannel: z.boolean(),
};
const tagSchema = z.object({ id: idSchema.optional(), name: z.string().trim().min(1).max(20), emoji: z.string().max(64).nullable().optional(), moderated: z.boolean().optional() }).strict();
const archiveDuration = z.number().int().refine((n) => (AUTO_ARCHIVE_DURATIONS as readonly number[]).includes(n), 'must be 60, 1440, 4320 or 10080');
const createChannel = z.object({ ...chanFields, type: z.enum(GUILD_TYPES), overwrites: z.array(owSchema).max(100).optional() }).partial({ topic: true, nsfw: true, slowmode: true, bitrate: true, userLimit: true, parentId: true, position: true, isClipsChannel: true }).strict();

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
    const cid = await insertChannel(ctx.db, { guildId: id, type: b.type, name: b.name, topic: b.topic, position: b.position ?? c.mx + 1, parentId: b.parentId, nsfw: b.nsfw, slowmode: b.slowmode, bitrate: b.bitrate, userLimit: b.userLimit, isClipsChannel: b.isClipsChannel });
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
      allowed = z.object({ name: chanFields.name.nullable(), icon: assetUrl.nullable(), ownerId: idSchema }).partial().strict();
    } else if (ch.type === 'dm') throw forbidden('Cannot edit a DM');
    else {
      need(a.perms, Perm.MANAGE_CHANNELS);
      allowed = ch.type === 'forum' || ch.type === 'media'
        ? z.object({ ...chanFields, availableTags: z.array(tagSchema).max(20), requireTag: z.boolean(), defaultAutoArchiveDuration: archiveDuration, defaultSortOrder: z.enum(['latest_activity', 'creation_date']), defaultForumLayout: z.enum(['list', 'gallery']), defaultReactionEmoji: z.string().min(1).max(64).regex(/^(\w{2,32}:\d{1,20}|\S{1,16})$/u, 'must be a unicode emoji or `name:id`').nullable() }).partial().strict()
        : z.object(chanFields).partial().strict();
    }
    const b = parse(allowed, req.body) as Record<string, any>;
    if (ch.type === 'thread') {
      // locked threads: only MANAGE_THREADS may (un)lock or unarchive; moderated forum tags need MANAGE_THREADS too
      if ((b.locked !== undefined || (ch.locked && b.archived === false)) && !has(a.perms, Perm.MANAGE_THREADS)) throw forbidden('Missing permissions').num(50083);
      if (b.appliedTags !== undefined) b.appliedTags = await checkAppliedTags(ch.parent_id, b.appliedTags, has(a.perms, Perm.MANAGE_THREADS), ch.applied_tags ?? []);
    }
    if (ch.type === 'group_dm' && b.ownerId !== undefined && b.ownerId !== ch.owner_id) { // ownership transfer: current owner -> another participant
      if (ch.owner_id !== req.userId) throw forbidden('Only the group owner can transfer ownership', 'NOT_OWNER');
      const [part] = await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [id, b.ownerId]);
      if (!part) throw badRequest('The new owner must be a participant of the group');
    }
    if (typeof b.defaultReactionEmoji === 'string') { // a custom default must be one of THIS server's emoji; it is added automatically to every post
      const custom = b.defaultReactionEmoji.match(/^(\w{2,32}):(\d{1,20})$/);
      if (custom) {
        const [em] = await ctx.db.query('SELECT 1 AS x FROM emojis WHERE id = $1 AND name = $2 AND guild_id = $3', [custom[2], custom[1], ch.guild_id]);
        if (!em) throw badRequest('Unknown custom emoji');
      } else if (/[\u0000-\u001f<>:]/.test(b.defaultReactionEmoji)) throw badRequest('Invalid emoji');
    }
    if (b.availableTags !== undefined) b.availableTags = await normaliseTags(id, ch.available_tags ?? [], b.availableTags);
    if (b.parentId !== undefined) await validateParent(ch.guild_id, b.parentId, ch.type);
    const col: Record<string, string> = { icon: 'icon', ownerId: 'owner_id', name: 'name', topic: 'topic', nsfw: 'nsfw', slowmode: 'slowmode', bitrate: 'bitrate', userLimit: 'user_limit', parentId: 'parent_id', position: 'position', archived: 'archived',
      requireTag: 'require_tag', defaultAutoArchiveDuration: 'default_auto_archive', autoArchiveDuration: 'auto_archive_minutes', locked: 'locked', availableTags: 'available_tags', appliedTags: 'applied_tags', defaultSortOrder: 'default_sort_order', defaultForumLayout: 'default_forum_layout', defaultReactionEmoji: 'default_reaction_emoji', isClipsChannel: 'is_clips_channel' };
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
    // child threads die with their parent: remember them so clients can drop them too
    const threads = ch.type === 'thread' ? [] : await ctx.db.query<{ id: string }>('SELECT id FROM channels WHERE parent_id = $1 AND type = \'thread\'', [id]);
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
    else for (const t of threads) await ctx.hub.toGuild(ch.guild_id, 'THREAD_DELETE', { id: t.id, guildId: ch.guild_id, parentId: id });
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
    if (p.overwriteId !== a.channel.guild_id && a.gp) { // same hierarchy rule as PUT: no editing the overwrite of a role at or above your own
      const [r] = await ctx.db.query('SELECT position FROM roles WHERE id = $1 AND guild_id = $2', [p.overwriteId, a.channel.guild_id]);
      if (r) needOutrank(a.gp, r.position);
    }
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
  const hookDTO = (w: any, withToken: boolean) => ({ id: w.id, guildId: w.guild_id, channelId: w.channel_id, name: w.name, avatar: w.avatar ?? null, ...(withToken ? { token: w.token, url: `/webhooks/${w.id}/${w.token}` } : {}) });
  /** Guild-wide webhook list (MANAGE_WEBHOOKS). */
  app.get('/guilds/:id/webhooks', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const gp = await guildAccess(ctx, req.userId, id);
    need(guildPerms(gp), Perm.MANAGE_WEBHOOKS);
    return (await ctx.db.query('SELECT * FROM webhooks WHERE guild_id = $1 ORDER BY channel_id, id', [id])).map((w) => hookDTO(w, true));
  });
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
    await ctx.hub.toGuild(a.channel.guild_id, 'WEBHOOKS_UPDATE', { guildId: a.channel.guild_id, channelId: id });
    return reply.code(201).send(hookDTO((await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [wid]))[0], true));
  });
  app.delete('/channels/:id/webhooks/:webhookId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, webhookId: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    const rows = await ctx.db.query('DELETE FROM webhooks WHERE id = $1 AND channel_id = $2 RETURNING bot_user_id', [p.webhookId, p.id]);
    if (!rows.length) throw notFound('Webhook');
    await ctx.db.query('DELETE FROM users WHERE id = $1', [rows[0]!.bot_user_id]); // the webhook's identity user
    await audit(ctx, a.channel.guild_id, req.userId, 'WEBHOOK_DELETE', p.webhookId);
    await ctx.hub.toGuild(a.channel.guild_id, 'WEBHOOKS_UPDATE', { guildId: a.channel.guild_id, channelId: p.id });
    return reply.code(204).send();
  });

  /** Tokenless webhook management by webhook id (Discord-shape). Needs MANAGE_WEBHOOKS in the webhook's channel. */
  const webhookById = async (webhookId: string) => {
    const [w] = await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [webhookId]);
    if (!w) throw notFound('Webhook');
    return w;
  };
  const hookWriteBody = z.object({
    name: z.string().trim().min(1).max(80).optional(),
    avatar: assetUrl.nullable().optional(),
    /** Move the webhook to another text/announcement channel of the same guild (MANAGE_WEBHOOKS there is not required; MANAGE_WEBHOOKS on the current channel is). */
    channelId: idSchema.optional(),
  }).strict();
  const patchWebhook = async (w: any, b: z.infer<typeof hookWriteBody>) => {
    if (b.channelId !== undefined && b.channelId !== w.channel_id) {
      const [target] = await ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [b.channelId, w.guild_id]);
      if (!target || !['text', 'announcement'].includes(target.type)) throw badRequest('Webhooks need a text channel');
      await ctx.db.query('UPDATE webhooks SET channel_id = $2 WHERE id = $1', [w.id, b.channelId]);
    }
    if (b.name !== undefined) {
      await ctx.db.query('UPDATE webhooks SET name = $2 WHERE id = $1', [w.id, b.name]);
      await ctx.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [w.bot_user_id, b.name]);
    }
    if (b.avatar !== undefined) { // explicit null clears it
      await ctx.db.query('UPDATE webhooks SET avatar = $2 WHERE id = $1', [w.id, b.avatar]);
      await ctx.db.query('UPDATE users SET avatar = $2 WHERE id = $1', [w.bot_user_id, b.avatar]);
    }
    return (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [w.id]))[0];
  };
  app.get('/webhooks/:webhookId', async (req) => {
    const p = parse(z.object({ webhookId: idSchema }), req.params);
    const w = await webhookById(p.webhookId);
    const a = await channelAccess(ctx, req.userId, w.channel_id);
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    return hookDTO(w, false);
  });
  app.patch('/webhooks/:webhookId', async (req) => {
    const p = parse(z.object({ webhookId: idSchema }), req.params);
    const b = parse(hookWriteBody, req.body);
    const w = await webhookById(p.webhookId);
    const a = await channelAccess(ctx, req.userId, w.channel_id);
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    if (b.channelId !== undefined && b.channelId !== w.channel_id) { // MANAGE_WEBHOOKS on the destination channel too
      const dest = await channelAccess(ctx, req.userId, b.channelId);
      need(dest.perms, Perm.MANAGE_WEBHOOKS);
    }
    const w2 = await patchWebhook(w, b);
    await audit(ctx, w.guild_id, req.userId, 'WEBHOOK_UPDATE', w.id, { name: w2.name, channelId: w2.channel_id });
    await ctx.hub.toGuild(w.guild_id, 'WEBHOOKS_UPDATE', { guildId: w.guild_id, channelId: w2.channel_id });
    return hookDTO(w2, true);
  });

  app.delete('/webhooks/:webhookId', async (req, reply) => {
    const p = parse(z.object({ webhookId: idSchema }), req.params);
    const w = await webhookById(p.webhookId);
    const a = await channelAccess(ctx, req.userId, w.channel_id);
    need(a.perms, Perm.MANAGE_WEBHOOKS);
    await ctx.db.query('DELETE FROM webhooks WHERE id = $1', [w.id]);
    await ctx.db.query('DELETE FROM users WHERE id = $1', [w.bot_user_id]);
    await audit(ctx, w.guild_id, req.userId, 'WEBHOOK_DELETE', w.id);
    await ctx.hub.toGuild(w.guild_id, 'WEBHOOKS_UPDATE', { guildId: w.guild_id, channelId: w.channel_id });
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
  async function createThread(a: Awaited<ReturnType<typeof channelAccess>>, userId: string, id: string, name: string, o: { autoArchive?: number; appliedTags?: string[]; private?: boolean; invitable?: boolean } = {}) {
    await insertChannel(ctx.db, { id, guildId: a.channel.guild_id, type: 'thread', name, parentId: a.channel.id, ownerId: userId, slowmode: 0 });
    await ctx.db.query('UPDATE channels SET auto_archive_minutes = $2, applied_tags = $3::jsonb, activity_at = now(), thread_private = $4, thread_invitable = $5 WHERE id = $1', [id, o.autoArchive ?? a.channel.default_auto_archive ?? 1440, JSON.stringify(o.appliedTags ?? []), !!o.private, o.invitable ?? true]);
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

  /** Start a thread without a starter message. Private threads need CREATE_PRIVATE_THREADS and are visible to their members only. */
  app.post('/channels/:id/threads', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), type: z.enum(['public', 'private']).default('public'), invitable: z.boolean().optional(), autoArchiveDuration: archiveDuration.optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `thread-create:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, id);
    const isPrivate = b.type === 'private';
    if (!(isPrivate ? a.channel.type === 'text' : ['text', 'announcement'].includes(a.channel.type))) throw badRequest(isPrivate ? 'Private threads can only be started in text channels' : 'Threads can only be started in text channels');
    need(a.perms, isPrivate ? Perm.CREATE_PRIVATE_THREADS : Perm.CREATE_PUBLIC_THREADS);
    await checkVerification(ctx, a.channel.guild_id, req.userId, a.perms);
    const { dto } = await createThread(a, req.userId, snowflake(), b.name, { autoArchive: b.autoArchiveDuration, private: isPrivate, invitable: isPrivate ? b.invitable ?? true : undefined });
    await audit(ctx, a.channel.guild_id, req.userId, 'THREAD_CREATE', dto.id, { name: b.name, private: isPrivate });
    return reply.code(201).send(dto);
  });

  app.post('/channels/:id/forum/posts', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(100), content: z.string().min(1).optional(), appliedTags: z.array(idSchema).max(5).optional(), autoArchiveDuration: archiveDuration.optional(), attachments: z.array(idSchema).max(10).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `forum-post:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, id);
    const isMedia = a.channel.type === 'media';
    if (a.channel.type !== 'forum' && !isMedia) throw badRequest('Not a forum channel');
    if (!isMedia && !b.content) throw badRequest('A post needs content');
    need(a.perms, Perm.CREATE_PUBLIC_THREADS, Perm.SEND_MESSAGES);
    await checkVerification(ctx, a.channel.guild_id, req.userId, a.perms);
    const tags = await checkAppliedTags(id, b.appliedTags ?? [], has(a.perms, Perm.MANAGE_THREADS));
    if (a.channel.require_tag && !tags.length) throw badRequest('This forum requires at least one tag');
    if (b.attachments?.length) need(a.perms, Perm.ATTACH_FILES);
    const attachments = await claimAttachments(ctx, req.userId, b.attachments ?? []);
    try {
      // A media post must carry an image or video: check before the thread exists, so a rejected post leaves nothing behind.
      if (isMedia && !attachments.some(isMediaAttachment)) throw badRequest('Media channels only accept posts with an image or video');
      const { row, dto } = await createThread(a, req.userId, snowflake(), b.name, { autoArchive: b.autoArchiveDuration, appliedTags: tags });
      let message = await createMessage(ctx, { channel: row, authorId: req.userId, content: b.content ?? '', attachments, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds, requireMedia: isMedia });
      // A forum's default reaction emoji is added by the author to every newly created post.
      const dre: string | null | undefined = a.channel.default_reaction_emoji;
      if (dre) {
        const custom = dre.match(/^(\w{2,32}):(\d{1,20})$/);
        const e = { emoji: custom?.[1] ?? dre, emojiId: custom?.[2] ?? null };
        await ctx.db.query('INSERT INTO reactions (message_id, user_id, emoji, emoji_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [message.id, req.userId, e.emoji, e.emojiId]);
        await ctx.hub.toChannel(message.channelId, 'MESSAGE_REACTION_ADD', { messageId: message.id, channelId: message.channelId, userId: req.userId, emoji: e.emoji, emojiId: e.emojiId });
        const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [message.id]);
        message = await messageDTO(ctx, fresh, req.userId);
      }
      return reply.code(201).send({ channel: dto, message });
    } catch (e) {
      if (attachments.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]);
      throw e;
    }
  });

  app.get('/channels/:id/threads', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ archived: z.enum(['true', 'false']).optional(), limit: z.coerce.number().optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const rows = await ctx.db.query(`SELECT * FROM channels WHERE parent_id = $1 AND type = 'thread' AND archived = $2 ORDER BY last_message_id DESC NULLS LAST, id DESC LIMIT $3`, [id, q.archived === 'true', limitParam(q.limit)]);
    return channelsDTO(ctx, await onlyVisibleThreads(rows, a.perms, req.userId));
  });

  /** Threads of one parent channel. `state` = active | archived; archived supports `before=<threadId>` paging. */
  app.get('/channels/:id/threads/:state', async (req) => {
    const p = parse(z.object({ id: idSchema, state: z.enum(['active', 'archived']) }), req.params);
    const q = parse(z.object({ before: idSchema.optional(), limit: z.coerce.number().optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!['text', 'announcement', 'forum', 'media'].includes(a.channel.type)) throw badRequest('Channel cannot have threads');
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const limit = limitParam(q.limit, 25);
    const rows = await ctx.db.query(
      `SELECT * FROM channels WHERE parent_id = $1 AND type = 'thread' AND archived = $2 AND ($3::text IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
      [p.id, p.state === 'archived', q.before ?? null, limit + 1]);
    const threads = await channelsDTO(ctx, await onlyVisibleThreads(rows.slice(0, limit), a.perms, req.userId));
    return { threads, members: await myThreadMembers(threads.map((t) => t.id), req.userId), hasMore: rows.length > limit };
  });
  /** Drops private threads the caller may not see (not a member, not the owner, no MANAGE_THREADS). */
  const onlyVisibleThreads = async (rows: any[], parentPerms: bigint, userId: string) => {
    const priv = rows.filter((r) => r.thread_private);
    if (!priv.length || has(parentPerms, Perm.MANAGE_THREADS)) return rows;
    const mine = new Set((await ctx.db.query('SELECT thread_id FROM thread_members WHERE user_id = $2 AND thread_id = ANY($1::text[])', [priv.map((r) => r.id), userId])).map((r) => r.thread_id as string));
    return rows.filter((r) => !r.thread_private || mine.has(r.id) || r.owner_id === userId);
  };

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
      // private + not invitable: only the owner / MANAGE_THREADS may add people; otherwise any member of a private thread may
      if (a.channel.owner_id !== req.userId && !(a.channel.thread_private && a.channel.thread_invitable !== false)) need(a.perms, Perm.MANAGE_THREADS);
      const ok = await viewersAmong(ctx, a.channel, [target], { ignorePrivate: true }); // only people who can see the parent channel
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

/**
 * Webhook routes with the token as the credential (no user auth; see CONTRACT.md).
 * `wait=true` on execute returns the created message (otherwise 204), like Discord.
 */
export function webhookPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  const webhookParams = z.object({ id: idSchema, token: z.string().min(10).max(100) });
  const messageParams = z.object({ id: idSchema, token: z.string().min(10).max(100), mid: idSchema });
  const checkToken = (w: any, p: { id: string; token: string }, req: { ip: string }) => { assertNotLocked(ctx, webhookGuardKeys(req.ip, p.id, p.token)); if (!w || !safeEqual(w.token, p.token)) { recordFailure(ctx, webhookGuardKeys(req.ip, p.id, p.token)); throw notFound('Webhook'); } }; // only wrong guesses count; a correct token adds nothing
  /** Messages owned by this webhook, posted in the webhook's channel or one of its threads. */
  const loadWebhookMessage = async (w: any, mid: string) => {
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [mid]);
    if (!m || m.webhook_id !== w.id) throw notFound('Message');
    const [ch] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [m.channel_id]);
    if (!ch || (ch.id !== w.channel_id && ch.parent_id !== w.channel_id)) throw notFound('Message');
    return m;
  };
  const parseMentionsRaw = async (channel: any, content: string) => {
    const { parseMentions } = await import('../services/messages');
    return parseMentions(ctx, channel, content, 0n);
  };

  app.get('/webhooks/:id/:token', async (req) => {
    const p = parse(z.object({ id: idSchema, token: z.string().min(10).max(100) }), req.params);
    const w = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]))[0];
    checkToken(w, p, req);
    return { id: w.id, guildId: w.guild_id, channelId: w.channel_id, name: w.name, avatar: w.avatar ?? null, token: w.token, url: `/webhooks/${w.id}/${w.token}` };
  });

  app.patch('/webhooks/:id/:token', async (req) => {
    const p = parse(z.object({ id: idSchema, token: z.string().min(10).max(100) }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), avatar: assetUrl.nullable().optional() }).strict(), req.body); // channelId is deliberately not accepted here: moving a hook needs MANAGE_WEBHOOKS (PATCH /webhooks/:id)
    const w = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]))[0];
    checkToken(w, p, req);
    if (b.name !== undefined) {
      await ctx.db.query('UPDATE webhooks SET name = $2 WHERE id = $1', [w.id, b.name]);
      await ctx.db.query('UPDATE users SET display_name = $2 WHERE id = $1', [w.bot_user_id, b.name]);
    }
    if (b.avatar !== undefined) {
      await ctx.db.query('UPDATE webhooks SET avatar = $2 WHERE id = $1', [w.id, b.avatar]);
      await ctx.db.query('UPDATE users SET avatar = $2 WHERE id = $1', [w.bot_user_id, b.avatar]);
    }
    const w2 = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [w.id]))[0];
    await ctx.hub.toGuild(w2.guild_id, 'WEBHOOKS_UPDATE', { guildId: w2.guild_id, channelId: w2.channel_id });
    return { id: w2.id, guildId: w2.guild_id, channelId: w2.channel_id, name: w2.name, avatar: w2.avatar ?? null, token: w2.token, url: `/webhooks/${w2.id}/${w2.token}` };
  });

  app.delete('/webhooks/:id/:token', async (req, reply) => {
    const p = parse(webhookParams, req.params);
    const w = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]))[0];
    checkToken(w, p, req);
    await ctx.db.query('DELETE FROM webhooks WHERE id = $1', [w.id]);
    await ctx.db.query('DELETE FROM users WHERE id = $1', [w.bot_user_id]);
    await ctx.hub.toGuild(w.guild_id, 'WEBHOOKS_UPDATE', { guildId: w.guild_id, channelId: w.channel_id });
    return reply.code(204).send();
  });

  app.post('/webhooks/:id/:token', async (req, reply) => {
    const p = parse(webhookParams, req.params);
    const q = parse(z.object({ wait: z.enum(['true', 'false']).optional() }), req.query);
    const b = parse(z.object({
      content: z.string().min(1).max(4000).optional(),
      embeds: z.unknown().optional(), // validated by lib/embeds
      /** Buttons / select menus (validated by lib/components, same as a bot message). */
      components: z.unknown().optional(),
      username: z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/, 'invalid characters').optional(),
      avatarUrl: assetUrl.optional(), avatar_url: assetUrl.optional(),
      /** Post into a thread of the webhook's channel instead. */
      threadId: idSchema.optional(),
    }).strict(), req.body);
    if (!b.content && !b.embeds && b.components === undefined) throw badRequest('Provide content, embeds and/or components');
    const embeds = parseEmbeds(b.embeds, true); // webhook = bot-classed sender
    const components = b.components === undefined ? undefined : parseComponents(b.components);
    const [w] = await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]);
    checkToken(w, p, req);
    limitOrThrow(ctx.rl, `webhook:${w.id}`, 60, 60_000, ctx.config.rateLimit);
    let channel = (await ctx.db.query('SELECT * FROM channels WHERE id = $1', [w.channel_id]))[0];
    if (!channel) throw notFound('Webhook');
    if (b.threadId) {
      const [thread] = await ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [b.threadId, w.guild_id]);
      if (!thread || (thread.type !== 'thread' && thread.type !== 'post') || thread.parent_id !== w.channel_id) throw badRequest('threadId must be a thread of the webhook channel');
      channel = thread;
    }
    const msg = await createMessage(ctx, { channel, authorId: w.bot_user_id, content: b.content ?? '', webhookId: w.id, senderPerms: 0n, skipChecks: true, webhookUsername: b.username ?? null, webhookAvatar: b.avatarUrl ?? b.avatar_url ?? null, embeds, components });
    if (q.wait === 'true') return reply.code(200).send(msg); // Discord shape: wait=true returns the message
    return reply.code(204).send();
  });

  app.get('/webhooks/:id/:token/messages/:mid', async (req) => {
    const p = parse(messageParams, req.params);
    const w = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]))[0];
    checkToken(w, p, req);
    const m = await loadWebhookMessage(w, p.mid);
    return messageDTO(ctx, m, null);
  });

  app.patch('/webhooks/:id/:token/messages/:mid', async (req) => {
    const p = parse(messageParams, req.params);
    const b = parse(z.object({ content: z.string().min(1).max(4000) }).strict(), req.body);
    const w = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]))[0];
    checkToken(w, p, req);
    limitOrThrow(ctx.rl, `webhook-edit:${w.id}`, 15, 10_000, ctx.config.rateLimit);
    const m = await loadWebhookMessage(w, p.mid);
    if (m.forward) throw badRequest('Forwarded messages cannot be edited');
    const [ch] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [m.channel_id]);
    const ment = await parseMentionsRaw(ch, b.content);
    await ctx.db.query('UPDATE messages SET content = $2, edited_at = now(), mentions = $3::jsonb, mention_roles = $4::jsonb, mention_everyone = $5, has_link = $6 WHERE id = $1',
      [p.mid, b.content, JSON.stringify(ment.mentions), JSON.stringify(ment.mentionRoles), ment.mentionEveryone, /https?:\/\//i.test(b.content)]);
    const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    const dto = await messageDTO(ctx, row, null);
    await ctx.hub.toChannel(ch.id, 'MESSAGE_UPDATE', { ...dto, reactions: dto.reactions.map((r) => ({ ...r, me: false })) });
    return dto;
  });

  app.delete('/webhooks/:id/:token/messages/:mid', async (req, reply) => {
    const p = parse(messageParams, req.params);
    const w = (await ctx.db.query('SELECT * FROM webhooks WHERE id = $1', [p.id]))[0];
    checkToken(w, p, req);
    const m = await loadWebhookMessage(w, p.mid);
    await ctx.db.query('DELETE FROM messages WHERE id = $1', [p.mid]);
    await ctx.hub.toChannel(m.channel_id, 'MESSAGE_DELETE', { id: p.mid, channelId: m.channel_id, guildId: m.guild_id ?? null });
    return reply.code(204).send();
  });
}
export { permsFor, loadOverwrites };
