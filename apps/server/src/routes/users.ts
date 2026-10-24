import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Relationship } from '@jorcord/shared';
import { AVATAR_DECORATION_IDS, NAME_PLATE_IDS, PROFILE_EFFECT_IDS, snowflake } from '@jorcord/shared';
import { removeMemberFromGuild } from './members';
import { publicConnections } from './connections';
import { setServerTag } from '../services/cosmetics';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { storeImageFromUrl } from '../services/files';
import { verifyPassword } from '../lib/crypto';
import { verifyTotp } from '../lib/totp';
import { scheduleAccountDeletion } from '../services/accountDeletion';
import { channelAccess } from '../services/perms';
import { checkImpersonation } from '../services/impersonation';
import { assertServerAllowsDm, sharedContext } from '../services/memberDms';
import { assertNotDmLimited } from '../services/massdm';
import { canSendFriendRequest, normalizePrivacy, privacyOf } from '../services/privacy';
import { publicActivities, liveStatus, channelDTO, channelsDTO, getUser, GUILD_SELECT, guildDTO, selfUserDTO, userDTO, usersByIds } from '../services/serializers';

const patchMe = z.object({
  displayName: z.string().trim().min(1).max(32).nullable(), bio: z.string().max(400).nullable(), pronouns: z.string().max(40).nullable(),
  avatar: assetUrl.nullable(), banner: assetUrl.nullable(), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  customStatus: z.object({ text: z.string().max(128).nullable(), emoji: z.string().max(64).nullable(), expiresAt: z.string().datetime({ offset: true }).nullable().optional() }).strict().nullable()
    .refine((v) => !v?.expiresAt || (Date.parse(v.expiresAt) > Date.now() && Date.parse(v.expiresAt) < Date.now() + 366 * 86400_000), 'expiresAt must be in the future (within a year)'),
  themeColors: z.tuple([z.string().regex(/^#[0-9a-fA-F]{6}$/), z.string().regex(/^#[0-9a-fA-F]{6}$/)]).nullable(),
  theme: z.enum(['dark', 'light', 'amoled']),
  avatarDecoration: z.enum(AVATAR_DECORATION_IDS).nullable(), profileEffect: z.enum(PROFILE_EFFECT_IDS).nullable(), namePlate: z.enum(NAME_PLATE_IDS).nullable(),
  serverTagGuildId: idSchema.nullable(),
  settings: z.record(z.unknown()).refine((v) => JSON.stringify(v).length <= 16_384, 'settings too large'),
  privacy: z.object({
    allowDmsFromServerMembers: z.boolean(), messageRequests: z.boolean(), showActivity: z.boolean(),
    friendRequests: z.object({ everyone: z.boolean(), friendsOfFriends: z.boolean(), serverMembers: z.boolean() }).partial().strict(),
  }).partial().strict(),
}).partial().strict();

const COLS: Record<string, string> = { displayName: 'display_name', bio: 'bio', pronouns: 'pronouns', avatar: 'avatar', banner: 'banner', accentColor: 'accent_color', customStatus: 'custom_status', themeColors: 'theme_colors', theme: 'theme', settings: 'settings', avatarDecoration: 'avatar_decoration', profileEffect: 'profile_effect', namePlate: 'name_plate' };

export async function relationshipDTOs(ctx: Ctx, userId: string): Promise<Relationship[]> {
  const rows = await ctx.db.query('SELECT other_id, type FROM relationships WHERE user_id = $1 ORDER BY created_at', [userId]);
  const users = await usersByIds(ctx, rows.map((r) => r.other_id));
  return rows.filter((r) => users.has(r.other_id)).map((r) => ({ user: users.get(r.other_id)!, type: r.type }));
}

export function userRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/users/@me', async (req) => {
    const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    return selfUserDTO(ctx, row);
  });

  app.patch('/users/@me', async (req) => {
    const b = parse(patchMe, req.body) as Record<string, unknown>;
    const sets: string[] = [], vals: unknown[] = [req.userId];
    for (const [k, v] of Object.entries(b)) {
      const col = COLS[k]; if (!col) continue; // whitelist only
      vals.push(k === 'customStatus' || k === 'settings' || k === 'themeColors' ? (v === null ? null : JSON.stringify(v)) : v);
      sets.push(`${col} = $${vals.length}${k === 'customStatus' || k === 'settings' || k === 'themeColors' ? '::jsonb' : ''}`);
    }
    if (b.privacy) { // merge over what is stored so a partial update never resets the other switches
      const cur = normalizePrivacy((await ctx.db.query('SELECT privacy FROM users WHERE id = $1', [req.userId]))[0]?.privacy);
      const inc = b.privacy as Record<string, any>;
      const next = normalizePrivacy({ ...cur, ...inc, friendRequests: { ...cur.friendRequests, ...(inc.friendRequests ?? {}) } });
      vals.push(JSON.stringify(next)); sets.push(`privacy = $${vals.length}::jsonb`);
    }
    if (b.serverTagGuildId !== undefined) await setServerTag(ctx, req.userId, b.serverTagGuildId as string | null);
    if (sets.length) await ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    if (b.displayName) { // a new display name is checked against the owner/staff names of every server that has the impersonation guard on
      const gs = await ctx.db.query(`SELECT m.guild_id FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 AND g.impersonation_guard->>'enabled' = 'true' LIMIT 100`, [req.userId]);
      for (const g of gs) await checkImpersonation(ctx, g.guild_id, req.userId).catch((e) => ctx.log.warn({ err: e }, 'impersonation check failed'));
    }
    const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    await ctx.hub.toPresenceAudience(req.userId, 'USER_UPDATE', userDTO(ctx, row));
    if (b.privacy && 'showActivity' in (b.privacy as object)) await ctx.hub.broadcastPresence(req.userId); // the activity switch takes effect at once
    return selfUserDTO(ctx, row);
  });

  /**
   * Stage an avatar/banner fetched from a URL (the "Choose GIF" picker): downloaded through the SSRF guard and stored
   * like an upload, but not written to the profile — the returned URL is what the Save flow sends to PATCH /users/@me.
   */
  const profileImageFromUrl = z.object({ url: z.string().url().max(2048) }).strict();
  const stageProfileImage = async (userId: string, kind: 'avatar' | 'banner', body: unknown) => {
    const { url } = parse(profileImageFromUrl, body);
    limitOrThrow(ctx.rl, `profile-image:${userId}`, 10, 10 * 60_000, ctx.config.rateLimit);
    return { url: await storeImageFromUrl(ctx, userId, url, kind) };
  };
  app.post('/users/@me/avatar/from-url', async (req) => stageProfileImage(req.userId, 'avatar', req.body));
  app.post('/users/@me/banner/from-url', async (req) => stageProfileImage(req.userId, 'banner', req.body));

  /**
   * Exact (case-insensitive) username lookup for "Add Friend". Accepts `name`, `@name` and the legacy `name#0`/`name#0000`.
   * Blocks in either direction look like "no such user". Bots and deleted accounts are never returned.
   */
  app.get('/users', async (req) => {
    const { username } = parse(z.object({ username: z.string().trim().min(1).max(64) }), req.query);
    limitOrThrow(ctx.rl, `lookup:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // anti-enumeration
    let name = username.replace(/^@/, '');
    const disc = /^(.*)#(\d{1,4})$/.exec(name);
    if (disc) { if (!/^0+$/.test(disc[2]!)) throw notFound('User'); name = disc[1]!; } // only the "no discriminator" form exists here
    name = name.toLowerCase();
    if (!/^[a-z0-9_.]{2,32}$/.test(name)) throw notFound('User');
    const [row] = await ctx.db.query('SELECT * FROM users WHERE lower(username) = $1 AND NOT bot AND deleted_at IS NULL', [name]);
    if (!row) throw notFound('User');
    if (row.id !== req.userId) {
      const [blk] = await ctx.db.query(`SELECT 1 AS x FROM relationships WHERE type = 'blocked' AND ((user_id = $1 AND other_id = $2) OR (user_id = $2 AND other_id = $1)) LIMIT 1`, [req.userId, row.id]);
      if (blk) throw notFound('User');
    }
    return userDTO(ctx, row);
  });

  /**
   * Schedules deletion of the account after a grace period (config.accountDeletionGraceMs, 14 days by default): all sessions are signed out and
   * logging in again before the due date cancels it. Owners must transfer or delete their servers first. The sweeper erases the account at the due date.
   */
  app.delete('/users/@me', async (req, reply) => {
    const b = parse(z.object({ password: z.string().max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `delete-account:${req.userId}`, 5, 15 * 60_000, ctx.config.rateLimit);
    const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!u?.password_hash || !(await verifyPassword(u.password_hash, b.password))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    if (u.mfa_enabled && (!b.totp || !(await verifyTotp(ctx, u, b.totp)))) throw new ApiError(401, 'MFA_REQUIRED', 'A valid two-factor code is required');
    const owned = await ctx.db.query('SELECT id, name FROM guilds WHERE owner_id = $1', [req.userId]);
    if (owned.length) throw new ApiError(409, 'OWNS_GUILDS', 'Transfer ownership or delete your servers first', owned);
    const dueAt = await scheduleAccountDeletion(ctx, u);
    return reply.code(202).send({ deletionDueAt: dueAt.toISOString(), graceDays: Math.round(ctx.config.accountDeletionGraceMs / 86_400_000) });
  });
  /** Cancels a pending deletion explicitly (a login does the same). Only reachable with a valid session, i.e. one created by logging in during the grace period. */
  app.delete('/users/@me/deletion', async (req, reply) => {
    await ctx.db.query('UPDATE users SET deletion_due_at = NULL WHERE id = $1 AND deleted_at IS NULL', [req.userId]);
    return reply.code(204).send();
  });

  /** Legacy quick export (JSON, newest 10k messages). Prefer the async zip: POST /users/@me/exports. */
  app.get('/users/@me/export', async (req, reply) => {
    limitOrThrow(ctx.rl, `export:${req.userId}`, 3, 3600_000, ctx.config.rateLimit);
    const id = req.userId, MAX_MESSAGES = 10_000; // legacy synchronous export; the full archive is POST /users/@me/exports
    const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [id]);
    const guilds = await ctx.db.query('SELECT g.id, g.name, m.nick, m.joined_at, (g.owner_id = m.user_id) AS owner FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = $1 ORDER BY m.joined_at', [id]);
    const dms = await ctx.db.query('SELECT c.* FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = $1', [id]);
    const messages = await ctx.db.query('SELECT id, channel_id, guild_id, content, type, reply_to, edited_at, attachments FROM messages WHERE author_id = $1 AND webhook_id IS NULL AND type IN (\'default\',\'reply\') ORDER BY id DESC LIMIT $2', [id, MAX_MESSAGES + 1]);
    const sessions = await ctx.db.query('SELECT id, user_agent, ip, created_at, last_used_at, expires_at, revoked FROM sessions WHERE user_id = $1 ORDER BY created_at', [id]);
    const files = await ctx.db.query('SELECT id, filename, content_type, size, created_at FROM files WHERE uploader_id = $1 ORDER BY created_at', [id]);
    const reactions = await ctx.db.query('SELECT message_id, emoji, created_at FROM reactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50000', [id]);
    const out = {
      exportedAt: new Date().toISOString(), format: 'jorcord-export-v1',
      user: { ...selfUserDTO(ctx, u), createdAt: iso(u.created_at), bio: u.bio ?? null, pronouns: u.pronouns ?? null }, // mfa secret / password hash are deliberately excluded
      relationships: await relationshipDTOs(ctx, id),
      guilds: guilds.map((g) => ({ id: g.id, name: g.name, nick: g.nick ?? null, joinedAt: iso(g.joined_at), owner: g.owner })),
      directChannels: dms.map((c) => ({ id: c.id, type: c.type, name: c.name ?? null })),
      messages: messages.slice(0, MAX_MESSAGES).map((m) => ({ id: m.id, channelId: m.channel_id, guildId: m.guild_id ?? null, content: m.content, type: m.type, replyTo: m.reply_to ?? null, editedAt: iso(m.edited_at), attachments: m.attachments })),
      messagesTruncated: messages.length > MAX_MESSAGES,
      reactions: reactions.map((r) => ({ messageId: r.message_id, emoji: r.emoji, at: iso(r.created_at) })),
      files: files.map((f) => ({ id: f.id, filename: f.filename, contentType: f.content_type, size: Number(f.size), uploadedAt: iso(f.created_at) })),
      sessions: sessions.map((s) => ({ id: s.id, userAgent: s.user_agent, ip: s.ip, createdAt: iso(s.created_at), lastUsedAt: iso(s.last_used_at), revoked: s.revoked })),
    };
    reply.header('content-disposition', `attachment; filename="jorcord-export-${id}.json"`).header('cache-control', 'no-store');
    return out;
  });

  app.get('/users/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const user = await getUser(ctx, id);
    if (!user) throw notFound('User');
    const mutual = await ctx.db.query(
      'SELECT g.id, g.name, g.icon FROM guilds g JOIN members a ON a.guild_id = g.id AND a.user_id = $1 JOIN members b ON b.guild_id = g.id AND b.user_id = $2', [req.userId, id]);
    const mutualFriendIds = id === req.userId ? [] : (await ctx.db.query(
      `SELECT a.other_id FROM relationships a JOIN relationships b ON b.other_id = a.other_id AND b.user_id = $2 AND b.type = 'friend' WHERE a.user_id = $1 AND a.type = 'friend' LIMIT 100`, [req.userId, id])).map((r) => r.other_id as string);
    const mf = await usersByIds(ctx, mutualFriendIds);
    const [note] = await ctx.db.query('SELECT note FROM user_notes WHERE user_id = $1 AND target_id = $2', [req.userId, id]);
    const [ar] = await ctx.db.query('SELECT presence, activities, privacy FROM users WHERE id = $1', [id]);
    const activities = id === req.userId ? (Array.isArray(ar?.activities) ? ar.activities : []) : ar ? publicActivities(ctx, id, ar) : [];
    return { ...user, activities, connections: await publicConnections(ctx, id), mutualGuilds: mutual, mutualFriends: [...mf.values()], note: (note?.note as string | undefined) ?? null };
  });

  app.put('/users/@me/presence', async (req, reply) => {
    const { presence } = parse(z.object({ presence: z.enum(['online', 'idle', 'dnd', 'invisible']) }).strict(), req.body);
    await ctx.db.query('UPDATE users SET presence = $2 WHERE id = $1', [req.userId, presence]);
    await ctx.hub.broadcastPresence(req.userId);
    return reply.code(204).send();
  });

  app.get('/users/@me/guilds', async (req) => {
    const rows = await ctx.db.query(`${GUILD_SELECT} JOIN members m ON m.guild_id = g.id WHERE m.user_id = $1 ORDER BY m.joined_at`, [req.userId]);
    return rows.map(guildDTO);
  });
  app.delete('/users/@me/guilds/:guildId', async (req, reply) => {
    const { guildId } = parse(z.object({ guildId: idSchema }), req.params);
    const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
    const [m] = await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, req.userId]);
    if (!g || !m) throw notFound('Guild');
    if (g.owner_id === req.userId) throw new ApiError(400, 'OWNER_CANNOT_LEAVE', 'Transfer ownership or delete the guild instead');
    await removeMemberFromGuild(ctx, guildId, req.userId); // same cleanup as a kick: voice, private threads, tag, bot install
    return reply.code(204).send();
  });

  // ---------- DMs ----------
  app.get('/users/@me/channels', async (req) => {
    const rows = await ctx.db.query('SELECT c.* FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = $1 AND NOT (p.request AND c.last_message_id IS NULL) ORDER BY c.last_message_id DESC NULLS LAST, c.id DESC', [req.userId]);
    return channelsDTO(ctx, rows);
  });
  app.post('/users/@me/channels', async (req, reply) => {
    const { recipientIds, encrypted } = parse(z.object({ recipientIds: z.array(idSchema).min(1).max(9), /** opt-in end-to-end encrypted 1:1 "secret chat" (docs/E2EE_DMS.md) */ encrypted: z.boolean().optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `dmcreate:${req.userId}`, 20, 60_000, ctx.config.rateLimit); // DM spam brake
    const others = [...new Set(recipientIds)];
    if (others.includes(req.userId)) throw badRequest('Cannot DM yourself');
    const found = await ctx.db.query('SELECT id FROM users WHERE id = ANY($1::text[]) AND NOT bot AND deleted_at IS NULL', [others]);
    if (found.length !== others.length) throw notFound('User');
    const blocked = await ctx.db.query(`SELECT 1 AS x FROM relationships WHERE type = 'blocked' AND ((user_id = $1 AND other_id = ANY($2::text[])) OR (other_id = $1 AND user_id = ANY($2::text[]))) LIMIT 1`, [req.userId, others]);
    if (blocked.length) throw forbidden('Cannot message this user', 'BLOCKED');
    const all = [req.userId, ...others];
    const isGroup = others.length > 1;
    if (encrypted && isGroup) throw badRequest('Secret chats are 1:1 only; there is no end-to-end encryption for group DMs');
    const dmKey = isGroup ? null : [...all].sort().join(':') + (encrypted ? ':e2ee' : ''); // a secret chat lives next to the normal DM with the same person
    if (dmKey) {
      const [ex] = await ctx.db.query('SELECT * FROM channels WHERE dm_key = $1', [dmKey]);
      if (ex) return channelDTO(ctx, ex);
    }
    const friendIds = new Set((await ctx.db.query(`SELECT other_id FROM relationships WHERE user_id = $1 AND other_id = ANY($2::text[]) AND type = 'friend'`, [req.userId, others])).map((r) => r.other_id as string));
    const requestFor = new Set<string>();
    for (const o of others) { // must be friends or share a guild that lets its members DM each other (anti-spam)
      if (friendIds.has(o)) continue;
      const sc = await sharedContext(ctx, req.userId, o);
      if (!sc.shared) throw forbidden('You need to be friends or share a server with this user', 'NO_SHARED_CONTEXT');
      assertServerAllowsDm(sc);
      await assertNotDmLimited(ctx, req.userId);
      const [ign] = await ctx.db.query('SELECT 1 AS x FROM dm_ignores WHERE user_id = $1 AND other_id = $2', [o, req.userId]);
      if (ign) throw forbidden('This user does not accept messages from you', 'DM_DISABLED');
      const pv = await privacyOf(ctx, o);
      if (!pv.allowDmsFromServerMembers) throw forbidden('This user does not accept direct messages from server members', 'DM_DISABLED');
      if (!isGroup && pv.messageRequests) requestFor.add(o);
    }
    const id = snowflake();
    await ctx.db.tx(async (q) => {
      await q.query('INSERT INTO channels (id, guild_id, type, dm_key, owner_id, name, encrypted) VALUES ($1,NULL,$2,$3,$4,NULL,$5)', [id, isGroup ? 'group_dm' : 'dm', dmKey, isGroup ? req.userId : null, !!encrypted]);
      for (const u of all) await q.query('INSERT INTO dm_participants (channel_id, user_id, request) VALUES ($1,$2,$3)', [id, u, requestFor.has(u)]);
    });
    await ctx.pcache.invalidate({ k: 'dm', channelId: id });
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
    const dto = await channelDTO(ctx, row);
    // a message request stays invisible to its recipient until the first message arrives (see createMessage)
    await ctx.hub.toUsers(all.filter((u) => !requestFor.has(u)), 'CHANNEL_CREATE', dto);
    return reply.code(201).send(dto);
  });

  // ---------- relationships ----------
  app.get('/users/@me/relationships', async (req) => relationshipDTOs(ctx, req.userId));
  app.put('/users/@me/relationships/:userId', async (req) => {
    const { userId: other } = parse(z.object({ userId: idSchema }), req.params);
    const { type } = parse(z.object({ type: z.enum(['friend', 'blocked']) }).strict(), req.body);
    const me = req.userId;
    limitOrThrow(ctx.rl, `rel:${me}`, 30, 60_000, ctx.config.rateLimit); // friend-request spam brake
    limitOrThrow(ctx.rl, `rel-day:${me}`, 300, 86_400_000, ctx.config.rateLimit);
    if (other === me) throw badRequest('Cannot target yourself');
    const [target] = await ctx.db.query('SELECT id FROM users WHERE id = $1 AND NOT bot AND deleted_at IS NULL', [other]);
    if (!target) throw notFound('User');
    const [mine] = await ctx.db.query('SELECT type FROM relationships WHERE user_id = $1 AND other_id = $2', [me, other]);
    const [theirs] = await ctx.db.query('SELECT type FROM relationships WHERE user_id = $2 AND other_id = $1', [me, other]);
    const upsert = (u: string, o: string, t: string) => ctx.db.query(`INSERT INTO relationships (user_id, other_id, type) VALUES ($1,$2,$3) ON CONFLICT (user_id, other_id) DO UPDATE SET type = $3`, [u, o, t]);
    /** Sends `of`'s current presence to `to` (presence fan-out only covers existing friends/guild peers). */
    const tellPresence = async (to: string, of: string) => {
      const [r] = await ctx.db.query('SELECT presence, custom_status, activities, privacy FROM users WHERE id = $1', [of]);
      if (r && ctx.hub.isOnline(of)) await ctx.hub.toUser(to, 'PRESENCE_UPDATE', { userId: of, presence: ctx.hub.publicPresence(of, r.presence), customStatus: liveStatus(r.custom_status), activities: publicActivities(ctx, of, r) });
    };
    const push = async (u: string, o: string, t: Relationship['type']) => { const usr = await getUser(ctx, o); if (usr) await ctx.hub.toUser(u, 'RELATIONSHIP_ADD', { user: usr, type: t }); };
    if (type === 'blocked') {
      await upsert(me, other, 'blocked');
      if (theirs && theirs.type !== 'blocked') { await ctx.db.query('DELETE FROM relationships WHERE user_id = $2 AND other_id = $1', [me, other]); await ctx.hub.toUser(other, 'RELATIONSHIP_REMOVE', { userId: me }); }
      await push(me, other, 'blocked');
      return { type: 'blocked' };
    }
    if (mine?.type === 'blocked') throw forbidden('Unblock this user first', 'BLOCKED');
    if (theirs?.type === 'blocked') throw forbidden('Cannot send a friend request to this user', 'BLOCKED');
    if (mine?.type === 'friend') return { type: 'friend' };
    if (mine?.type === 'outgoing') return { type: 'outgoing' };
    if (theirs?.type !== 'outgoing' && !(await canSendFriendRequest(ctx, me, other))) throw forbidden('Cannot send a friend request to this user', 'FRIEND_REQUEST_BLOCKED');
    if (theirs?.type === 'outgoing') { // they already asked us: accept
      await upsert(me, other, 'friend'); await upsert(other, me, 'friend');
      await push(me, other, 'friend'); await push(other, me, 'friend');
      await tellPresence(me, other); await tellPresence(other, me); // new friends see each other's status right away
      const [self] = await ctx.db.query('SELECT id, username, display_name FROM users WHERE id = $1', [me]);
      ctx.push.notifyFriendRequest(other, { id: me, username: self.username, displayName: self.display_name ?? null }, true);
      return { type: 'friend' };
    }
    await upsert(me, other, 'outgoing'); await upsert(other, me, 'incoming');
    await push(me, other, 'outgoing'); await push(other, me, 'incoming');
    const [self] = await ctx.db.query('SELECT id, username, display_name FROM users WHERE id = $1', [me]);
    ctx.push.notifyFriendRequest(other, { id: me, username: self.username, displayName: self.display_name ?? null });
    return { type: 'outgoing' };
  });
  app.delete('/users/@me/relationships/:userId', async (req, reply) => {
    const { userId: other } = parse(z.object({ userId: idSchema }), req.params);
    const [mine] = await ctx.db.query('SELECT type FROM relationships WHERE user_id = $1 AND other_id = $2', [req.userId, other]);
    if (!mine) throw notFound('Relationship');
    await ctx.db.query('DELETE FROM relationships WHERE user_id = $1 AND other_id = $2', [req.userId, other]);
    await ctx.hub.toUser(req.userId, 'RELATIONSHIP_REMOVE', { userId: other });
    if (mine.type !== 'blocked') {
      await ctx.db.query(`DELETE FROM relationships WHERE user_id = $2 AND other_id = $1 AND type <> 'blocked'`, [req.userId, other]);
      await ctx.hub.toUser(other, 'RELATIONSHIP_REMOVE', { userId: req.userId });
    }
    return reply.code(204).send();
  });

  // ---------- read states ----------
  app.get('/users/@me/read-states', async (req) => {
    const rows = await ctx.db.query('SELECT * FROM read_states WHERE user_id = $1', [req.userId]);
    return rows.map((r) => ({ channelId: r.channel_id, lastReadId: r.last_read_id ?? null, mentionCount: r.mention_count }));
  });
  /**
   * Read marker. Acks only move forward (a late ack from a stale tab or device must not bring old messages back as unread);
   * `unread: true` ("Mark Unread" on a message) sets the marker just before that message instead.
   */
  app.post('/channels/:id/ack', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const { messageId, unread } = parse(z.object({ messageId: idSchema, unread: z.boolean().optional() }).strict(), req.body);
    await channelAccess(ctx, req.userId, id);
    const [msg] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [messageId, id]);
    if (!msg) throw notFound('Message');
    const [rs] = unread
      ? await ctx.db.query(
        `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1,$2,$3,0)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = $3, mention_count = 0 RETURNING *`, [req.userId, id, (BigInt(messageId) - 1n).toString()])
      : await ctx.db.query(
        `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1,$2,$3,0)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET
           last_read_id = CASE WHEN read_states.last_read_id IS NULL OR length($3) > length(read_states.last_read_id) OR (length($3) = length(read_states.last_read_id) AND $3 > read_states.last_read_id) THEN $3 ELSE read_states.last_read_id END,
           mention_count = CASE WHEN read_states.last_read_id IS NULL OR length($3) > length(read_states.last_read_id) OR (length($3) = length(read_states.last_read_id) AND $3 >= read_states.last_read_id) THEN 0 ELSE read_states.mention_count END
         RETURNING *`, [req.userId, id, messageId]);
    const dto = { channelId: id, lastReadId: rs.last_read_id as string, mentionCount: rs.mention_count as number };
    await ctx.hub.toUser(req.userId, 'READ_STATE_UPDATE', dto);
    return dto;
  });
}
