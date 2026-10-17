import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computePermissions, MAX_FOLLOWERS_PER_CHANNEL, MessageFlags, Perm, has, snowflake, type ChannelFollow } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { createMessage } from '../services/messages';
import { channelAccess, need } from '../services/perms';
import { messageDTO } from '../services/serializers';

const row = (f: any): ChannelFollow => ({ id: f.id, sourceChannelId: f.source_channel_id, targetChannelId: f.target_channel_id, targetGuildId: f.target_guild_id, createdAt: iso(f.created_at)! });

/** Neutralise pings in crossposted text: foreign ids must never notify people in the receiving server. */
export const defang = (s: string) => s.replace(/<@!?\d+>/g, '@someone').replace(/<@&\d+>/g, '@role').replace(/@(everyone|here)\b/g, '@​$1');

/** Announcement channels: other channels follow them, and "publishing" a message copies it into every follower. */
export function followRoutes(app: FastifyInstance, ctx: Ctx) {
  const cid = z.object({ id: idSchema });
  const names = async (channelIds: string[]) => {
    const rows = channelIds.length ? await ctx.db.query('SELECT c.id, c.name, c.guild_id, g.name AS guild_name, g.icon AS guild_icon FROM channels c JOIN guilds g ON g.id = c.guild_id WHERE c.id = ANY($1::text[])', [channelIds]) : [];
    return new Map(rows.map((r) => [r.id as string, r]));
  };

  /**
   * The announcement channel must be one the caller can read: they are in its server, or the server is in Discovery and the channel
   * is public (@everyone may view it), which is how a server follows another community's news.
   */
  async function followableSource(userId: string, channelId: string) {
    try {
      const a = await channelAccess(ctx, userId, channelId);
      need(a.perms, Perm.VIEW_CHANNEL, Perm.READ_MESSAGE_HISTORY);
      return a.channel;
    } catch (e) {
      const [c] = await ctx.db.query(`SELECT c.*, g.features FROM channels c JOIN guilds g ON g.id = c.guild_id WHERE c.id = $1`, [channelId]);
      if (!c || !(c.features as string[]).includes('DISCOVERABLE')) throw e;
      const [ev] = await ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [c.guild_id]);
      const ow = await ctx.pcache.channelOverwrites(ctx, c.id);
      const perms = computePermissions({ isOwner: false, everyoneRoleId: c.guild_id, everyonePerms: BigInt(ev?.permissions ?? '0'), memberRoleIds: [], rolePerms: {}, memberId: '', overwrites: ow });
      if (!has(perms, Perm.VIEW_CHANNEL) || !has(perms, Perm.READ_MESSAGE_HISTORY)) throw e;
      return c;
    }
  }

  app.post('/channels/:id/followers', async (req, reply) => {
    const { id } = parse(cid, req.params);
    const { webhookChannelId } = parse(z.object({ webhookChannelId: idSchema }).strict(), req.body);
    limitOrThrow(ctx.rl, `follow:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    const src = await followableSource(req.userId, id);
    if (src.type !== 'announcement') throw badRequest('Only announcement channels can be followed');
    if (webhookChannelId === id) throw badRequest('A channel cannot follow itself');
    const dst = await channelAccess(ctx, req.userId, webhookChannelId);
    if (dst.channel.type !== 'text' && dst.channel.type !== 'announcement') throw badRequest('Announcements can only be delivered to text channels');
    need(dst.perms, Perm.MANAGE_WEBHOOKS);
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM channel_follows WHERE source_channel_id = $1', [id]);
    if (n.n >= MAX_FOLLOWERS_PER_CHANNEL) throw new ApiError(400, 'MAX_FOLLOWERS', 'This announcement channel has too many followers');
    const fid = snowflake();
    try { await ctx.db.query('INSERT INTO channel_follows (id, source_channel_id, target_channel_id, target_guild_id, creator_id) VALUES ($1,$2,$3,$4,$5)', [fid, id, webhookChannelId, dst.channel.guild_id, req.userId]); }
    catch (e: any) { if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw new ApiError(409, 'ALREADY_FOLLOWING', 'That channel already follows this one'); throw e; }
    await audit(ctx, dst.channel.guild_id, req.userId, 'CHANNEL_FOLLOW_CREATE', webhookChannelId, { sourceChannelId: id });
    return reply.code(201).send({ channelId: id, webhookId: fid, ...row((await ctx.db.query('SELECT * FROM channel_follows WHERE id = $1', [fid]))[0]) });
  });

  /** Who follows this announcement channel (MANAGE_WEBHOOKS on it). */
  app.get('/channels/:id/followers', async (req) => {
    const { id } = parse(cid, req.params);
    const a = await channelAccess(ctx, req.userId, id); need(a.perms, Perm.MANAGE_WEBHOOKS);
    const rows = await ctx.db.query('SELECT * FROM channel_follows WHERE source_channel_id = $1 ORDER BY id', [id]);
    const nm = await names(rows.map((r) => r.target_channel_id));
    return rows.map((r) => { const t = nm.get(r.target_channel_id); return { ...row(r), target: t ? { channelName: t.name, guildId: t.guild_id, guildName: t.guild_name } : undefined }; });
  });

  /** What this channel follows (MANAGE_WEBHOOKS on it). */
  app.get('/channels/:id/follows', async (req) => {
    const { id } = parse(cid, req.params);
    const a = await channelAccess(ctx, req.userId, id); need(a.perms, Perm.MANAGE_WEBHOOKS);
    const rows = await ctx.db.query('SELECT * FROM channel_follows WHERE target_channel_id = $1 ORDER BY id', [id]);
    const nm = await names(rows.map((r) => r.source_channel_id));
    return rows.map((r) => { const s = nm.get(r.source_channel_id); return { ...row(r), source: s ? { channelName: s.name, guildId: s.guild_id, guildName: s.guild_name, guildIcon: s.guild_icon ?? null } : undefined }; });
  });

  /** Stop following: allowed with MANAGE_WEBHOOKS on the following channel or on the announcement channel. */
  app.delete('/follows/:id', async (req, reply) => {
    const { id } = parse(cid, req.params);
    const [f] = await ctx.db.query('SELECT * FROM channel_follows WHERE id = $1', [id]);
    if (!f) throw notFound('Follow');
    let ok = false;
    for (const chId of [f.target_channel_id, f.source_channel_id]) {
      try { const a = await channelAccess(ctx, req.userId, chId); if (has(a.perms, Perm.MANAGE_WEBHOOKS)) { ok = true; break; } } catch { /* cannot see that side */ }
    }
    if (!ok) throw forbidden('Missing permissions');
    await ctx.db.query('DELETE FROM channel_follows WHERE id = $1', [id]);
    await audit(ctx, f.target_guild_id, req.userId, 'CHANNEL_FOLLOW_DELETE', f.target_channel_id, { sourceChannelId: f.source_channel_id });
    return reply.code(204).send();
  });

  /** Publish a message of an announcement channel to everybody who follows it. Author (SEND_MESSAGES) or MANAGE_MESSAGES; once per message. */
  app.post('/channels/:id/messages/:mid/crosspost', async (req) => {
    const p = parse(z.object({ id: idSchema, mid: idSchema }), req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.type !== 'announcement') throw badRequest('Only messages in announcement channels can be published');
    limitOrThrow(ctx.rl, `crosspost:${p.id}`, 10, 3_600_000, ctx.config.rateLimit);
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.author_id !== req.userId) need(a.perms, Perm.MANAGE_MESSAGES); else need(a.perms, Perm.SEND_MESSAGES);
    if (m.type !== 'default' && m.type !== 'reply') throw badRequest('This kind of message cannot be published');
    if (m.flags & MessageFlags.IS_CROSSPOST) throw badRequest('A published copy cannot be published again');
    const claimed = await ctx.db.query('UPDATE messages SET flags = flags | $2 WHERE id = $1 AND (flags & $2) = 0 RETURNING id', [p.mid, MessageFlags.CROSSPOSTED]);
    if (!claimed.length) throw new ApiError(400, 'ALREADY_CROSSPOSTED', 'This message was already published');
    const [g] = await ctx.db.query('SELECT name FROM guilds WHERE id = $1', [a.channel.guild_id]);
    const follows = await ctx.db.query('SELECT * FROM channel_follows WHERE source_channel_id = $1', [p.id]);
    const origin = { guildId: a.channel.guild_id, guildName: g.name, channelId: p.id, channelName: a.channel.name ?? '', messageId: p.mid };
    for (const f of follows) {
      const [target] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [f.target_channel_id]);
      if (!target) continue;
      try {
        await createMessage(ctx, { channel: target, authorId: m.author_id, content: defang(m.content), attachments: m.attachments ?? [], senderPerms: 0n, skipChecks: true, flags: MessageFlags.IS_CROSSPOST, crosspost: origin, allowEmpty: true });
      } catch (e) { ctx.log.warn({ err: e, follow: f.id }, 'crosspost delivery failed'); }
    }
    const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    const dto = await messageDTO(ctx, fresh, req.userId);
    await ctx.hub.toChannel(p.id, 'MESSAGE_UPDATE', { ...dto, reactions: dto.reactions.map((r) => ({ ...r, me: false })) });
    return dto;
  });
}
