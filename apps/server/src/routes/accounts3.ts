import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, WAVE_STICKER_ID, snowflake, type InboxThread, type InboxUnreadChannel, type ThreadNotifyLevel } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { cancelEmailChange, changeUsername, confirmEmailChange, disableOwnAccount, pendingEmailChange, requestEmailChange, usernameStatus } from '../services/accountChanges';
import { setMessageTtl } from '../services/disappearing';
import { listIgnored, setIgnored } from '../services/ignores';
import { createMessage } from '../services/messages';
import { channelAccess, channelPermsLite, need } from '../services/perms';

const password = z.string().min(1).max(128);
const totp = z.string().regex(/^\d{6}$/).optional();
const NO_TOKEN = z.object({ token: z.string().min(20).max(128) }).strict();

/** Public: the emailed email-change link is the credential, like the verify-email link. */
export function accounts3PublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/auth/email-change/confirm', async (req, reply) => {
    limitOrThrow(ctx.rl, `email-change-confirm:${req.ip}`, 20, 15 * 60_000, ctx.config.rateLimit);
    const { token } = parse(NO_TOKEN, req.body);
    if (!(await confirmEmailChange(ctx, token))) throw new ApiError(400, 'INVALID_TOKEN', 'This link is invalid or has expired');
    return reply.code(204).send();
  });
}

/** Accounts, social and safety extras (parity audit 3, package C). */
export function accounts3Routes(app: FastifyInstance, ctx: Ctx) {
  // ---------- username / email / disable ----------
  app.get('/users/@me/username', async (req) => usernameStatus(ctx, req.userId));
  app.post('/users/@me/username', async (req) => {
    const b = parse(z.object({ username: z.string().trim().min(2).max(32), password, totp }).strict(), req.body);
    return changeUsername(ctx, req.userId, b);
  });

  app.get('/users/@me/email-change', async (req) => (await pendingEmailChange(ctx, req.userId)) ?? { pendingEmail: null, expiresAt: null });
  app.post('/users/@me/email', async (req, reply) => {
    const b = parse(z.object({ newEmail: z.string().trim().toLowerCase().email().max(254), password, totp }).strict(), req.body);
    return reply.code(202).send(await requestEmailChange(ctx, req.userId, b));
  });
  app.delete('/users/@me/email-change', async (req, reply) => { await cancelEmailChange(ctx, req.userId); return reply.code(204).send(); });

  /** Reversible: signs out everywhere and hides nothing permanently; the next login reactivates the account. Deleting is `DELETE /users/@me`. */
  app.post('/users/@me/disable', async (req, reply) => {
    const b = parse(z.object({ password, totp }).strict(), req.body);
    await disableOwnAccount(ctx, req.userId, b);
    return reply.code(204).send();
  });

  // ---------- ignore ----------
  app.get('/users/@me/ignored', async (req) => ({ users: await listIgnored(ctx, req.userId) }));
  app.put('/users/@me/ignored/:userId', async (req, reply) => {
    const { userId } = parse(z.object({ userId: idSchema }), req.params);
    limitOrThrow(ctx.rl, `ignore:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    await setIgnored(ctx, req.userId, userId, true);
    return reply.code(204).send();
  });
  app.delete('/users/@me/ignored/:userId', async (req, reply) => {
    const { userId } = parse(z.object({ userId: idSchema }), req.params);
    await setIgnored(ctx, req.userId, userId, false);
    return reply.code(204).send();
  });

  // ---------- friend nicknames ----------
  app.put('/users/@me/relationships/:userId/nickname', async (req, reply) => {
    const { userId } = parse(z.object({ userId: idSchema }), req.params);
    const { nickname } = parse(z.object({ nickname: z.string().trim().max(32).nullable() }).strict(), req.body);
    limitOrThrow(ctx.rl, `nick:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const rows = await ctx.db.query(`UPDATE relationships SET nickname = $3 WHERE user_id = $1 AND other_id = $2 AND type = 'friend' RETURNING other_id`, [req.userId, userId, nickname || null]);
    if (!rows.length) throw notFound('Friend');
    await ctx.hub.toUser(req.userId, 'FRIEND_NICKNAME_UPDATE', { userId, nickname: nickname || null });
    return reply.code(204).send();
  });

  // ---------- disappearing DMs ----------
  app.put('/channels/:id/disappearing', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const { seconds } = parse(z.object({ seconds: z.number().int().min(0).max(604_800) }).strict(), req.body);
    limitOrThrow(ctx.rl, `ttl:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    return setMessageTtl(ctx, req.userId, id, seconds);
  });

  // ---------- wave to say hi ----------
  app.post('/channels/:id/messages/:mid/wave', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, mid: idSchema }), req.params);
    limitOrThrow(ctx.rl, `wave:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (!a.channel.guild_id) throw badRequest('Waving is for server join messages');
    need(a.perms, Perm.SEND_MESSAGES, Perm.READ_MESSAGE_HISTORY);
    if (a.gp?.timedOut) throw forbidden('You cannot send messages right now');
    const [m] = await ctx.db.query('SELECT id, author_id, type FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.type !== 'join') throw badRequest('You can only wave at a join message');
    if (m.author_id === req.userId) throw badRequest('You cannot wave at yourself');
    const first = await ctx.db.query('INSERT INTO join_waves (message_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [p.mid, req.userId]);
    if (!first.length) throw conflict('You already waved', 'ALREADY_WAVED');
    const msg = await createMessage(ctx, { channel: a.channel, authorId: req.userId, content: '', replyTo: p.mid, stickerIds: [WAVE_STICKER_ID], senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds });
    return reply.code(201).send(msg);
  });

  // ---------- Inbox: Unreads and Threads tabs ----------
  const mutedSet = async (userId: string) => {
    const rows = await ctx.db.query(`SELECT scope, target_id, muted, muted_until, level FROM notification_settings WHERE user_id = $1 AND scope IN ('guild','channel')`, [userId]);
    const now = Date.now();
    const on = (r: any) => r.muted && (!r.muted_until || new Date(r.muted_until).getTime() > now);
    return { guilds: new Set(rows.filter((r) => r.scope === 'guild' && (on(r) || r.level === 'none')).map((r) => r.target_id as string)), channels: new Set(rows.filter((r) => r.scope === 'channel' && on(r)).map((r) => r.target_id as string)) };
  };

  /** Channels with messages the caller has not read (muted ones left out), newest activity first. Messages from ignored people still count: only the client hides them. */
  app.get('/users/@me/inbox/unreads', async (req) => {
    limitOrThrow(ctx.rl, `inbox:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const muted = await mutedSet(req.userId);
    const rows = await ctx.db.query(
      `SELECT c.id, c.guild_id, c.name, c.type, c.last_message_id, r.last_read_id, coalesce(r.mention_count, 0) AS mention_count, m.joined_at
         FROM channels c
         LEFT JOIN read_states r ON r.channel_id = c.id AND r.user_id = $1
         LEFT JOIN members m ON m.guild_id = c.guild_id AND m.user_id = $1
        WHERE c.last_message_id IS NOT NULL AND c.type IN ('text','announcement','dm','group_dm')
          AND (c.guild_id IS NULL AND EXISTS (SELECT 1 FROM dm_participants p WHERE p.channel_id = c.id AND p.user_id = $1 AND NOT p.request) OR m.user_id IS NOT NULL)
          AND (r.last_read_id IS NULL OR c.last_message_id > r.last_read_id)
        ORDER BY c.last_message_id DESC LIMIT 200`, [req.userId]);
    const out: InboxUnreadChannel[] = [];
    for (const c of rows) {
      if (out.length >= 50) break;
      if (muted.channels.has(c.id) || (c.guild_id && muted.guilds.has(c.guild_id))) continue;
      if (!c.last_read_id && c.joined_at && c.last_message_id < snowflake(new Date(c.joined_at).getTime())) continue; // never read, but older than the membership
      const a = await channelPermsLite(ctx, req.userId, c.id);
      if (!a || !(a.perms & Perm.VIEW_CHANNEL) || !(a.perms & Perm.READ_MESSAGE_HISTORY)) continue;
      out.push({ channelId: c.id, guildId: c.guild_id ?? null, name: c.name ?? null, mentionCount: Number(c.mention_count), lastMessageId: c.last_message_id, lastReadId: c.last_read_id ?? null });
    }
    return out;
  });

  /** Threads the caller follows, those with new activity first; `level` is their per-thread notification setting. */
  app.get('/users/@me/inbox/threads', async (req) => {
    limitOrThrow(ctx.rl, `inbox:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const rows = await ctx.db.query(
      `SELECT c.id, c.parent_id, c.guild_id, c.name, c.last_message_id, r.last_read_id, coalesce(r.mention_count, 0) AS mention_count, t.joined_at, n.level
         FROM thread_members t JOIN channels c ON c.id = t.thread_id AND c.type = 'thread' AND NOT c.archived
         LEFT JOIN read_states r ON r.channel_id = c.id AND r.user_id = $1
         LEFT JOIN notification_settings n ON n.user_id = $1 AND n.scope = 'thread' AND n.target_id = c.id
        WHERE t.user_id = $1 ORDER BY c.last_message_id DESC NULLS LAST LIMIT 100`, [req.userId]);
    const out: InboxThread[] = [];
    for (const c of rows) {
      if (out.length >= 50) break;
      const a = await channelPermsLite(ctx, req.userId, c.id);
      if (!a) continue;
      const base = c.last_read_id ?? snowflake(new Date(c.joined_at).getTime());
      out.push({ threadId: c.id, parentId: c.parent_id ?? null, guildId: c.guild_id ?? null, name: c.name ?? null, lastMessageId: c.last_message_id ?? null, lastReadId: c.last_read_id ?? null,
        mentionCount: Number(c.mention_count), unread: !!c.last_message_id && c.last_message_id > base, level: (c.level ?? 'mentions') as ThreadNotifyLevel });
    }
    return out.sort((x, y) => Number(y.unread) - Number(x.unread));
  });

  /** Per-thread notification level: all messages / only mentions (default) / nothing. `none` also mutes the thread's push notifications. */
  app.put('/users/@me/notification-settings/threads/:threadId', async (req) => {
    const { threadId } = parse(z.object({ threadId: idSchema }), req.params);
    const { level } = parse(z.object({ level: z.enum(['all', 'mentions', 'none']) }).strict(), req.body);
    limitOrThrow(ctx.rl, `notifset:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, threadId);
    if (a.channel.type !== 'thread') throw badRequest('Not a thread');
    if (level === 'mentions') await ctx.db.query(`DELETE FROM notification_settings WHERE user_id = $1 AND scope = 'thread' AND target_id = $2`, [req.userId, threadId]);
    else await ctx.db.query(
      `INSERT INTO notification_settings (user_id, scope, target_id, level) VALUES ($1,'thread',$2,$3) ON CONFLICT (user_id, scope, target_id) DO UPDATE SET level = $3`, [req.userId, threadId, level]);
    await ctx.db.query( // "none" rides on the existing channel mute so push.ts and badges already honour it
      `INSERT INTO notification_settings (user_id, scope, target_id, muted) VALUES ($1,'channel',$2,$3) ON CONFLICT (user_id, scope, target_id) DO UPDATE SET muted = $3, muted_until = NULL`, [req.userId, threadId, level === 'none']);
    return { threadId, level } as { threadId: string; level: ThreadNotifyLevel };
  });
  app.get('/users/@me/notification-settings/threads', async (req) => {
    const rows = await ctx.db.query(`SELECT target_id, level FROM notification_settings WHERE user_id = $1 AND scope = 'thread'`, [req.userId]);
    return rows.map((r) => ({ threadId: r.target_id as string, level: (r.level ?? 'mentions') as ThreadNotifyLevel }));
  });

}
