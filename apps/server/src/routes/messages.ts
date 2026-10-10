import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, Perm, has, snowflakeTime } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { parseComponents } from '../lib/components';
import { buildPoll } from '../services/polls';
import { claimAttachments, saveUpload } from '../services/files';
import { audit, visibleChannelRows } from '../services/guilds';
import { createMessage, parseMentions, postSystemMessage } from '../services/messages';
import { channelAccess, channelPermsLite, guildAccess, need } from '../services/perms';
import { joinThread } from '../services/threads';
import { searchMessages } from '../services/search';
import { messageDTO, messagesDTO, usersByIds } from '../services/serializers';

const cm = z.object({ id: idSchema });
const mm = z.object({ id: idSchema, mid: idSchema });
const sendBody = z.object({
  content: z.string().max(LIMITS.maxMessageLength * 2).optional(), replyTo: idSchema.nullable().optional(),
  attachments: z.array(idSchema).max(10).optional(), stickerIds: z.array(idSchema).max(3).optional(),
  /** Bots only: action rows of buttons / select menus (validated by lib/components). */
  components: z.unknown().optional(),
  /** Needs SEND_POLLS. */
  poll: z.unknown().optional(),
  flags: z.number().int().optional(),
}).strict();
const emojiParam = z.string().min(1).max(100);

function parseEmoji(raw: string): { emoji: string; emojiId: string | null } {
  let e: string; try { e = decodeURIComponent(raw); } catch { throw badRequest('Invalid emoji'); } // malformed %-escapes must be a 400, not a 500
  const custom = e.match(/^(\w{2,32}):(\d{1,20})$/);
  if (custom) return { emoji: custom[1]!, emojiId: custom[2]! };
  if (e.includes(':') || e.length > 32 || /[\u0000-\u001f<>]/.test(e)) throw badRequest('Invalid emoji');
  return { emoji: e, emojiId: null };
}

export function messageRoutes(app: FastifyInstance, ctx: Ctx) {
  async function assertCanPostIn(a: Awaited<ReturnType<typeof channelAccess>>, userId: string) {
    const t = a.channel.type;
    if (t === 'category' || t === 'forum') throw badRequest('Cannot send messages in this channel type');
    // Voice and stage channels carry a text chat: they take messages under the same SEND_MESSAGES rules (overwrites included).
    need(a.perms, t === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES);
    if (t === 'thread' && a.channel.archived && a.channel.locked && !has(a.perms, Perm.MANAGE_THREADS)) throw new ApiError(403, 'THREAD_LOCKED', 'This thread is locked').num(50083);
    if (t === 'dm') {
      const [blk] = await ctx.db.query(
        `SELECT 1 AS x FROM relationships r JOIN dm_participants p ON p.channel_id = $1 WHERE r.type = 'blocked' AND ((r.user_id = $2 AND r.other_id = p.user_id) OR (r.other_id = $2 AND r.user_id = p.user_id)) LIMIT 1`, [a.channel.id, userId]);
      if (blk) throw forbidden('You cannot message this user', 'BLOCKED');
    }
    if (a.channel.slowmode > 0 && !has(a.perms, Perm.MANAGE_MESSAGES) && !has(a.perms, Perm.MANAGE_CHANNELS)) {
      const [last] = await ctx.db.query("SELECT max(id) AS id FROM messages WHERE channel_id = $1 AND author_id = $2 AND type IN ('default','reply')", [a.channel.id, userId]);
      if (last?.id) {
        const wait = Math.ceil((snowflakeTime(last.id) + a.channel.slowmode * 1000 - Date.now()) / 1000);
        if (wait > 0) throw new ApiError(429, 'SLOWMODE', `Slowmode: wait ${wait}s`, { retryAfter: wait }, { 'retry-after': String(wait) });
      }
    }
  }

  app.get('/channels/:id/messages', async (req) => {
    const { id } = parse(cm, req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), before: idSchema.optional(), after: idSchema.optional(), around: idSchema.optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, id);
    if (!has(a.perms, Perm.READ_MESSAGE_HISTORY)) return [];
    const limit = limitParam(q.limit);
    let rows: any[];
    if (q.around) {
      const half = Math.max(1, Math.floor(limit / 2));
      const older = await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND id <= $2 ORDER BY id DESC LIMIT $3', [id, q.around, half]);
      const newer = await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [id, q.around, half]);
      rows = [...newer.reverse(), ...older];
    } else if (q.after) {
      rows = (await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [id, q.after, limit])).reverse();
    } else {
      rows = await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND ($2::text IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [id, q.before ?? null, limit]);
    }
    return messagesDTO(ctx, rows, req.userId);
  });

  app.post('/channels/:id/messages', async (req, reply) => {
    const { id } = parse(cm, req.params);
    limitOrThrow(ctx.rl, `msg:${req.userId}`, 10, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, id);
    await assertCanPostIn(a, req.userId);
    let body: z.infer<typeof sendBody>;
    const uploaded: string[] = [];
    if (req.isMultipart()) {
      const fields: Record<string, unknown> = {};
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (uploaded.length >= 10) throw badRequest('At most 10 files per message');
            need(a.perms, Perm.ATTACH_FILES);
            uploaded.push((await saveUpload(ctx, req.userId, part)).id);
          } else if (typeof part.value === 'string') {
            if (part.fieldname === 'payload_json') Object.assign(fields, JSON.parse(part.value));
            else if (part.fieldname === 'stickerIds') fields.stickerIds = JSON.parse(part.value);
            else if (part.fieldname === 'content' || part.fieldname === 'replyTo') fields[part.fieldname] = part.value;
          }
        }
      } catch (e: any) { if (e instanceof SyntaxError) throw badRequest('Invalid JSON field'); throw e; }
      body = parse(sendBody, { ...fields, attachments: [...((fields.attachments as string[]) ?? []), ...uploaded] });
    } else body = parse(sendBody, req.body);
    if (body.attachments?.length) need(a.perms, Perm.ATTACH_FILES);
    if (body.replyTo) need(a.perms, Perm.READ_MESSAGE_HISTORY);
    if ((body.flags ?? 0) & ~4) throw badRequest('Unsupported message flags');
    let components;
    if (body.components !== undefined) {
      if (!req.isBot) throw new ApiError(403, 'USER_FORBIDDEN', 'Only bots can send components').num(20002);
      components = parseComponents(body.components);
    }
    let pollInput: ReturnType<typeof buildPoll> | undefined;
    if (body.poll !== undefined) {
      if (a.channel.guild_id) need(a.perms, Perm.SEND_POLLS);
      pollInput = buildPoll(body.poll);
    }
    const attachments = await claimAttachments(ctx, req.userId, body.attachments ?? []);
    try {
      const msg = await createMessage(ctx, { channel: a.channel, authorId: req.userId, content: body.content ?? '', replyTo: body.replyTo, attachments, stickerIds: body.stickerIds, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds,
        components, flags: body.flags, applicationId: req.applicationId, poll: pollInput?.poll, pollExpiry: pollInput?.expiry });
      if (a.channel.type === 'thread') await joinThread(ctx, a.channel, req.userId).catch(() => {}); // posting in a thread follows it
      return reply.code(201).send(msg);
    } catch (e) {
      if (attachments.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]);
      throw e;
    }
  });

  app.patch('/channels/:id/messages/:mid', async (req) => {
    const p = parse(mm, req.params);
    const b = parse(z.object({ content: z.string().min(1).max(LIMITS.maxMessageLength).optional(), components: z.unknown().optional() }).strict(), req.body);
    if (b.content === undefined && b.components === undefined) throw badRequest('Provide content and/or components');
    limitOrThrow(ctx.rl, `msg-edit:${req.userId}`, 15, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.author_id !== req.userId || m.webhook_id || !['default', 'reply'].includes(m.type)) throw forbidden('You can only edit your own messages');
    if (b.components !== undefined) {
      if (!req.isBot || m.application_id !== req.applicationId) throw new ApiError(403, 'USER_FORBIDDEN', 'Only the owning bot can edit components').num(20002);
      await ctx.db.query('UPDATE messages SET components = $2::jsonb, edited_at = now() WHERE id = $1', [p.mid, JSON.stringify(parseComponents(b.components))]);
    }
    if (b.content !== undefined) {
      const ment = await parseMentions(ctx, a.channel, b.content, a.perms);
      await ctx.db.query('UPDATE messages SET content = $2, edited_at = now(), mentions = $3::jsonb, mention_roles = $4::jsonb, mention_everyone = $5, has_link = $6 WHERE id = $1',
        [p.mid, b.content, JSON.stringify(ment.mentions), JSON.stringify(ment.mentionRoles), ment.mentionEveryone, /https?:\/\//i.test(b.content)]);
    }
    const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    const dto = await messageDTO(ctx, row, req.userId);
    await ctx.hub.toChannel(p.id, 'MESSAGE_UPDATE', { ...dto, reactions: dto.reactions.map((r) => ({ ...r, me: false })) });
    return dto;
  });

  const removeMessages = async (channel: any, ids: string[]) => {
    const rows = await ctx.db.query('DELETE FROM messages WHERE channel_id = $1 AND id = ANY($2::text[]) RETURNING id', [channel.id, ids]);
    for (const r of rows) await ctx.hub.toChannel(channel.id, 'MESSAGE_DELETE', { id: r.id, channelId: channel.id, guildId: channel.guild_id ?? null });
    return rows.length;
  };
  app.delete('/channels/:id/messages/:mid', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    const [m] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    const byMod = m.author_id !== req.userId;
    if (byMod) { if (!a.channel.guild_id) throw forbidden(); need(a.perms, Perm.MANAGE_MESSAGES); }
    await removeMessages(a.channel, [p.mid]);
    if (byMod) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_DELETE', p.mid, { channelId: p.id, authorId: m.author_id });
    return reply.code(204).send();
  });
  app.post('/channels/:id/messages/bulk-delete', async (req, reply) => {
    const { id } = parse(cm, req.params);
    const { messageIds } = parse(z.object({ messageIds: z.array(idSchema).min(2).max(100) }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, id);
    if (!a.channel.guild_id) throw badRequest('Bulk delete is for guild channels');
    need(a.perms, Perm.MANAGE_MESSAGES);
    const n = await removeMessages(a.channel, [...new Set(messageIds)]);
    await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_BULK_DELETE', id, { count: n });
    return reply.code(204).send();
  });

  // ---------- reactions ----------
  const reactionEvent = async (name: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', channelId: string, messageId: string, userId: string, e: { emoji: string; emojiId: string | null }) =>
    ctx.hub.toChannel(channelId, name, { messageId, channelId, userId, emoji: e.emoji, emojiId: e.emojiId });
  app.put('/channels/:id/messages/:mid/reactions/:emoji/@me', async (req, reply) => {
    const p = parse(mm.extend({ emoji: emojiParam }), req.params);
    limitOrThrow(ctx.rl, `react:${req.userId}`, 30, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.ADD_REACTIONS, Perm.READ_MESSAGE_HISTORY);
    const e = parseEmoji(p.emoji);
    const [m] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (e.emojiId) {
      const [em] = await ctx.db.query('SELECT guild_id FROM emojis WHERE id = $1 AND name = $2', [e.emojiId, e.emoji]);
      if (!em) throw badRequest('Unknown custom emoji');
      if (em.guild_id !== a.channel.guild_id) need(a.perms, Perm.USE_EXTERNAL_EMOJIS);
    }
    const [c] = await ctx.db.query('SELECT count(DISTINCT emoji)::int AS n, bool_or(emoji = $2) AS has FROM reactions WHERE message_id = $1', [p.mid, e.emoji]);
    if (!c.has && c.n >= 20) throw new ApiError(400, 'MAX_REACTIONS', 'Too many different reactions');
    const ins = await ctx.db.query('INSERT INTO reactions (message_id, user_id, emoji, emoji_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING user_id', [p.mid, req.userId, e.emoji, e.emojiId]);
    if (ins.length) await reactionEvent('MESSAGE_REACTION_ADD', p.id, p.mid, req.userId, e);
    return reply.code(204).send();
  });
  app.delete('/channels/:id/messages/:mid/reactions/:emoji/:target', async (req, reply) => {
    const p = parse(mm.extend({ emoji: emojiParam, target: z.union([z.literal('@me'), idSchema]) }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    const userId = p.target === '@me' ? req.userId : p.target;
    if (userId !== req.userId) need(a.perms, Perm.MANAGE_MESSAGES);
    const e = parseEmoji(p.emoji);
    const del = await ctx.db.query('DELETE FROM reactions USING messages m WHERE reactions.message_id = $1 AND m.id = reactions.message_id AND m.channel_id = $2 AND reactions.user_id = $3 AND reactions.emoji = $4 RETURNING reactions.user_id', [p.mid, p.id, userId, e.emoji]);
    if (del.length) await reactionEvent('MESSAGE_REACTION_REMOVE', p.id, p.mid, userId, e);
    return reply.code(204).send();
  });
  app.get('/channels/:id/messages/:mid/reactions/:emoji', async (req) => {
    const p = parse(mm.extend({ emoji: emojiParam }), req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), after: idSchema.optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const e = parseEmoji(p.emoji);
    const rows = await ctx.db.query(
      `SELECT r.user_id FROM reactions r JOIN messages m ON m.id = r.message_id WHERE r.message_id = $1 AND m.channel_id = $2 AND r.emoji = $3 AND ($4::text IS NULL OR r.user_id > $4) ORDER BY r.user_id LIMIT $5`,
      [p.mid, p.id, e.emoji, q.after ?? null, limitParam(q.limit)]);
    const users = await usersByIds(ctx, rows.map((r) => r.user_id));
    return rows.map((r) => users.get(r.user_id)).filter(Boolean);
  });

  // ---------- pins ----------
  app.get('/channels/:id/pins', async (req) => {
    const { id } = parse(cm, req.params);
    const a = await channelAccess(ctx, req.userId, id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    return messagesDTO(ctx, await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND pinned ORDER BY id DESC LIMIT $2', [id, LIMITS.maxPins]), req.userId);
  });
  app.put('/channels/:id/pins/:mid', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.guild_id) need(a.perms, Perm.MANAGE_MESSAGES);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND pinned', [p.id]);
    if (c.n >= LIMITS.maxPins) throw new ApiError(400, 'MAX_PINS', `At most ${LIMITS.maxPins} pinned messages`);
    const rows = await ctx.db.query('UPDATE messages SET pinned = true WHERE id = $1 AND channel_id = $2 AND NOT pinned AND type IN (\'default\',\'reply\') RETURNING id', [p.mid, p.id]);
    if (rows.length) {
      await ctx.hub.toChannel(p.id, 'CHANNEL_PINS_UPDATE', { channelId: p.id });
      if (a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_PIN', p.mid, { channelId: p.id });
      await postSystemMessage(ctx, p.id, req.userId, 'pin', '').catch(() => {});
    } else {
      const [m] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
      if (!m) throw notFound('Message');
    }
    return reply.code(204).send();
  });
  app.delete('/channels/:id/pins/:mid', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.guild_id) need(a.perms, Perm.MANAGE_MESSAGES);
    const rows = await ctx.db.query('UPDATE messages SET pinned = false WHERE id = $1 AND channel_id = $2 AND pinned RETURNING id', [p.mid, p.id]);
    if (rows.length) { await ctx.hub.toChannel(p.id, 'CHANNEL_PINS_UPDATE', { channelId: p.id }); if (a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_UNPIN', p.mid, { channelId: p.id }); }
    return reply.code(204).send();
  });

  // ---------- typing ----------
  app.post('/channels/:id/typing', async (req, reply) => {
    const { id } = parse(cm, req.params);
    limitOrThrow(ctx.rl, `typing:${req.userId}`, 15, 10_000, ctx.config.rateLimit);
    const a = await channelPermsLite(ctx, req.userId, id); // cached: no DB queries
    if (!a) throw notFound('Channel');
    need(a.perms, a.channel.type === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES);
    await ctx.hub.toChannel(id, 'TYPING_START', { channelId: id, userId: req.userId, timestamp: Date.now() }, { exclude: req.userId });
    return reply.code(204).send();
  });

  // ---------- search ----------
  app.get('/guilds/:id/messages/search', async (req) => {
    const { id } = parse(cm, req.params);
    const q = parse(z.object({
      q: z.string().max(200).optional(), authorId: idSchema.optional(), channelId: idSchema.optional(),
      has: z.enum(['link', 'image', 'file', 'embed', 'sticker']).optional(), before: idSchema.optional(), limit: z.coerce.number().optional(),
    }), req.query);
    limitOrThrow(ctx.rl, `search:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // full-scan queries are expensive
    if (!q.q && !q.authorId && !q.has) throw badRequest('Provide q, authorId or has');
    await guildAccess(ctx, req.userId, id);
    let channels = (await visibleChannelRows(ctx, id, req.userId, Perm.READ_MESSAGE_HISTORY)).map((c) => c.id as string);
    if (q.channelId) channels = channels.filter((c) => c === q.channelId);
    if (!channels.length) return [];
    return searchMessages(ctx, { viewerId: req.userId, guildId: id, channelIds: channels, q: q.q, authorId: q.authorId, has: q.has, before: q.before, limit: limitParam(q.limit, 25) });
  });

  const searchQuery = z.object({
    q: z.string().max(200).optional(), authorId: idSchema.optional(),
    has: z.enum(['link', 'image', 'file', 'embed', 'sticker']).optional(), before: idSchema.optional(), limit: z.coerce.number().optional(),
  });
  /** Search inside one channel the caller can read (this is how DMs and group DMs are searched). */
  app.get('/channels/:id/messages/search', async (req) => {
    const { id } = parse(cm, req.params);
    const q = parse(searchQuery, req.query);
    limitOrThrow(ctx.rl, `search:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // full-scan queries are expensive
    if (!q.q && !q.authorId && !q.has) throw badRequest('Provide q, authorId or has');
    const a = await channelAccess(ctx, req.userId, id);
    if (!has(a.perms, Perm.READ_MESSAGE_HISTORY)) return [];
    return searchMessages(ctx, { viewerId: req.userId, channelIds: [id], q: q.q, authorId: q.authorId, has: q.has, before: q.before, limit: limitParam(q.limit, 25) });
  });
  /** Search across all of the caller's DMs and group DMs. */
  app.get('/users/@me/messages/search', async (req) => {
    const q = parse(searchQuery, req.query);
    limitOrThrow(ctx.rl, `search:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // full-scan queries are expensive
    if (!q.q && !q.authorId && !q.has) throw badRequest('Provide q, authorId or has');
    const ids = (await ctx.db.query('SELECT channel_id FROM dm_participants WHERE user_id = $1', [req.userId])).map((r) => r.channel_id as string);
    return searchMessages(ctx, { viewerId: req.userId, channelIds: ids, q: q.q, authorId: q.authorId, has: q.has, before: q.before, limit: limitParam(q.limit, 25) });
  });
}
