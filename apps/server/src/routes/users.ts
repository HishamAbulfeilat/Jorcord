import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Relationship } from '@jorcord/shared';
import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, parse } from '../lib/ids';
import { channelAccess } from '../services/perms';
import { channelDTO, channelsDTO, getUser, GUILD_SELECT, guildDTO, selfUserDTO, userDTO, usersByIds } from '../services/serializers';

const patchMe = z.object({
  displayName: z.string().trim().min(1).max(32).nullable(), bio: z.string().max(400).nullable(), pronouns: z.string().max(40).nullable(),
  avatar: assetUrl.nullable(), banner: assetUrl.nullable(), accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  customStatus: z.object({ text: z.string().max(128).nullable(), emoji: z.string().max(64).nullable() }).strict().nullable(),
  theme: z.enum(['dark', 'light', 'amoled']),
  settings: z.record(z.unknown()).refine((v) => JSON.stringify(v).length <= 16_384, 'settings too large'),
}).partial().strict();

const COLS: Record<string, string> = { displayName: 'display_name', bio: 'bio', pronouns: 'pronouns', avatar: 'avatar', banner: 'banner', accentColor: 'accent_color', customStatus: 'custom_status', theme: 'theme', settings: 'settings' };

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
      vals.push(k === 'customStatus' || k === 'settings' ? (v === null ? null : JSON.stringify(v)) : v);
      sets.push(`${col} = $${vals.length}${k === 'customStatus' || k === 'settings' ? '::jsonb' : ''}`);
    }
    if (sets.length) await ctx.db.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
    const [row] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    await ctx.hub.toPresenceAudience(req.userId, 'USER_UPDATE', userDTO(ctx, row));
    return selfUserDTO(ctx, row);
  });

  app.get('/users/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const user = await getUser(ctx, id);
    if (!user) throw notFound('User');
    const mutual = await ctx.db.query(
      'SELECT g.id, g.name, g.icon FROM guilds g JOIN members a ON a.guild_id = g.id AND a.user_id = $1 JOIN members b ON b.guild_id = g.id AND b.user_id = $2', [req.userId, id]);
    return { ...user, mutualGuilds: mutual };
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
    await ctx.db.query('DELETE FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, req.userId]);
    await ctx.hub.toUser(req.userId, 'GUILD_DELETE', { id: guildId });
    await ctx.hub.toGuild(guildId, 'MEMBER_REMOVE', { guildId, userId: req.userId });
    return reply.code(204).send();
  });

  // ---------- DMs ----------
  app.get('/users/@me/channels', async (req) => {
    const rows = await ctx.db.query('SELECT c.* FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = $1 ORDER BY c.last_message_id DESC NULLS LAST, c.id DESC', [req.userId]);
    return channelsDTO(ctx, rows);
  });
  app.post('/users/@me/channels', async (req, reply) => {
    const { recipientIds } = parse(z.object({ recipientIds: z.array(idSchema).min(1).max(9) }).strict(), req.body);
    const others = [...new Set(recipientIds)];
    if (others.includes(req.userId)) throw badRequest('Cannot DM yourself');
    const found = await ctx.db.query('SELECT id FROM users WHERE id = ANY($1::text[]) AND NOT bot', [others]);
    if (found.length !== others.length) throw notFound('User');
    const blocked = await ctx.db.query(`SELECT 1 AS x FROM relationships WHERE type = 'blocked' AND ((user_id = $1 AND other_id = ANY($2::text[])) OR (other_id = $1 AND user_id = ANY($2::text[]))) LIMIT 1`, [req.userId, others]);
    if (blocked.length) throw forbidden('Cannot message this user', 'BLOCKED');
    for (const o of others) { // must be friends or share a guild (anti-spam)
      const [ok] = await ctx.db.query(
        `SELECT 1 AS x WHERE EXISTS (SELECT 1 FROM relationships WHERE user_id = $1 AND other_id = $2 AND type = 'friend')
            OR EXISTS (SELECT 1 FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = $1 AND b.user_id = $2)`, [req.userId, o]);
      if (!ok) throw forbidden('You need to be friends or share a server with this user', 'NO_SHARED_CONTEXT');
    }
    const all = [req.userId, ...others];
    const isGroup = others.length > 1;
    const dmKey = isGroup ? null : [...all].sort().join(':');
    if (dmKey) {
      const [ex] = await ctx.db.query('SELECT * FROM channels WHERE dm_key = $1', [dmKey]);
      if (ex) return channelDTO(ctx, ex);
    }
    const id = snowflake();
    await ctx.db.tx(async (q) => {
      await q.query('INSERT INTO channels (id, guild_id, type, dm_key, owner_id, name) VALUES ($1,NULL,$2,$3,$4,NULL)', [id, isGroup ? 'group_dm' : 'dm', dmKey, isGroup ? req.userId : null]);
      for (const u of all) await q.query('INSERT INTO dm_participants (channel_id, user_id) VALUES ($1,$2)', [id, u]);
    });
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [id]);
    const dto = await channelDTO(ctx, row);
    await ctx.hub.toUsers(all, 'CHANNEL_CREATE', dto);
    return reply.code(201).send(dto);
  });

  // ---------- relationships ----------
  app.get('/users/@me/relationships', async (req) => relationshipDTOs(ctx, req.userId));
  app.put('/users/@me/relationships/:userId', async (req) => {
    const { userId: other } = parse(z.object({ userId: idSchema }), req.params);
    const { type } = parse(z.object({ type: z.enum(['friend', 'blocked']) }).strict(), req.body);
    const me = req.userId;
    if (other === me) throw badRequest('Cannot target yourself');
    const [target] = await ctx.db.query('SELECT id FROM users WHERE id = $1 AND NOT bot', [other]);
    if (!target) throw notFound('User');
    const [mine] = await ctx.db.query('SELECT type FROM relationships WHERE user_id = $1 AND other_id = $2', [me, other]);
    const [theirs] = await ctx.db.query('SELECT type FROM relationships WHERE user_id = $2 AND other_id = $1', [me, other]);
    const upsert = (u: string, o: string, t: string) => ctx.db.query(`INSERT INTO relationships (user_id, other_id, type) VALUES ($1,$2,$3) ON CONFLICT (user_id, other_id) DO UPDATE SET type = $3`, [u, o, t]);
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
    if (theirs?.type === 'outgoing') { // they already asked us: accept
      await upsert(me, other, 'friend'); await upsert(other, me, 'friend');
      await push(me, other, 'friend'); await push(other, me, 'friend');
      return { type: 'friend' };
    }
    await upsert(me, other, 'outgoing'); await upsert(other, me, 'incoming');
    await push(me, other, 'outgoing'); await push(other, me, 'incoming');
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
  app.post('/channels/:id/ack', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const { messageId } = parse(z.object({ messageId: idSchema }).strict(), req.body);
    await channelAccess(ctx, req.userId, id);
    const [msg] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [messageId, id]);
    if (!msg) throw notFound('Message');
    const [rs] = await ctx.db.query(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1,$2,$3,0)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = $3, mention_count = 0 RETURNING *`, [req.userId, id, messageId]);
    const dto = { channelId: id, lastReadId: rs.last_read_id as string, mentionCount: 0 };
    await ctx.hub.toUser(req.userId, 'READ_STATE_UPDATE', dto);
    return dto;
  });
}
