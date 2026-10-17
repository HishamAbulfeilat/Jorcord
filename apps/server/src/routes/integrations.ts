import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMS, Perm, has, type GuildIntegration } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { uninstallBot } from '../services/apps';
import { audit } from '../services/guilds';
import { guildAccess, guildPerms, need } from '../services/perms';
import { roleDTO } from '../services/serializers';
import { removeMemberFromGuild } from './members';

const p2 = z.object({ id: idSchema, appId: idSchema });
const ROWS = `SELECT i.application_id, i.scopes, i.installed_by, i.role_id, i.created_at, a.name, a.description, a.icon, a.bot_user_id, a.system_key, r.permissions
  FROM application_installs i JOIN applications a ON a.id = i.application_id LEFT JOIN roles r ON r.id = i.role_id AND r.guild_id = i.guild_id WHERE i.guild_id = $1`;
const dto = (r: any): GuildIntegration => ({
  applicationId: r.application_id, name: r.name, description: r.description ?? '', icon: r.icon ?? null, botUserId: r.bot_user_id, official: !!r.system_key, scopes: r.scopes ?? [],
  roleId: r.role_id ?? null, permissions: r.permissions ?? '0', installedBy: r.installed_by, installedAt: iso(r.created_at)!,
});

/** Server Settings > Bots & Apps: the apps installed in a server, with their permissions and a way to remove them. Needs Manage Server. */
export function integrationRoutes(app: FastifyInstance, ctx: Ctx) {
  const manager = async (req: { userId: string; isBot: boolean }, guildId: string) => {
    if (req.isBot) throw forbidden('Bots cannot manage integrations', 'BOT_FORBIDDEN');
    const perms = guildPerms(await guildAccess(ctx, req.userId, guildId));
    need(perms, Perm.MANAGE_GUILD);
    return perms;
  };

  app.get('/guilds/:id/integrations', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    await manager(req, id);
    return (await ctx.db.query(`${ROWS} ORDER BY i.created_at, i.application_id`, [id])).map(dto);
  });

  /** Changes the permissions of the app's managed role. You can only hand out what you hold yourself. */
  app.patch('/guilds/:id/integrations/:appId', async (req) => {
    const p = parse(p2, req.params);
    const b = parse(z.object({ permissions: z.string().regex(/^\d{1,20}$/) }).strict(), req.body);
    const perms = await manager(req, p.id);
    limitOrThrow(ctx.rl, `integration-edit:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const [row] = await ctx.db.query(`${ROWS} AND i.application_id = $2`, [p.id, p.appId]);
    if (!row) throw notFound('Application');
    if (!row.role_id) throw badRequest('This app has no bot role in the server');
    const bits = BigInt(b.permissions) & ALL_PERMS;
    if (!has(perms, Perm.ADMINISTRATOR) && (bits & ~perms) !== 0n) throw forbidden('You cannot grant permissions you do not have', 'PERMISSION_ESCALATION');
    await ctx.db.query('UPDATE roles SET permissions = $2 WHERE id = $1 AND guild_id = $3', [row.role_id, bits.toString(), p.id]);
    await ctx.pcache.invalidate({ k: 'guild', guildId: p.id });
    await audit(ctx, p.id, req.userId, 'ROLE_UPDATE', row.role_id, { permissions: bits.toString(), applicationId: p.appId });
    const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [row.role_id]);
    await ctx.hub.toGuild(p.id, 'ROLE_UPDATE', roleDTO(role));
    const [fresh] = await ctx.db.query(`${ROWS} AND i.application_id = $2`, [p.id, p.appId]);
    return dto(fresh);
  });

  /** Removes the app: kicks its bot user (member, managed role and install record go with it). */
  app.delete('/guilds/:id/integrations/:appId', async (req, reply) => {
    const p = parse(p2, req.params);
    await manager(req, p.id);
    limitOrThrow(ctx.rl, `integration-edit:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const [row] = await ctx.db.query(`${ROWS} AND i.application_id = $2`, [p.id, p.appId]);
    if (!row) throw notFound('Application');
    const [member] = await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [p.id, row.bot_user_id]);
    if (member) await removeMemberFromGuild(ctx, p.id, row.bot_user_id);
    await uninstallBot(ctx, p.id, row.bot_user_id); // also covers installs that only added slash commands
    await audit(ctx, p.id, req.userId, 'BOT_REMOVE', row.bot_user_id, { applicationId: p.appId });
    return reply.code(204).send();
  });
}
