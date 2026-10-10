import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_EVERYONE, LIMITS, Perm, computePermissions, has, snowflake, snowflakeTime, type GuildInsights, type GuildWidget } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, conflict, notFound } from '../errors';
import { assetUrl, idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit, buildGuildFull } from '../services/guilds';
import { guildAccess, guildPerms, need } from '../services/perms';
import { createGuildFromTemplate, serializeGuild, templateCode, templateDTO, validTemplate } from '../services/templates';
import { publicActivities } from '../services/serializers';

const gid = z.object({ id: idSchema });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const dayStr = (d: Date) => d.toISOString().slice(0, 10);

async function widgetData(ctx: Ctx, id: string): Promise<GuildWidget | null> {
    const [g] = await ctx.db.query('SELECT id, name, widget_enabled, widget_invite_code FROM guilds WHERE id = $1', [id]);
    if (!g || !g.widget_enabled) return null;
    const [ev] = await ctx.db.query('SELECT permissions FROM roles WHERE id = $1', [id]);
    const everyone = BigInt(ev?.permissions ?? DEFAULT_EVERYONE.toString());
    const chans = await ctx.db.query(`SELECT * FROM channels WHERE guild_id = $1 AND type IN ('voice','stage') ORDER BY position, id`, [id]);
    const ows = chans.length ? await ctx.db.query(`SELECT * FROM overwrites WHERE type = 'role' AND channel_id = ANY($1::text[])`, [chans.map((c) => c.id)]) : [];
    const open = chans.filter((c) => has(computePermissions({ isOwner: false, everyoneRoleId: id, everyonePerms: everyone, memberRoleIds: [], rolePerms: {}, memberId: '', overwrites: ows.filter((o) => o.channel_id === c.id).map((o) => ({ id: o.target_id, type: 'role' as const, allow: BigInt(o.allow), deny: BigInt(o.deny) })) }), Perm.VIEW_CHANNEL));
    const rows = await ctx.db.query('SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = $1 AND u.deleted_at IS NULL ORDER BY m.joined_at LIMIT 1000', [id]);
    const online = rows.filter((u) => ctx.hub.publicPresence(u.id, u.presence) !== 'offline');
    return {
      id, name: g.name, instantInvite: g.widget_invite_code ? `${ctx.config.publicUrl.replace(/\/$/, '')}/invite/${g.widget_invite_code}` : null, presenceCount: online.length,
      channels: open.map((c) => ({ id: c.id, name: c.name ?? '', position: c.position })),
      members: online.slice(0, 100).map((u, i) => {
        const act = publicActivities(ctx, u.id, u)[0];
        return { id: String(i + 1), username: u.display_name || u.username, avatarUrl: u.avatar ? (/^https?:/.test(u.avatar) ? u.avatar : `${ctx.config.publicUrl.replace(/\/$/, '')}${u.avatar}`) : null, status: ctx.hub.publicPresence(u.id, u.presence) as 'online', ...(act ? { activity: act.name } : {}) };
      }),
    };
}
const publicHeaders = (reply: any, type: string) => reply.header('access-control-allow-origin', '*').header('cache-control', 'public, max-age=60').type(type);
/** Public, unauthenticated: only for servers that switched the widget on. */
export function widgetPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/guilds/:id/widget.json', async (req, reply) => {
    const { id } = parse(gid, req.params);
    limitOrThrow(ctx.rl, `widget:${req.ip}`, 120, 60_000, ctx.config.rateLimit);
    const w = await widgetData(ctx, id); if (!w) throw notFound('Widget');
    return publicHeaders(reply, 'application/json').send(w);
  });
  app.get('/guilds/:id/widget.svg', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const { theme } = parse(z.object({ theme: z.enum(['dark', 'light']).default('dark') }), req.query);
    limitOrThrow(ctx.rl, `widget:${req.ip}`, 120, 60_000, ctx.config.rateLimit);
    const w = await widgetData(ctx, id); if (!w) throw notFound('Widget');
    const dark = theme === 'dark'; const bg = dark ? '#2b2d31' : '#f2f3f5', fg = dark ? '#f2f3f5' : '#2b2d31', muted = dark ? '#b5bac1' : '#5c5e66';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="96" viewBox="0 0 320 96" role="img" aria-label="${esc(w.name)}">
<rect width="320" height="96" rx="12" fill="${bg}"/><circle cx="48" cy="48" r="26" fill="#5865f2"/><text x="48" y="58" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${esc([...w.name][0]?.toUpperCase() ?? '?')}</text>
<text x="88" y="42" font-family="sans-serif" font-size="18" font-weight="700" fill="${fg}">${esc(w.name.length > 22 ? w.name.slice(0, 21) + '…' : w.name)}</text>
<circle cx="94" cy="62" r="5" fill="#23a559"/><text x="106" y="67" font-family="sans-serif" font-size="14" fill="${muted}">${w.presenceCount} online</text></svg>`;
    return publicHeaders(reply, 'image/svg+xml').send(svg);
  });
}

/** Server templates, widget settings and basic insights. */
export function guildExtrasRoutes(app: FastifyInstance, ctx: Ctx) {
  const manage = async (userId: string, id: string) => { need(guildPerms(await guildAccess(ctx, userId, id)), Perm.MANAGE_GUILD); };

  // ---------- templates ----------
  const tplName = z.string().trim().min(1).max(100); const tplDesc = z.string().trim().max(120).nullable();
  app.get('/guilds/:id/templates', async (req) => {
    const { id } = parse(gid, req.params); await manage(req.userId, id);
    return Promise.all((await ctx.db.query('SELECT * FROM guild_templates WHERE guild_id = $1', [id])).map((r) => templateDTO(ctx, r, { dirty: true })));
  });
  app.post('/guilds/:id/templates', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ name: tplName, description: tplDesc.optional() }).strict(), req.body); await manage(req.userId, id);
    limitOrThrow(ctx.rl, `template:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const [have] = await ctx.db.query('SELECT 1 AS x FROM guild_templates WHERE guild_id = $1', [id]);
    if (have) throw conflict('This server already has a template', 'TEMPLATE_EXISTS');
    const code = templateCode();
    await ctx.db.query('INSERT INTO guild_templates (code, guild_id, name, description, creator_id, serialized) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [code, id, b.name, b.description ?? null, req.userId, JSON.stringify(await serializeGuild(ctx, id))]);
    await audit(ctx, id, req.userId, 'TEMPLATE_CREATE', code);
    return reply.code(201).send(await templateDTO(ctx, (await ctx.db.query('SELECT * FROM guild_templates WHERE code = $1', [code]))[0], { dirty: true }));
  });
  /** Sync: re-snapshot the server into the template. */
  app.put('/guilds/:id/templates/:code', async (req) => {
    const p = parse(z.object({ id: idSchema, code: z.string().regex(/^[A-Za-z0-9]{12}$/) }), req.params); await manage(req.userId, p.id);
    const rows = await ctx.db.query('UPDATE guild_templates SET serialized = $3::jsonb, updated_at = now() WHERE code = $1 AND guild_id = $2 RETURNING *', [p.code, p.id, JSON.stringify(await serializeGuild(ctx, p.id))]);
    if (!rows.length) throw notFound('Template');
    await audit(ctx, p.id, req.userId, 'TEMPLATE_UPDATE', p.code);
    return templateDTO(ctx, rows[0], { dirty: true });
  });
  app.patch('/guilds/:id/templates/:code', async (req) => {
    const p = parse(z.object({ id: idSchema, code: z.string().regex(/^[A-Za-z0-9]{12}$/) }), req.params);
    const b = parse(z.object({ name: tplName.optional(), description: tplDesc.optional() }).strict(), req.body); await manage(req.userId, p.id);
    const rows = await ctx.db.query('UPDATE guild_templates SET name = COALESCE($3, name), description = CASE WHEN $4::boolean THEN $5 ELSE description END, updated_at = now() WHERE code = $1 AND guild_id = $2 RETURNING *', [p.code, p.id, b.name ?? null, b.description !== undefined, b.description ?? null]);
    if (!rows.length) throw notFound('Template');
    return templateDTO(ctx, rows[0], { dirty: true });
  });
  app.delete('/guilds/:id/templates/:code', async (req, reply) => {
    const p = parse(z.object({ id: idSchema, code: z.string().regex(/^[A-Za-z0-9]{12}$/) }), req.params); await manage(req.userId, p.id);
    const rows = await ctx.db.query('DELETE FROM guild_templates WHERE code = $1 AND guild_id = $2 RETURNING code', [p.code, p.id]);
    if (!rows.length) throw notFound('Template');
    await audit(ctx, p.id, req.userId, 'TEMPLATE_DELETE', p.code);
    return reply.code(204).send();
  });
  /** Anyone signed in may look a template up by its code (that is the share link). */
  app.get('/guilds/templates/:code', async (req) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9]{12}$/) }), req.params);
    limitOrThrow(ctx.rl, `template-get:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const [r] = await ctx.db.query('SELECT * FROM guild_templates WHERE code = $1', [code]);
    if (!r) throw notFound('Template');
    return templateDTO(ctx, r, { preview: true });
  });
  app.post('/guilds/templates/:code', async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().regex(/^[A-Za-z0-9]{12}$/) }), req.params);
    const b = parse(z.object({ name: z.string().trim().min(2).max(100), icon: assetUrl.nullable().optional() }).strict(), req.body);
    limitOrThrow(ctx.rl, `guild-create:${req.userId}`, 10, 3600_000, ctx.config.rateLimit);
    if (req.isBot) throw new ApiError(403, 'BOT_FORBIDDEN', 'Bots cannot create servers');
    const [r] = await ctx.db.query('SELECT * FROM guild_templates WHERE code = $1', [code]);
    if (!r || !validTemplate(r.serialized)) throw notFound('Template');
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM members WHERE user_id = $1', [req.userId]);
    if (c.n >= LIMITS.maxServersPerUser) throw new ApiError(400, 'MAX_GUILDS', `You can be in at most ${LIMITS.maxServersPerUser} servers`);
    const id = await createGuildFromTemplate(ctx, req.userId, r.serialized, b);
    await ctx.db.query('UPDATE guild_templates SET usage_count = usage_count + 1 WHERE code = $1', [code]);
    const full = await buildGuildFull(ctx, id, req.userId);
    await ctx.hub.toUser(req.userId, 'GUILD_CREATE', full);
    return reply.code(201).send(full);
  });

  // ---------- widget ----------
  const widgetSettings = async (id: string) => {
    const [g] = await ctx.db.query('SELECT widget_enabled, widget_channel_id, widget_invite_code FROM guilds WHERE id = $1', [id]);
    return { enabled: !!g.widget_enabled, channelId: g.widget_channel_id ?? null, instantInvite: g.widget_invite_code ? `${ctx.config.publicUrl.replace(/\/$/, '')}/invite/${g.widget_invite_code}` : null };
  };
  app.get('/guilds/:id/widget', async (req) => { const { id } = parse(gid, req.params); await manage(req.userId, id); return widgetSettings(id); });
  app.patch('/guilds/:id/widget', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ enabled: z.boolean(), channelId: idSchema.nullable() }).partial().strict(), req.body); await manage(req.userId, id);
    const [g] = await ctx.db.query('SELECT owner_id, widget_channel_id, widget_invite_code FROM guilds WHERE id = $1', [id]);
    const channelId = b.channelId !== undefined ? b.channelId : g.widget_channel_id;
    if (b.channelId) { const [c] = await ctx.db.query(`SELECT 1 AS x FROM channels WHERE id = $1 AND guild_id = $2 AND type IN ('text','announcement','voice','stage','forum')`, [b.channelId, id]); if (!c) throw badRequest('Invite channel must be a channel of this server'); }
    let code: string | null = b.channelId !== undefined && b.channelId !== g.widget_channel_id ? null : g.widget_invite_code;
    if (channelId && (b.enabled ?? true) && !code) { // a permanent invite owned by the server owner backs the widget's "Join" link
      code = templateCode().slice(0, 8);
      await ctx.db.query('INSERT INTO invites (code, guild_id, channel_id, inviter_id) VALUES ($1,$2,$3,$4)', [code, id, channelId, g.owner_id]);
    }
    await ctx.db.query('UPDATE guilds SET widget_enabled = COALESCE($2, widget_enabled), widget_channel_id = $3, widget_invite_code = $4 WHERE id = $1', [id, b.enabled ?? null, channelId ?? null, channelId ? code : null]);
    await audit(ctx, id, req.userId, 'WIDGET_UPDATE', id, b);
    return widgetSettings(id);
  });

  // ---------- insights ----------
  app.get('/guilds/:id/insights', async (req) => {
    const { id } = parse(gid, req.params);
    const { days } = parse(z.object({ days: z.coerce.number().int().refine((n) => n === 7 || n === 14 || n === 30, 'days must be 7, 14 or 30').default(7) }), req.query);
    await manage(req.userId, id);
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const dayList = Array.from({ length: days }, (_, i) => new Date(today.getTime() - (days - 1 - i) * 86_400_000));
    const daily = await ctx.db.query(`SELECT to_char(day, 'YYYY-MM-DD') AS d, joins, leaves FROM guild_daily WHERE guild_id = $1 AND day >= $2::date`, [id, dayStr(dayList[0]!)]);
    const dm = new Map(daily.map((r) => [r.d as string, r]));
    const idAt = (t: number) => snowflake(t);
    const messages: GuildInsights['messages'] = [];
    for (const d of dayList) { const [r] = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE guild_id = $1 AND id >= $2 AND id < $3 AND type IN (\'default\', \'reply\')', [id, idAt(d.getTime()), idAt(d.getTime() + 86_400_000)]); messages.push({ day: dayStr(d), count: r.n }); }
    const from = idAt(dayList[0]!.getTime());
    const [chat] = await ctx.db.query(`SELECT count(DISTINCT author_id)::int AS n FROM messages WHERE guild_id = $1 AND id >= $2 AND type IN ('default', 'reply')`, [id, from]);
    const top = await ctx.db.query(`SELECT m.channel_id, c.name, count(*)::int AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.guild_id = $1 AND m.id >= $2 AND m.type IN ('default', 'reply') GROUP BY m.channel_id, c.name ORDER BY n DESC LIMIT 5`, [id, from]);
    const members = await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [id]);
    const online = [...(await ctx.presence.onlineAmong(members.map((m) => m.user_id)))].length;
    const joins = dayList.map((d) => ({ day: dayStr(d), joins: dm.get(dayStr(d))?.joins ?? 0, leaves: dm.get(dayStr(d))?.leaves ?? 0 }));
    const out: GuildInsights = {
      days, memberCount: members.length, onlineNow: online, joins, messages,
      totals: { joins: joins.reduce((a, b) => a + b.joins, 0), leaves: joins.reduce((a, b) => a + b.leaves, 0), messages: messages.reduce((a, b) => a + b.count, 0), activeChatters: chat.n },
      topChannels: top.map((r) => ({ channelId: r.channel_id, name: r.name ?? '', count: r.n })),
    };
    void snowflakeTime;
    return out;
  });
}

/** Daily join/leave counters behind the insights chart. */
export async function bumpDaily(ctx: Ctx, guildId: string, kind: 'joins' | 'leaves') {
  const col = kind === 'joins' ? 'joins' : 'leaves';
  await ctx.db.query(`INSERT INTO guild_daily (guild_id, day, ${col}) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1) ON CONFLICT (guild_id, day) DO UPDATE SET ${col} = guild_daily.${col} + 1`, [guildId]).catch((e) => ctx.log.warn({ err: e }, 'daily counter failed'));
}
