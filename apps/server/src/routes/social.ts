import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, has, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, notFound } from '../errors';
import { idSchema, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { channelPermsLite } from '../services/perms';
import { canReadChannel, reminderDTOs } from '../services/reminders';
import { messagesDTO, userDTO } from '../services/serializers';

/** Social / inbox features: recent mentions, private user notes. */
export function socialRoutes(app: FastifyInstance, ctx: Ctx) {
  /**
   * Inbox "Mentions": messages that @mention the caller, one of their roles, or @everyone/@here, newest first.
   * Only messages in channels the caller can still read, never their own, never from users they blocked.
   */
  app.get('/users/@me/mentions', async (req) => {
    const q = parse(z.object({
      before: idSchema.optional(), limit: z.coerce.number().optional(), guildId: idSchema.optional(),
      roles: z.enum(['true', 'false']).default('true'), everyone: z.enum(['true', 'false']).default('true'),
    }), req.query);
    limitOrThrow(ctx.rl, `inbox:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const limit = limitParam(q.limit, 25, 50);
    const mem = await ctx.db.query('SELECT guild_id FROM members WHERE user_id = $1', [req.userId]);
    let guildIds = mem.map((r) => r.guild_id as string);
    if (q.guildId) guildIds = guildIds.filter((g) => g === q.guildId);
    const roleIds = q.roles === 'true' ? (await ctx.db.query('SELECT role_id FROM member_roles WHERE user_id = $1', [req.userId])).map((r) => r.role_id as string) : [];
    const dmIds = q.guildId ? [] : (await ctx.db.query('SELECT channel_id FROM dm_participants WHERE user_id = $1', [req.userId])).map((r) => r.channel_id as string);
    const blocked = (await ctx.db.query(`SELECT other_id FROM relationships WHERE user_id = $1 AND type = 'blocked'`, [req.userId])).map((r) => r.other_id as string);
    const out: any[] = [];
    let cursor = q.before ?? null, exhausted = false;
    const perChannel = new Map<string, boolean>();
    for (let round = 0; round < 6 && out.length < limit && !exhausted; round++) {
      const params: unknown[] = [JSON.stringify([req.userId]), guildIds, dmIds, req.userId, blocked, roleIds, q.everyone === 'true', cursor, 100];
      const rows = await ctx.db.query(
        `SELECT * FROM messages WHERE (guild_id = ANY($2::text[]) OR channel_id = ANY($3::text[]))
           AND author_id <> $4 AND NOT (author_id = ANY($5::text[]))
           AND (mentions @> $1::jsonb OR (cardinality($6::text[]) > 0 AND guild_id IS NOT NULL AND mention_roles ?| $6::text[]) OR ($7::boolean AND mention_everyone AND guild_id IS NOT NULL))
           AND ($8::text IS NULL OR id < $8::text) ORDER BY id DESC LIMIT $9`, params);
      if (rows.length < 100) exhausted = true;
      for (const m of rows) {
        cursor = m.id;
        if (out.length >= limit) break;
        let ok = perChannel.get(m.channel_id);
        if (ok === undefined) { const a = await channelPermsLite(ctx, req.userId, m.channel_id); ok = !!a && has(a.perms, Perm.READ_MESSAGE_HISTORY); perChannel.set(m.channel_id, ok); }
        if (ok) out.push(m);
      }
    }
    return messagesDTO(ctx, out, req.userId);
  });

  // ---------- private notes ----------
  app.get('/users/@me/notes/:userId', async (req) => {
    const { userId } = parse(z.object({ userId: idSchema }), req.params);
    const [r] = await ctx.db.query('SELECT note FROM user_notes WHERE user_id = $1 AND target_id = $2', [req.userId, userId]);
    if (!r) throw notFound('Note');
    return { userId, note: r.note as string };
  });
  /** `note: ""` deletes it. Notes are private to the author and cap at 256 characters. */
  app.put('/users/@me/notes/:userId', async (req, reply) => {
    const { userId } = parse(z.object({ userId: idSchema }), req.params);
    const { note } = parse(z.object({ note: z.string().max(256) }).strict(), req.body);
    limitOrThrow(ctx.rl, `note:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const [t] = await ctx.db.query('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL', [userId]);
    if (!t) throw notFound('User');
    if (!note.trim()) await ctx.db.query('DELETE FROM user_notes WHERE user_id = $1 AND target_id = $2', [req.userId, userId]);
    else await ctx.db.query(`INSERT INTO user_notes (user_id, target_id, note) VALUES ($1,$2,$3) ON CONFLICT (user_id, target_id) DO UPDATE SET note = $3, updated_at = now()`, [req.userId, userId, note]);
    await ctx.hub.toUser(req.userId, 'USER_NOTE_UPDATE', { userId, note: note.trim() ? note : null });
    return reply.code(204).send();
  });

  // ---------- message requests ----------
  /** Accept a message request: the DM moves to the regular list. */
  app.post('/channels/:id/accept-request', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const [p] = await ctx.db.query('UPDATE dm_participants SET request = false WHERE channel_id = $1 AND user_id = $2 AND request RETURNING channel_id', [id, req.userId]);
    if (!p) {
      const [mine] = await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [id, req.userId]);
      if (!mine) throw notFound('Channel');
    } else await ctx.hub.toUser(req.userId, 'MESSAGE_REQUEST_UPDATE', { channelId: id, request: false });
    return reply.code(204).send();
  });
  /** Ignore a message request: the conversation is deleted for both sides and the sender cannot open a new DM to me. */
  app.post('/channels/:id/ignore-request', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    limitOrThrow(ctx.rl, `ignore-req:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const [mine] = await ctx.db.query('SELECT request FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [id, req.userId]);
    if (!mine) throw notFound('Channel');
    if (!mine.request) throw badRequest('This conversation is not a message request');
    const parts = (await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [id])).map((r) => r.user_id as string);
    await ctx.db.tx(async (q) => {
      for (const o of parts.filter((u) => u !== req.userId)) await q.query('INSERT INTO dm_ignores (user_id, other_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.userId, o]);
      await q.query('DELETE FROM channels WHERE id = $1', [id]);
    });
    await ctx.pcache.invalidate({ k: 'dm', channelId: id });
    await ctx.hub.toUsers(parts, 'CHANNEL_DELETE', { id, guildId: null });
    return reply.code(204).send();
  });

  // ---------- saved for later ----------
  const MAX_SAVED = 250;
  const msgParams = z.object({ channelId: idSchema, messageId: idSchema });
  /** The message exists in that channel and the caller may read it (404 otherwise, never leaking which). */
  const readable = async (userId: string, channelId: string, messageId: string) => {
    const [m] = await ctx.db.query('SELECT id, guild_id, type FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
    if (!m || !(await canReadChannel(ctx, userId, channelId))) throw notFound('Message');
    return m;
  };
  app.put('/users/@me/saved/:channelId/:messageId', async (req, reply) => {
    const p = parse(msgParams, req.params);
    limitOrThrow(ctx.rl, `saved:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    await readable(req.userId, p.channelId, p.messageId);
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM saved_messages WHERE user_id = $1', [req.userId]);
    if (n.n >= MAX_SAVED) throw new ApiError(400, 'LIMIT_REACHED', `You can save at most ${MAX_SAVED} messages`);
    await ctx.db.query('INSERT INTO saved_messages (user_id, message_id, channel_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [req.userId, p.messageId, p.channelId]);
    await ctx.hub.toUser(req.userId, 'SAVED_UPDATE', { channelId: p.channelId, messageId: p.messageId, saved: true });
    return reply.code(204).send();
  });
  app.delete('/users/@me/saved/:channelId/:messageId', async (req, reply) => {
    const p = parse(msgParams, req.params);
    await ctx.db.query('DELETE FROM saved_messages WHERE user_id = $1 AND message_id = $2', [req.userId, p.messageId]);
    await ctx.hub.toUser(req.userId, 'SAVED_UPDATE', { channelId: p.channelId, messageId: p.messageId, saved: false });
    return reply.code(204).send();
  });
  /** Ids only: lets clients mark saved messages without loading them. */
  app.get('/users/@me/saved/ids', async (req) => (await ctx.db.query('SELECT message_id FROM saved_messages WHERE user_id = $1', [req.userId])).map((r) => r.message_id as string));
  /** Saved messages, most recently saved first. Messages the caller can no longer read are left out (not deleted: access may return). */
  app.get('/users/@me/saved', async (req) => {
    const q = parse(z.object({ limit: z.coerce.number().optional(), offset: z.coerce.number().int().min(0).max(1000).optional() }), req.query);
    const rows = await ctx.db.query(
      'SELECT m.*, s.saved_at FROM saved_messages s JOIN messages m ON m.id = s.message_id WHERE s.user_id = $1 ORDER BY s.saved_at DESC, s.message_id DESC LIMIT $2 OFFSET $3', [req.userId, limitParam(q.limit, 50, 100), q.offset ?? 0]);
    const ok = new Map<string, boolean>(); const keep: any[] = [];
    for (const m of rows) { let c = ok.get(m.channel_id); if (c === undefined) { c = await canReadChannel(ctx, req.userId, m.channel_id); ok.set(m.channel_id, c); } if (c) keep.push(m); }
    return messagesDTO(ctx, keep, req.userId);
  });

  // ---------- reminders ----------
  const MAX_REMINDERS = 100;
  app.post('/users/@me/reminders', async (req, reply) => {
    const b = parse(z.object({ channelId: idSchema, messageId: idSchema, remindAt: z.string().datetime({ offset: true }).optional(), inSeconds: z.number().int().min(10).max(366 * 86400).optional() }).strict()
      .refine((v) => (v.remindAt === undefined) !== (v.inSeconds === undefined), 'Provide exactly one of remindAt or inSeconds'), req.body);
    limitOrThrow(ctx.rl, `reminder:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const at = b.remindAt ? Date.parse(b.remindAt) : Date.now() + b.inSeconds! * 1000;
    if (at < Date.now() + 5_000 || at > Date.now() + 366 * 86400_000) throw badRequest('Reminders must be between a few seconds and a year from now');
    const m = await readable(req.userId, b.channelId, b.messageId);
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM reminders WHERE user_id = $1 AND fired_at IS NULL', [req.userId]);
    if (n.n >= MAX_REMINDERS) throw new ApiError(400, 'LIMIT_REACHED', `You can have at most ${MAX_REMINDERS} pending reminders`);
    const id = snowflake();
    await ctx.db.query('INSERT INTO reminders (id, user_id, message_id, channel_id, guild_id, remind_at) VALUES ($1,$2,$3,$4,$5,$6)', [id, req.userId, b.messageId, b.channelId, m.guild_id ?? null, new Date(at)]);
    const [row] = await ctx.db.query('SELECT * FROM reminders WHERE id = $1', [id]);
    return reply.code(201).send((await reminderDTOs(ctx, req.userId, [row]))[0]);
  });
  /** Pending reminders and ones that fired within the last 7 days (until dismissed). */
  app.get('/users/@me/reminders', async (req) => {
    const rows = await ctx.db.query(`SELECT * FROM reminders WHERE user_id = $1 AND (fired_at IS NULL OR fired_at > now() - interval '7 days') ORDER BY remind_at LIMIT 200`, [req.userId]);
    return reminderDTOs(ctx, req.userId, rows);
  });
  app.delete('/users/@me/reminders/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await ctx.db.query('DELETE FROM reminders WHERE id = $1 AND user_id = $2', [id, req.userId]); // somebody else's id is a silent no-op
    return reply.code(204).send();
  });

  // ---------- age gate ----------
  /** Self-attest 18+: unlocks age-restricted (nsfw) server channels. */
  app.post('/users/@me/age-confirm', async (req, reply) => {
    parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
    limitOrThrow(ctx.rl, `age:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    await ctx.db.query('UPDATE users SET age_confirmed_at = COALESCE(age_confirmed_at, now()) WHERE id = $1', [req.userId]);
    await pushSelf(req.userId);
    return reply.code(204).send();
  });
  app.delete('/users/@me/age-confirm', async (req, reply) => {
    await ctx.db.query('UPDATE users SET age_confirmed_at = NULL WHERE id = $1', [req.userId]);
    await pushSelf(req.userId);
    return reply.code(204).send();
  });
  const pushSelf = async (userId: string) => {
    const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [userId]);
    await ctx.hub.toUser(userId, 'USER_UPDATE', { ...userDTO(ctx, row), ageConfirmed: !!row.age_confirmed_at } as any);
  };
}
