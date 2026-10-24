import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LIMITS, Perm, SERVER_TAG_RE, TAG_BADGE_IDS, WELCOME_SCREEN_MAX_CHANNELS, computePermissions, has, snowflake, type WelcomeScreen } from '@jorcord/shared';
import { syncGuildTag } from '../services/cosmetics';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors';
import { assetUrl, idSchema, iso, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { verifyPassword } from '../lib/crypto';
import { verifyTotp } from '../lib/totp';
import { addBoosts, boostSummary, MAX_BOOSTS_PER_REQUEST, removeBoost, slotLimits, syncBoosterRole } from '../services/boosts';
import { guildLinkLists } from '../services/linkrisk';
import { MAX_REGEX_RULES_PER_GUILD, rowActions, testRules, validateRegexPatterns } from '../services/automod';
import { deleteAttachmentFiles } from '../services/files';
import { audit, buildGuildFull, createGuild, deleteGuildCascade, GUILD_TEMPLATES, transferGuildOwnership } from '../services/guilds';
import { postSystemMessage } from '../services/messages';
import { guildAccess, guildPerms, need, needAny } from '../services/perms';
import { GUILD_SELECT, guildDTO } from '../services/serializers';

const gid = z.object({ id: idSchema });
const patchGuild = z.object({
  name: z.string().trim().min(2).max(100), icon: assetUrl.nullable(), banner: assetUrl.nullable(), description: z.string().max(1000).nullable(),
  systemChannelId: idSchema.nullable(), rulesChannelId: idSchema.nullable(), discoverable: z.boolean(), memberScreening: z.boolean(), community: z.boolean(),
  vanityUrl: z.string().regex(/^[a-z0-9-]{3,32}$/).nullable(),
  tag: z.string().regex(SERVER_TAG_RE, 'tag must be 3-4 letters or digits').nullable(), tagBadge: z.enum(TAG_BADGE_IDS).nullable(),
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
    const col: Record<string, string> = { name: 'name', icon: 'icon', banner: 'banner', description: 'description', systemChannelId: 'system_channel_id', rulesChannelId: 'rules_channel_id', vanityUrl: 'vanity_url', tag: 'tag', tagBadge: 'tag_badge' };
    const sets: string[] = [], vals: unknown[] = [id];
    for (const [k, v] of Object.entries(b)) { if (!col[k]) continue; vals.push(v); sets.push(`${col[k]} = $${vals.length}`); }
    if (b.discoverable !== undefined || b.memberScreening !== undefined || b.community !== undefined) {
      const [g] = await ctx.db.query('SELECT features, rules_channel_id, welcome_screen FROM guilds WHERE id = $1', [id]);
      const f = new Set<string>(g.features);
      if (b.discoverable !== undefined) { b.discoverable ? f.add('DISCOVERABLE') : f.delete('DISCOVERABLE'); }
      if (b.memberScreening !== undefined) {
        if (b.memberScreening && !(b.rulesChannelId ?? g.rules_channel_id)) throw badRequest('Set a rules channel before turning on membership screening');
        b.memberScreening ? f.add('MEMBER_SCREENING') : f.delete('MEMBER_SCREENING');
      }
      if (b.community !== undefined) {
        if (b.community && !(b.rulesChannelId ?? g.rules_channel_id)) throw badRequest('Set a rules channel before turning on Community');
        b.community ? f.add('COMMUNITY') : f.delete('COMMUNITY');
        // the welcome screen only exists for community servers: leaving Community switches it off (the content is kept)
        if (!b.community && g.welcome_screen?.enabled) { vals.push(JSON.stringify({ ...g.welcome_screen, enabled: false })); sets.push(`welcome_screen = $${vals.length}::jsonb`); }
      }
      vals.push(JSON.stringify([...f])); sets.push(`features = $${vals.length}::jsonb`);
    }
    try { if (sets.length) await ctx.db.query(`UPDATE guilds SET ${sets.join(', ')} WHERE id = $1`, vals); }
    catch (e: any) { if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw conflict('Vanity URL taken'); throw e; }
    await audit(ctx, id, req.userId, 'GUILD_UPDATE', id, b);
    if (b.tag !== undefined || b.tagBadge !== undefined) await syncGuildTag(ctx, id);
    const dto = (await getGuildDTO(ctx, id))!;
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', dto);
    return dto;
  });

  // ---------- welcome screen (community servers) ----------
  const welcomeBody = z.object({
    enabled: z.boolean(), description: z.string().trim().max(300).nullable(),
    channels: z.array(z.object({ channelId: idSchema, description: z.string().trim().min(1).max(50), emoji: z.string().max(64).nullable().optional() }).strict()).max(WELCOME_SCREEN_MAX_CHANNELS),
  }).partial().strict();
  /** Members of the server read it (it is also part of the guild object they receive). */
  app.get('/guilds/:id/welcome-screen', async (req) => {
    const { id } = parse(gid, req.params);
    await guildAccess(ctx, req.userId, id);
    const [g] = await ctx.db.query('SELECT features, welcome_screen FROM guilds WHERE id = $1', [id]);
    if (!g) throw notFound('Guild');
    return ((g.features as string[]).includes('COMMUNITY') ? g.welcome_screen : null) ?? { enabled: false, description: null, channels: [] };
  });
  app.patch('/guilds/:id/welcome-screen', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(welcomeBody, req.body);
    const gp = await guildAccess(ctx, req.userId, id);
    need(guildPerms(gp), Perm.MANAGE_GUILD);
    const [g] = await ctx.db.query('SELECT features, welcome_screen FROM guilds WHERE id = $1', [id]);
    if (!g) throw notFound('Guild');
    if (!(g.features as string[]).includes('COMMUNITY')) throw badRequest('The welcome screen is only available for community servers');
    const cur: WelcomeScreen = g.welcome_screen ?? { enabled: false, description: null, channels: [] };
    const next: WelcomeScreen = { enabled: b.enabled ?? cur.enabled, description: b.description !== undefined ? (b.description || null) : cur.description, channels: cur.channels };
    if (b.channels) {
      const ids = b.channels.map((c) => c.channelId);
      if (new Set(ids).size !== ids.length) throw badRequest('A channel can only be listed once');
      const rows = ids.length ? await ctx.db.query(`SELECT id, type FROM channels WHERE guild_id = $1 AND id = ANY($2::text[]) AND type NOT IN ('category','thread')`, [id, ids]) : [];
      if (rows.length !== ids.length) throw badRequest('Welcome channels must be channels of this server (no categories or threads)');
      // A welcome screen is public to every newcomer: it may only advertise channels @everyone can see.
      const [ev] = await ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [id]);
      for (const cid of ids) {
        const ow = await ctx.pcache.channelOverwrites(ctx, cid);
        const p = computePermissions({ isOwner: false, everyoneRoleId: id, everyonePerms: BigInt(ev?.permissions ?? '0'), memberRoleIds: [], rolePerms: {}, memberId: '', overwrites: ow });
        if (!has(p, Perm.VIEW_CHANNEL)) throw badRequest('Welcome channels must be visible to @everyone');
      }
      next.channels = b.channels.map((c) => ({ channelId: c.channelId, description: c.description, emoji: c.emoji ?? null }));
    }
    if (next.enabled && !next.channels.length) throw badRequest('Add at least one channel to the welcome screen');
    await ctx.db.query('UPDATE guilds SET welcome_screen = $2::jsonb WHERE id = $1', [id, JSON.stringify(next)]);
    await audit(ctx, id, req.userId, 'GUILD_UPDATE', id, { welcomeScreen: next });
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', (await getGuildDTO(ctx, id))!);
    return next;
  });

  app.delete('/guilds/:id', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const gp = await guildAccess(ctx, req.userId, id);
    if (!gp.isOwner) throw forbidden('Only the owner can delete a guild');
    await deleteGuildCascade(ctx, id);
    return reply.code(204).send();
  });

  /** Owner hands the server to another member. Re-authenticates with the password (and TOTP when enabled). */
  app.post('/guilds/:id/transfer-ownership', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ userId: idSchema, password: z.string().max(128), totp: z.string().regex(/^\d{6}$/).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `transfer-owner:${req.userId}`, 5, 15 * 60_000, ctx.config.rateLimit);
    const gp = await guildAccess(ctx, req.userId, id);
    if (!gp.isOwner) throw forbidden('Only the owner can transfer a guild');
    if (b.userId === req.userId) throw badRequest('You already own this server');
    const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (!u?.password_hash || !(await verifyPassword(u.password_hash, b.password))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    if (u.mfa_enabled && (!b.totp || !(await verifyTotp(ctx, u, b.totp)))) throw new ApiError(401, 'MFA_REQUIRED', 'A valid two-factor code is required');
    await transferGuildOwnership(ctx, id, b.userId, req.userId);
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

  // ---------- boosts (free, unlimited) ----------
  app.get('/guilds/:id/boosts', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return boostSummary(ctx, id, req.userId);
  });
  app.post('/guilds/:id/boosts', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ count: z.number().int().min(1).max(MAX_BOOSTS_PER_REQUEST).optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `boost:${req.userId}`, 30, 3600_000, ctx.config.rateLimit);
    await guildAccess(ctx, req.userId, id);
    await addBoosts(ctx, id, req.userId, b.count ?? 1);
    return reply.code(201).send((await getGuildDTO(ctx, id))!);
  });
  /** Takes back one of your boosts. */
  app.delete('/guilds/:id/boosts', async (req) => {
    const { id } = parse(gid, req.params);
    limitOrThrow(ctx.rl, `boost:${req.userId}`, 30, 3600_000, ctx.config.rateLimit);
    await guildAccess(ctx, req.userId, id);
    if (!(await removeBoost(ctx, id, req.userId))) throw notFound('Boost');
    return boostSummary(ctx, id, req.userId);
  });
  app.patch('/guilds/:id/boosts/settings', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ announce: z.boolean(), boosterRole: z.boolean() }).partial().strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    if (b.announce !== undefined) await ctx.db.query('UPDATE guilds SET boost_announce = $2 WHERE id = $1', [id, b.announce]);
    if (b.boosterRole !== undefined) { await ctx.db.query('UPDATE guilds SET booster_role_enabled = $2 WHERE id = $1', [id, b.boosterRole]); await syncBoosterRole(ctx, id); }
    await audit(ctx, id, req.userId, 'BOOST_UPDATE', id, b);
    return boostSummary(ctx, id, req.userId);
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
  const emojiRow = (e: any) => ({ id: e.id, guildId: e.guild_id, name: e.name, animated: e.animated, url: e.url, ...(e.role_ids?.length ? { roleIds: e.role_ids as string[] } : {}) });
  /** Role restriction: every id must be a role of this server (@everyone excluded). */
  const checkEmojiRoles = async (guildId: string, roleIds: string[]) => {
    const uniq = [...new Set(roleIds)];
    if (!uniq.length) return uniq;
    const rows = await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[]) AND id <> $1', [guildId, uniq]);
    if (rows.length !== uniq.length) throw badRequest('Unknown role');
    return uniq;
  };
  const stickerRow = (s: any) => ({ id: s.id, guildId: s.guild_id, name: s.name, url: s.url, format: s.format });
  const stickerPush = async (id: string) => ctx.hub.toGuild(id, 'STICKERS_UPDATE', { guildId: id, stickers: (await ctx.db.query('SELECT * FROM stickers WHERE guild_id = $1', [id])).map(stickerRow) });
  const emojiPush = async (id: string) => ctx.hub.toGuild(id, 'EMOJIS_UPDATE', { guildId: id, emojis: (await ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1', [id])).map(emojiRow) });
  const nameSchema = z.string().regex(/^\w{2,32}$/);

  app.get('/guilds/:id/emojis', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return (await ctx.db.query('SELECT * FROM emojis WHERE guild_id = $1 ORDER BY id', [id])).map(emojiRow);
  });
  app.post('/guilds/:id/emojis', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ name: nameSchema, url: assetUrl, animated: z.boolean().optional(), roleIds: z.array(idSchema).max(20).optional() }).strict(), req.body);
    needAny(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_EMOJIS, Perm.CREATE_GUILD_EXPRESSIONS);
    const roleIds = await checkEmojiRoles(id, b.roleIds ?? []);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM emojis WHERE guild_id = $1', [id]);
    const slots = await slotLimits(ctx, id);
    if (c.n >= slots.emojiSlots) throw new ApiError(400, 'MAX_EMOJIS', `Emoji limit reached (${slots.emojiSlots} at boost level ${slots.level}; boosting is free)`);
    const eid = snowflake();
    await ctx.db.query('INSERT INTO emojis (id, guild_id, name, animated, url, role_ids) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [eid, id, b.name, b.animated ?? false, b.url, JSON.stringify(roleIds)]);
    await audit(ctx, id, req.userId, 'EMOJI_CREATE', eid, b); await emojiPush(id);
    return reply.code(201).send(emojiRow((await ctx.db.query('SELECT * FROM emojis WHERE id = $1', [eid]))[0]));
  });
  app.patch('/guilds/:id/emojis/:emojiId', async (req) => {
    const p = parse(z.object({ id: idSchema, emojiId: idSchema }), req.params);
    const b = parse(z.object({ name: nameSchema.optional(), roleIds: z.array(idSchema).max(20).optional() }).strict().refine((x) => x.name !== undefined || x.roleIds !== undefined, 'Nothing to change'), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const roleIds = b.roleIds !== undefined ? await checkEmojiRoles(p.id, b.roleIds) : null;
    const rows = await ctx.db.query('UPDATE emojis SET name = COALESCE($3, name), role_ids = COALESCE($4::jsonb, role_ids) WHERE id = $1 AND guild_id = $2 RETURNING *', [p.emojiId, p.id, b.name ?? null, roleIds ? JSON.stringify(roleIds) : null]);
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
    needAny(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_EMOJIS, Perm.CREATE_GUILD_EXPRESSIONS);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM stickers WHERE guild_id = $1', [id]);
    const slots = await slotLimits(ctx, id);
    if (c.n >= slots.stickerSlots) throw new ApiError(400, 'MAX_STICKERS', `Sticker limit reached (${slots.stickerSlots} at boost level ${slots.level}; boosting is free)`);
    const sid = snowflake();
    await ctx.db.query('INSERT INTO stickers (id, guild_id, name, url, format) VALUES ($1,$2,$3,$4,$5)', [sid, id, b.name, b.url, b.format ?? 'png']);
    await audit(ctx, id, req.userId, 'STICKER_CREATE', sid, b);
    await stickerPush(id);
    return reply.code(201).send(stickerRow((await ctx.db.query('SELECT * FROM stickers WHERE id = $1', [sid]))[0]));
  });
  app.patch('/guilds/:id/stickers/:stickerId', async (req) => {
    const p = parse(z.object({ id: idSchema, stickerId: idSchema }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(30) }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('UPDATE stickers SET name = $3 WHERE id = $1 AND guild_id = $2 RETURNING *', [p.stickerId, p.id, b.name]);
    if (!rows.length) throw notFound('Sticker');
    await audit(ctx, p.id, req.userId, 'STICKER_UPDATE', p.stickerId, { name: b.name });
    await stickerPush(p.id);
    return stickerRow(rows[0]);
  });
  app.delete('/guilds/:id/stickers/:stickerId', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, stickerId: idSchema }), req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_EMOJIS);
    const rows = await ctx.db.query('DELETE FROM stickers WHERE id = $1 AND guild_id = $2 RETURNING id', [p.stickerId, p.id]);
    if (!rows.length) throw notFound('Sticker');
    await audit(ctx, p.id, req.userId, 'STICKER_DELETE', p.stickerId);
    await stickerPush(p.id);
    return reply.code(204).send();
  });

  // ---------- automod ----------
  const ruleRow = (r: any) => ({ id: r.id, guildId: r.guild_id, name: r.name, enabled: r.enabled, trigger: r.trigger, keywords: r.keywords, action: rowActions(r)[0]!, exemptRoles: r.exempt_roles,
    presets: r.presets ?? [], allowList: r.allow_list ?? [], mentionLimit: r.mention_limit ?? 5, exemptChannels: r.exempt_channels ?? [], timeoutSeconds: r.timeout_seconds ?? 60, customMessage: r.custom_message ?? null,
    actions: rowActions(r), alertChannelId: r.alert_channel_id ?? null, regexPatterns: r.regex_patterns ?? [], testMode: !!r.test_mode, options: r.options ?? {} });
  const actionEnum = z.enum(['block', 'timeout', 'alert', 'warn']);
  const ruleBody = z.object({
    name: z.string().trim().min(1).max(100), enabled: z.boolean(), trigger: z.enum(['keyword', 'keyword_preset', 'spam', 'mention_spam', 'link', 'regex', 'invite_link', 'caps', 'repeated_chars', 'suspicious_links', 'member_profile']),
    keywords: z.array(z.string().min(1).max(60)).max(100), action: actionEnum, actions: z.array(actionEnum).min(1).max(4), exemptRoles: z.array(idSchema).max(20),
    presets: z.array(z.enum(['profanity', 'sexual_content', 'slurs'])).max(3), allowList: z.array(z.string().min(1).max(60)).max(100),
    mentionLimit: z.number().int().min(1).max(50), exemptChannels: z.array(idSchema).max(50), timeoutSeconds: z.number().int().min(10).max(7 * 86400),
    customMessage: z.string().trim().max(150).nullable(), alertChannelId: idSchema.nullable(), regexPatterns: z.array(z.string().min(1).max(100)).max(3), testMode: z.boolean(),
    options: z.object({ spamCount: z.number().int().min(2).max(30), spamSeconds: z.number().int().min(2).max(60), capsPercent: z.number().int().min(50).max(100), capsMinLength: z.number().int().min(5).max(200), repeatLimit: z.number().int().min(5).max(100), linkMinScore: z.number().int().min(20).max(100) }).partial().strict(),
  }).strict();
  const checkRule = (b: { trigger?: string; presets?: string[]; regexPatterns?: string[] }, creating: boolean) => {
    if (b.trigger === 'keyword_preset' && !b.presets?.length && creating) throw badRequest('Pick at least one preset');
    if (b.trigger === 'regex' && creating && !b.regexPatterns?.length) throw badRequest('Add at least one pattern');
    if (b.regexPatterns) validateRegexPatterns(b.regexPatterns);
  };
  const checkAlertChannel = async (guildId: string, channelId: string | null | undefined) => {
    if (!channelId) return;
    const [c] = await ctx.db.query('SELECT type FROM channels WHERE id = $1 AND guild_id = $2', [channelId, guildId]);
    if (!c || (c.type !== 'text' && c.type !== 'announcement')) throw badRequest('Alert channel must be a text channel in this server');
  };
  /** `action` (single, older clients) and `actions` (list) are the same thing; the list wins. */
  const normActions = (b: Record<string, any>) => { if (b.actions) b.action = b.actions[0]; else if (b.action) b.actions = [b.action]; };
  const checkChannels = async (guildId: string, ids: string[]) => {
    if (!ids.length) return;
    const ok = await ctx.db.query('SELECT id FROM channels WHERE guild_id = $1 AND id = ANY($2::text[])', [guildId, ids]);
    if (ok.length !== new Set(ids).size) throw badRequest('Unknown channel in exemptChannels');
  };
  const checkRoles = async (guildId: string, roles: string[]) => {
    if (!roles.length) return;
    const ok = await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [guildId, roles]);
    if (ok.length !== new Set(roles).size) throw badRequest('Unknown role in exemptRoles');
  };
  app.post('/guilds/:id/automod/test', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ content: z.string().max(4000), mentionCount: z.number().int().min(0).max(100).optional() }).strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    limitOrThrow(ctx.rl, `automod-test:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    return testRules(await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 ORDER BY id', [id]), b.content, b.mentionCount ?? 0, await guildLinkLists(ctx, id));
  });
  app.get('/guilds/:id/automod/rules', async (req) => {
    const { id } = parse(gid, req.params);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    return (await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 ORDER BY id', [id])).map(ruleRow);
  });
  app.post('/guilds/:id/automod/rules', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(ruleBody.partial({ enabled: true, keywords: true, exemptRoles: true, presets: true, allowList: true, mentionLimit: true, exemptChannels: true, timeoutSeconds: true, customMessage: true, action: true, actions: true, alertChannelId: true, regexPatterns: true, testMode: true, options: true }), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_GUILD);
    normActions(b); if (!b.actions) throw badRequest('Pick at least one action');
    if (b.actions.includes('alert') && !b.alertChannelId && !b.testMode) throw badRequest('Choose an alert channel for the alert action');
    await checkRoles(id, b.exemptRoles ?? []); await checkChannels(id, b.exemptChannels ?? []); await checkAlertChannel(id, b.alertChannelId); checkRule(b, true);
    const [cnt] = await ctx.db.query('SELECT count(*)::int AS n FROM automod_rules WHERE guild_id = $1', [id]);
    if (cnt.n >= 50) throw new ApiError(400, 'LIMIT_REACHED', 'A server can have at most 50 AutoMod rules');
    if (b.trigger === 'regex') {
      const [rc] = await ctx.db.query("SELECT count(*)::int AS n FROM automod_rules WHERE guild_id = $1 AND trigger = 'regex'", [id]);
      if (rc.n >= MAX_REGEX_RULES_PER_GUILD) throw new ApiError(400, 'LIMIT_REACHED', `A server can have at most ${MAX_REGEX_RULES_PER_GUILD} regex AutoMod rules`);
    }
    const rid = snowflake();
    await ctx.db.query('INSERT INTO automod_rules (id, guild_id, name, enabled, trigger, keywords, action, exempt_roles, presets, allow_list, mention_limit, exempt_channels, timeout_seconds, custom_message, actions, alert_channel_id, regex_patterns, test_mode, options) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12::jsonb,$13,$14,$15::jsonb,$16,$17::jsonb,$18,$19::jsonb)',
      [rid, id, b.name, b.enabled ?? true, b.trigger, JSON.stringify(b.keywords ?? []), b.action, JSON.stringify(b.exemptRoles ?? []), JSON.stringify(b.presets ?? []), JSON.stringify(b.allowList ?? []), b.mentionLimit ?? 5, JSON.stringify(b.exemptChannels ?? []), b.timeoutSeconds ?? 60, b.customMessage ?? null,
        JSON.stringify(b.actions), b.alertChannelId ?? null, JSON.stringify(b.regexPatterns ?? []), b.testMode ?? false, JSON.stringify(b.options ?? {})]);
    await audit(ctx, id, req.userId, 'AUTOMOD_RULE_CREATE', rid, b);
    return reply.code(201).send(ruleRow((await ctx.db.query('SELECT * FROM automod_rules WHERE id = $1', [rid]))[0]));
  });
  app.patch('/guilds/:id/automod/rules/:ruleId', async (req) => {
    const p = parse(z.object({ id: idSchema, ruleId: idSchema }), req.params);
    const b = parse(ruleBody.partial(), req.body) as Record<string, any>;
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_GUILD);
    if (b.exemptRoles) await checkRoles(p.id, b.exemptRoles);
    if (b.exemptChannels) await checkChannels(p.id, b.exemptChannels);
    await checkAlertChannel(p.id, b.alertChannelId); checkRule(b, false); normActions(b);
    const col: Record<string, [string, boolean]> = { name: ['name', false], enabled: ['enabled', false], trigger: ['trigger', false], keywords: ['keywords', true], action: ['action', false], exemptRoles: ['exempt_roles', true],
      presets: ['presets', true], allowList: ['allow_list', true], mentionLimit: ['mention_limit', false], exemptChannels: ['exempt_channels', true], timeoutSeconds: ['timeout_seconds', false], customMessage: ['custom_message', false],
      actions: ['actions', true], alertChannelId: ['alert_channel_id', false], regexPatterns: ['regex_patterns', true], testMode: ['test_mode', false], options: ['options', true] };
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
