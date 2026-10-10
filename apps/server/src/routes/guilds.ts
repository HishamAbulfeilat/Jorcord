import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, Perm, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, iso, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit, buildGuildFull, createGuild, GUILD_TEMPLATES } from '../services/guilds';
import { postSystemMessage } from '../services/messages';
import { guildAccess, guildPerms, need } from '../services/perms';
import { GUILD_SELECT, guildDTO } from '../services/serializers';

const gid = z.object({ id: idSchema });
const patchGuild = z.object({
  name: z.string().trim().min(2).max(100), icon: assetUrl.nullable(), banner: assetUrl.nullable(), description: z.string().max(1000).nullable(),
  systemChannelId: idSchema.nullable(), rulesChannelId: idSchema.nullable(), discoverable: z.boolean(),
  vanityUrl: z.string().regex(/^[a-z0-9-]{3,32}$/).nullable(),
}).partial().strict();

export async function getGuildDTO(ctx: Ctx, id: string) {
  const [g] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [id]);
  return g ? guildDTO(g) : null;
}

export function guildRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/guilds', async (req, reply) => {
    const b = parse(z.object({ name: z.string().trim().min(2).max(100), icon: assetUrl.nullable().optional(), template: z.enum(Object.keys(GUILD_TEMPLATES) as [string, ...string[]]).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `guild-create:${req.userId}`, 10, 3600_000, ctx.config.rateLimit);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE user_id = $1', [req.userId]);
    if (c.n >= LIMITS.maxServersPerUser) throw new ApiError(400, 'MAX_GUILDS', `You can be in at most ${LIMITS.maxServersPerUser} servers`);
    const id = await createGuild(ctx, req.userId, b);
    const full = await buildGuildFull(ctx, id, req.userId);
    await ctx.hub.toUser(req.userId, 'GUILD_CREATE', full);
    return reply.code(201).send(full);
  });

  app.get('/guilds/:id', async (req) => {
    const { id } = parse(gid, req.params);
    await guildAccess(ctx, req.userId, id);
    return buildGuildFull(ctx, id, req.userId);
  });

  app.get('/guilds/:id/preview', async (req) => {
    const { id } = parse(gid, req.params);
    const [g] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [id]);
    if (!g) throw notFound('Guild');
    const [m] = await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [id, req.userId]);
    if (!m && !(g.features as string[]).includes('DISCOVERABLE')) throw notFound('Guild');
    const [cnt] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE guild_id = $1', [id]);
    return { id: g.id, name: g.name, icon: g.icon ?? null, banner: g.banner ?? null, description: g.description ?? null, features: g.features, approxMembers: cnt.n };
  });

  app.patch('/guilds/:id', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(patchGuild, req.body);
    const gp = await guildAccess(ctx, req.userId, id);
    need(guildPerms(gp), Perm.MANAGE_GUILD);
    for (const k of ['systemChannelId', 'rulesChannelId'] as const) {
      const v = b[k];
      if (v) { const [c] = await ctx.db.query(`SELECT 1 AS x FROM channels WHERE id = $1 AND guild_id = $2 AND type IN ('text','announcement')`, [v, id]); if (!c) throw badRequest(`${k} must be a text channel of this guild`); }
    }
    const col: Record<string, string> = { name: 'name', icon: 'icon', banner: 'banner', description: 'description', systemChannelId: 'system_channel_id', rulesChannelId: 'rules_channel_id', vanityUrl: 'vanity_url' };
    const sets: string[] = [], vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { if (!col[k]) continue; vals.push(v); sets.push(`${col[k]} = $${vals.length}`); }
    if (b.discoverable !== undefined) {
      const [g] = await ctx.db.query('SELECT features FROM guilds WHERE id = $1', [id]);
      const f = new Set<string>(g.features); b.discoverable ? f.add('DISCOVERABLE') : f.delete('DISCOVERABLE');
      vals.push(JSON.stringify([...f])); sets.push(`features = $${vals.length}::jsonb`);
    }
    try { if (sets.length) await ctx.db.query(`UPDATE guilds SET ${sets.join(', ')} WHERE id = $1`, vals); }
    catch (e: any) { if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw conflict('Vanity URL taken'); throw e; }
    await audit(ctx, id, req.userId, 'GUILD_UPDATE', id, b);
    const dto = (await getGuildDTO(ctx, id))!;
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', dto);
    return dto;
  });

  app.delete('/guilds/:id', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const gp = await guildAccess(ctx, req.userId, id);
    if (!gp.isOwner) throw forbidden('Only the owner can delete a guild');
    const members = (await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [id])).map((r) => r.user_id as string);
    await ctx.db.tx(async (q) => {
      await q.query('DELETE FROM messages WHERE guild_id = $1', [id]);
      await q.query('DELETE FROM guilds WHERE id = $1', [id]);
    });
    await ctx.pcache.invalidate({ k: 'guild', guildId: id });
    await ctx.hub.toUsers(members, 'GUILD_DELETE', { id });
    return reply.code(204).send();
  });

  app.get('/discover/guilds', async (req) => {
    const q = parse(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().optional() }), req.query);
    limitOrThrow(ctx.rl, `discover:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, '\\$&')}%` : '%';
    const rows = await ctx.db.query(
      `SELECT g.*, (SELECT count(*) FROM boosts b WHERE b.guild_id = g.id)::int AS boost_count, (SELECT count(*) FROM members m WHERE m.guild_id = g.id)::int AS approx
         FROM guilds g WHERE g.features @> '["DISCOVERABLE"]'::jsonb AND g.name ILIKE $1 ORDER BY approx DESC LIMIT $2`, [like, limitParam(q.limit, 25)]);
    return rows.map((r) => ({ ...guildDTO(r), approxMembers: r.approx }));
  });

  // ---------- boosts (free) ----------
  app.post('/guilds/:id/boosts', async (req, reply) => {
    const { id } = parse(gid, req.params);
    limitOrThrow(ctx.rl, `boost:${req.userId}`, 30, 3600_000, ctx.config.rateLimit);
    await guildAccess(ctx, req.userId, id);
    await ctx.db.query('INSERT INTO boosts (id, guild_id, user_id) VALUES ($1,$2,$3)', [snowflake(), id, req.userId]);
    const dto = (await getGuildDTO(ctx, id))!;
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', dto);
    if (dto.systemChannelId) await postSystemMessage(ctx, dto.systemChannelId, req.userId, 'boost', '').catch(() => {});
    return reply.code(201).send(dto);
  });

  // ---------- audit log ----------
  app.get('/guilds/:id/audit-logs', async (req) => {
    const { id } = parse(gid, req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), before: idSchema.optional(), action: z.string().max(64).optional(), actionType: z.coerce.number().int().min(0).max(1000).optional(), actorId: idSchema.optional() }), req.query);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.VIEW_AUDIT_LOG);
    const rows = await ctx.db.query(
      `SELECT * FROM audit_log WHERE guild_id = $1 AND ($2::text IS NULL OR id < $2) AND ($3::text IS NULL OR action = $3) AND ($4::text IS NULL OR actor_id = $4) AND ($6::int IS NULL OR action_type = $6) ORDER BY id DESC LIMIT $5`,
      [id, q.before ?? null, q.action ?? null, q.actorId ?? null, limitParam(q.limit), q.actionType ?? null]);
    return rows.map((r) => ({ id: r.id, guildId: r.guild_id, actorId: r.actor_id, action: r.action, actionType: r.action_type ?? undefined, targetId: r.target_id ?? null, changes: r.changes ?? null, reason: r.reason ?? null, createdAt: iso(r.created_at) }));
  });

  // ---------- emojis & stickers ----------
  const emojiRow = (e: any) => ({ id: e.id, guildId: e.guild_id, name: e.name, animated: e.animated, url: e.url });
  const stickerRow = (s: any) => ({ id: s.id, guildId: s.guild_id, name: s.name, url: s.url, format: s.format });
  const emojiPush = async (id: string) => ctx.hub.toGuild(id, 'EMOJIS_UPDATE', { guildId: id, emojis: (await ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1', [id])).map(emojiRow) });
  const nameSchema = z.string().regex(/^\w{2,32}$/);

  app.get('/guilds/:id/emojis', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return (await ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1 ORDER BY id', [id])).map(emojiRow);
  });
  app.post('/guilds/:id/emojis', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ name: nameSchema, url: assetUrl, animated: z.boolean().optional() }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_EMOJIS);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM emojis WHERE guild_id = $1', [id]);
    if (c.n >= LIMITS.maxEmojiPerServer) throw new ApiError(400, 'MAX_EMOJIS', 'Emoji limit reached');
    const eid = snowflake();
    await ctx.db.query('INSERT INTO emojis (id, guild_id, name, animated, url) VALUES ($1,$2,$3,$4,$5)', [eid, id, b.name, b.animated ?? false, b.url]);
    await audit(ctx, id, req.userId, 'EMOJI_CREATE', eid, b); await emojiPush(id);
    return reply.code(201).send(emojiRow((await ctx.db.query('SELECT * FROM emojis WHERE id = $1', [eid]))[0]));
  });
  app.patch('/guilds/:id/emojis/:emojiId', async (req) => {
    const p = parse(z.object({ id: idSchema, emojiId: idSchema }), req.params);
    const b = parse(z.object({ name: nameSchema }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('UPDATE emojis SET name = $3 WHERE id = $1 AND guild_id = $2 RETURNING *', [p.emojiId, p.id, b.name]);
    if (!rows.length) throw notFound('Emoji');
    await audit(ctx, p.id, req.userId, 'EMOJI_UPDATE', p.emojiId, b); await emojiPush(p.id);
    return emojiRow(rows[0]);
  });
  app.delete('/guilds/:id/emojis/:emojiId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, emojiId: idSchema }), req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('DELETE FROM emojis WHERE id = $1 AND guild_id = $2 RETURNING id', [p.emojiId, p.id]);
    if (!rows.length) throw notFound('Emoji');
    await audit(ctx, p.id, req.userId, 'EMOJI_DELETE', p.emojiId); await emojiPush(p.id);
    return reply.code(204).send();
  });

  app.get('/guilds/:id/stickers', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return (await ctx.db.query('SELECT * FROM stickers WHERE guild_id = $1 ORDER BY id', [id])).map(stickerRow);
  });
  app.post('/guilds/:id/stickers', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(30), url: assetUrl, format: z.enum(['png', 'apng', 'lottie', 'gif']).optional() }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_EMOJIS);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM stickers WHERE guild_id = $1', [id]);
    if (c.n >= LIMITS.maxStickersPerServer) throw new ApiError(400, 'MAX_STICKERS', 'Sticker limit reached');
    const sid = snowflake();
    await ctx.db.query('INSERT INTO stickers (id, guild_id, name, url, format) VALUES ($1,$2,$3,$4,$5)', [sid, id, b.name, b.url, b.format ?? 'png']);
    await audit(ctx, id, req.userId, 'STICKER_CREATE', sid, b);
    return reply.code(201).send(stickerRow((await ctx.db.query('SELECT * FROM stickers WHERE id = $1', [sid]))[0]));
  });
  app.patch('/guilds/:id/stickers/:stickerId', async (req) => {
    const p = parse(z.object({ id: idSchema, stickerId: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(30) }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('UPDATE stickers SET name = $3 WHERE id = $1 AND guild_id = $2 RETURNING *', [p.stickerId, p.id, b.name]);
    if (!rows.length) throw notFound('Sticker');
    return stickerRow(rows[0]);
  });
  app.delete('/guilds/:id/stickers/:stickerId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, stickerId: idSchema }), req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('DELETE FROM stickers WHERE id = $1 AND guild_id = $2 RETURNING id', [p.stickerId, p.id]);
    if (!rows.length) throw notFound('Sticker');
    await audit(ctx, p.id, req.userId, 'STICKER_DELETE', p.stickerId);
    return reply.code(204).send();
  });

  // ---------- automod ----------
  const ruleRow = (r: any) => ({ id: r.id, guildId: r.guild_id, name: r.name, enabled: r.enabled, trigger: r.trigger, keywords: r.keywords, action: r.action, exemptRoles: r.exempt_roles });
  const ruleBody = z.object({
    name: z.string().trim().min(1).max(100), enabled: z.boolean(), trigger: z.enum(['keyword', 'spam', 'mention_spam', 'link']),
    keywords: z.array(z.string().min(1).max(60)).max(100), action: z.enum(['block', 'timeout', 'alert']), exemptRoles: z.array(idSchema).max(20),
  }).strict();
  const checkRoles = async (guildId: string, roles: string[]) => {
    if (!roles.length) return;
    const ok = await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [guildId, roles]);
    if (ok.length !== new Set(roles).size) throw badRequest('Unknown role in exemptRoles');
  };
  app.get('/guilds/:id/automod/rules', async (req) => {
    const { id } = parse(gid, req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    return (await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 ORDER BY id', [id])).map(ruleRow);
  });
  app.post('/guilds/:id/automod/rules', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(ruleBody.partial({ enabled: true, keywords: true, exemptRoles: true }), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    await checkRoles(id, b.exemptRoles ?? []);
    const rid = snowflake();
    await ctx.db.query('INSERT INTO automod_rules (id, guild_id, name, enabled, trigger, keywords, action, exempt_roles) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',
      [rid, id, b.name, b.enabled ?? true, b.trigger, JSON.stringify(b.keywords ?? []), b.action, JSON.stringify(b.exemptRoles ?? [])]);
    await audit(ctx, id, req.userId, 'AUTOMOD_RULE_CREATE', rid, b);
    return reply.code(201).send(ruleRow((await ctx.db.query('SELECT * FROM automod_rules WHERE id = $1', [rid]))[0]));
  });
  app.patch('/guilds/:id/automod/rules/:ruleId', async (req) => {
    const p = parse(z.object({ id: idSchema, ruleId: idSchema }), req.params);
    const b = parse(ruleBody.partial(), req.body) as Record<string, any>;
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_GUILD);
    if (b.exemptRoles) await checkRoles(p.id, b.exemptRoles);
    const col: Record<string, [string, boolean]> = { name: ['name', false], enabled: ['enabled', false], trigger: ['trigger', false], keywords: ['keywords', true], action: ['action', false], exemptRoles: ['exempt_roles', true] };
    const sets: string[] = [], vals: unknown[] = [p.ruleId, p.id];
    for (const [k, v] of Object.entries(b)) { const c = col[k]; if (!c) continue; vals.push(c[1] ? JSON.stringify(v) : v); sets.push(`${c[0]} = $${vals.length}${c[1] ? '::jsonb' : ''}`); }
    const rows = sets.length ? await ctx.db.query(`UPDATE automod_rules SET ${sets.join(', ')} WHERE id = $1 AND guild_id = $2 RETURNING *`, vals)
      : await ctx.db.query('SELECT * FROM automod_rules WHERE id = $1 AND guild_id = $2', vals);
    if (!rows.length) throw notFound('Rule');
    await audit(ctx, p.id, req.userId, 'AUTOMOD_RULE_UPDATE', p.ruleId, b);
    return ruleRow(rows[0]);
  });
  app.delete('/guilds/:id/automod/rules/:ruleId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, ruleId: idSchema }), req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_GUILD);
    const rows = await ctx.db.query('DELETE FROM automod_rules WHERE id = $1 AND guild_id = $2 RETURNING id', [p.ruleId, p.id]);
    if (!rows.length) throw notFound('Rule');
    await audit(ctx, p.id, req.userId, 'AUTOMOD_RULE_DELETE', p.ruleId);
    return reply.code(204).send();
  });
}
