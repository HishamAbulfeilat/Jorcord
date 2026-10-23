import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_STREAM_FEED_TEMPLATES, MAX_STREAM_FEEDS, MAX_STREAM_FEED_TEMPLATE, Perm, STREAM_FEED_PROVIDERS, has, snowflake, type StreamFeedsResponse } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { channelAccess, guildAccess, guildPerms, need } from '../services/perms';
import { feedDTO, providerEnabled, resolveTarget, validateTemplate } from '../services/streamfeeds';

const gp = z.object({ id: idSchema });
const fp = z.object({ id: idSchema, feedId: idSchema });
const channelInput = z.string().trim().min(1).max(200);
const templateInput = z.string().max(MAX_STREAM_FEED_TEMPLATE * 2);

/** Server Settings > Integrations > Stream & video feeds. Everything needs Manage Server. */
export function streamFeedRoutes(app: FastifyInstance, ctx: Ctx) {
  const manager = async (req: { userId: string; isBot: boolean }, guildId: string) => {
    if (req.isBot) throw forbidden('Bots cannot manage feeds', 'BOT_FORBIDDEN');
    const perms = guildPerms(await guildAccess(ctx, req.userId, guildId));
    need(perms, Perm.MANAGE_GUILD);
  };

  /** Where announcements go: a text/announcement channel of this server the caller can see and post in. Returns the caller's permissions there. */
  async function targetChannel(userId: string, guildId: string, channelId: string): Promise<bigint> {
    const a = await channelAccess(ctx, userId, channelId);
    if (a.channel.guild_id !== guildId) throw notFound('Channel');
    if (!['text', 'announcement'].includes(a.channel.type)) throw badRequest('Announcements can only go to a text or announcement channel');
    need(a.perms, Perm.SEND_MESSAGES);
    return a.perms;
  }

  /** The same rule as mentioning a role by hand: it must be mentionable unless you hold Mention Everyone. Returns whether the privilege was needed. */
  async function checkRole(guildId: string, roleId: string, perms: bigint): Promise<boolean> {
    const [role] = await ctx.db.query('SELECT id, mentionable FROM roles WHERE id = $1 AND guild_id = $2', [roleId, guildId]);
    if (!role) throw notFound('Role');
    if (role.mentionable) return false;
    if (!has(perms, Perm.MENTION_EVERYONE)) throw forbidden('That role is not mentionable and you cannot mention every role', 'MISSING_PERMISSIONS');
    return true;
  }

  app.get('/guilds/:id/stream-feeds', async (req): Promise<StreamFeedsResponse> => {
    const { id } = parse(gp, req.params);
    await manager(req, id);
    const rows = await ctx.db.query('SELECT * FROM stream_feeds WHERE guild_id = $1 ORDER BY created_at, id', [id]);
    return { feeds: rows.map(feedDTO), providers: providerEnabled(ctx), max: MAX_STREAM_FEEDS };
  });

  app.post('/guilds/:id/stream-feeds', async (req, reply) => {
    const { id } = parse(gp, req.params);
    const b = parse(z.object({ provider: z.enum(STREAM_FEED_PROVIDERS), channel: channelInput, channelId: idSchema, template: templateInput.optional(), roleId: idSchema.nullish() }).strict(), req.body);
    await manager(req, id);
    limitOrThrow(ctx.rl, `stream-feed-create:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    limitOrThrow(ctx.rl, `stream-feed-guild:${id}`, 30, 60 * 60_000, ctx.config.rateLimit);
    if (!providerEnabled(ctx)[b.provider]) throw new ApiError(501, 'FEATURE_DISABLED', 'Twitch announcements are not enabled on this server');
    const template = validateTemplate(b.template ?? DEFAULT_STREAM_FEED_TEMPLATES[b.provider]);
    const perms = await targetChannel(req.userId, id, b.channelId);
    const privileged = b.roleId ? await checkRole(id, b.roleId, perms) : false;
    const [{ n }] = await ctx.db.query('SELECT count(*)::int AS n FROM stream_feeds WHERE guild_id = $1', [id]) as any[];
    if (n >= MAX_STREAM_FEEDS) throw new ApiError(400, 'LIMIT_REACHED', `A server can have at most ${MAX_STREAM_FEEDS} feeds`);
    const target = await resolveTarget(ctx, b.provider, b.channel); // network: after every cheap check
    const feedId = snowflake();
    // the conditional insert keeps the cap even when two managers add a feed at the same moment
    const rows = await ctx.db.query(
      `INSERT INTO stream_feeds (id, guild_id, provider, external_id, name, channel_id, template, role_id, mention_privileged, mention_by, created_by)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::boolean,$10,$10 WHERE (SELECT count(*) FROM stream_feeds WHERE guild_id = $2) < $11::int
       ON CONFLICT (guild_id, provider, external_id) DO NOTHING RETURNING *`,
      [feedId, id, b.provider, target.externalId, target.name, b.channelId, template, b.roleId ?? null, privileged, req.userId, MAX_STREAM_FEEDS]);
    if (!rows.length) {
      const [dup] = await ctx.db.query('SELECT 1 AS x FROM stream_feeds WHERE guild_id = $1 AND provider = $2 AND external_id = $3', [id, b.provider, target.externalId]);
      if (dup) throw new ApiError(409, 'ALREADY_EXISTS', 'That channel already has a feed in this server');
      throw new ApiError(400, 'LIMIT_REACHED', `A server can have at most ${MAX_STREAM_FEEDS} feeds`);
    }
    await audit(ctx, id, req.userId, 'STREAM_FEED_CREATE', feedId, { provider: b.provider, externalId: target.externalId, channelId: b.channelId, roleId: b.roleId ?? null });
    return reply.code(201).send(feedDTO(rows[0]));
  });

  app.patch('/guilds/:id/stream-feeds/:feedId', async (req) => {
    const p = parse(fp, req.params);
    const b = parse(z.object({ channelId: idSchema.optional(), template: templateInput.optional(), roleId: idSchema.nullable().optional(), enabled: z.boolean().optional() }).strict(), req.body);
    await manager(req, p.id);
    limitOrThrow(ctx.rl, `stream-feed-edit:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const [cur] = await ctx.db.query('SELECT * FROM stream_feeds WHERE id = $1 AND guild_id = $2', [p.feedId, p.id]);
    if (!cur) throw notFound('Feed');
    const set: string[] = []; const vals: unknown[] = [p.feedId];
    const put = (col: string, v: unknown, cast = '') => { vals.push(v); set.push(`${col} = $${vals.length}${cast}`); };
    let perms: bigint | null = null;
    if (b.channelId !== undefined) { perms = await targetChannel(req.userId, p.id, b.channelId); put('channel_id', b.channelId); }
    if (b.template !== undefined) put('template', validateTemplate(b.template));
    if (b.roleId !== undefined) {
      if (b.roleId === null) { put('role_id', null); put('mention_privileged', false); }
      else { perms ??= await targetChannel(req.userId, p.id, b.channelId ?? cur.channel_id); put('mention_privileged', await checkRole(p.id, b.roleId, perms)); put('role_id', b.roleId); put('mention_by', req.userId); }
    }
    if (b.enabled !== undefined) {
      put('enabled', b.enabled);
      if (b.enabled && !cur.enabled) { set.push('next_check_at = now()', 'fail_count = 0', 'last_error = NULL', 'last_item_at = now()'); } // do not announce what happened while it was off
    }
    if (!set.length) return feedDTO(cur);
    const [row] = await ctx.db.query(`UPDATE stream_feeds SET ${set.join(', ')} WHERE id = $1 RETURNING *`, vals);
    await audit(ctx, p.id, req.userId, 'STREAM_FEED_UPDATE', p.feedId, { ...b });
    return feedDTO(row);
  });

  app.delete('/guilds/:id/stream-feeds/:feedId', async (req, reply) => {
    const p = parse(fp, req.params);
    await manager(req, p.id);
    limitOrThrow(ctx.rl, `stream-feed-edit:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const rows = await ctx.db.query('DELETE FROM stream_feeds WHERE id = $1 AND guild_id = $2 RETURNING *', [p.feedId, p.id]);
    if (!rows.length) throw notFound('Feed');
    await audit(ctx, p.id, req.userId, 'STREAM_FEED_DELETE', p.feedId, { provider: rows[0]!.provider, externalId: rows[0]!.external_id });
    return reply.code(204).send();
  });
}
