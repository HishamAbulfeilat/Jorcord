import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ALL_PERMS, LINKED_ROLE_LIMITS, Perm, has, snowflake, type LinkedCriterion, type RoleMetadataApp, type RoleMetadataField } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { CONNECTION_PROVIDERS } from '@jorcord/shared';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { forgetGuildCache, linkedRoleViews, refreshMember, refreshUserEverywhere, syncGuild, validateCriteria } from '../services/linkedroles';
import { guildAccess, guildPerms, need, needOutrank } from '../services/perms';

const op = z.enum(['>=', '<=', '=', '!=']);
const criterion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('account_age_days'), value: z.number().int() }).strict(),
  z.object({ type: z.literal('join_age_days'), value: z.number().int() }).strict(),
  z.object({ type: z.literal('message_count'), value: z.number().int() }).strict(),
  z.object({ type: z.literal('connection'), provider: z.enum(CONNECTION_PROVIDERS.map((p) => p.id) as [string, ...string[]]).optional() }).strict(),
  z.object({ type: z.literal('app_metadata'), appId: idSchema, key: z.string().regex(/^[a-z0-9_]{1,50}$/), op, value: z.union([z.number().int().min(-LINKED_ROLE_LIMITS.metadataMax).max(LINKED_ROLE_LIMITS.metadataMax), z.boolean()]) }).strict(),
]);
const criteria = z.array(criterion).min(1).max(LINKED_ROLE_LIMITS.criteria);
const description = z.string().trim().max(200).nullable();
const fieldSchema = z.object({ key: z.string().regex(/^[a-z0-9_]{1,50}$/), name: z.string().trim().min(1).max(50), description: z.string().trim().max(200).nullable().optional(), type: z.enum(['integer', 'boolean']) }).strict();

/**
 * Linked roles: a manager attaches criteria to a role; the server grants it when a member meets all of them and removes it when they stop.
 * Facts come from the server itself (account age, join age, message count, verified connections) or from an installed app's bot
 * (`PUT /applications/@me/users/:userId/role-metadata`, values the app declared with `PUT /applications/@me/role-metadata`).
 */
export function linkedRoleRoutes(app: FastifyInstance, ctx: Ctx) {
  const gid = z.object({ id: idSchema }); const lid = z.object({ id: idSchema, lid: idSchema });
  const push = (guildId: string) => { forgetGuildCache(guildId); return ctx.hub.toGuild(guildId, 'LINKED_ROLES_UPDATE', { guildId }); };
  const fail = (m: string): never => { throw badRequest(m); };
  const background = (guildId: string) => { void syncGuild(ctx, guildId, 2000).catch((e) => ctx.log.warn({ err: e }, 'linked role sync failed')); };

  app.get('/guilds/:id/linked-roles', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    return linkedRoleViews(ctx, id, req.userId);
  });

  app.post('/guilds/:id/linked-roles', async (req, reply) => {
    const { id } = parse(gid, req.params);
    const b = parse(z.object({ roleId: idSchema, description: description.optional(), criteria }).strict(), req.body);
    const gp = await guildAccess(ctx, req.userId, id); const perms = guildPerms(gp); need(perms, Perm.MANAGE_ROLES);
    limitOrThrow(ctx.rl, `linked-role:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1 AND guild_id = $2', [b.roleId, id]);
    if (!role || role.id === id) throw notFound('Role');
    if (role.managed_app_id || role.managed_kind) throw badRequest('That role is managed already');
    needOutrank(gp, role.position);
    if (!has(perms, Perm.ADMINISTRATOR) && (BigInt(role.permissions) & ~perms) !== 0n) throw forbidden('Cannot grant permissions you do not have', 'ESCALATION');
    const [n] = await ctx.db.query('SELECT count(*)::int AS c FROM linked_roles WHERE guild_id = $1', [id]);
    if (n.c >= LINKED_ROLE_LIMITS.perGuild) throw new ApiError(400, 'LIMIT_REACHED', `At most ${LINKED_ROLE_LIMITS.perGuild} linked roles`);
    await validateCriteria(ctx, id, b.criteria as LinkedCriterion[], fail);
    const lidv = snowflake();
    try { await ctx.db.query('INSERT INTO linked_roles (id, guild_id, role_id, description, criteria) VALUES ($1,$2,$3,$4,$5::jsonb)', [lidv, id, b.roleId, b.description ?? null, JSON.stringify(b.criteria)]); }
    catch (e: any) { if (e?.code === '23505' || /unique|duplicate/i.test(String(e?.message))) throw new ApiError(409, 'ALREADY_LINKED', 'That role is already a linked role'); throw e; }
    await ctx.db.query(`UPDATE roles SET managed_kind = 'linked' WHERE id = $1`, [b.roleId]);
    await audit(ctx, id, req.userId, 'LINKED_ROLE_CREATE', lidv, { roleId: b.roleId, criteria: b.criteria });
    await push(id); background(id);
    return reply.code(201).send((await linkedRoleViews(ctx, id, req.userId)).find((v) => v.id === lidv));
  });

  app.patch('/guilds/:id/linked-roles/:lid', async (req) => {
    const p = parse(lid, req.params);
    const b = parse(z.object({ description, criteria }).partial().strict(), req.body);
    need(guildPerms(await guildAccess(ctx, req.userId, p.id)), Perm.MANAGE_ROLES);
    const [row] = await ctx.db.query('SELECT l.*, r.position FROM linked_roles l JOIN roles r ON r.id = l.role_id WHERE l.id = $1 AND l.guild_id = $2', [p.lid, p.id]);
    if (!row) throw notFound('Linked role');
    needOutrank(await guildAccess(ctx, req.userId, p.id), row.position);
    if (b.criteria) await validateCriteria(ctx, p.id, b.criteria as LinkedCriterion[], fail);
    const sets: string[] = [], vals: unknown[] = [p.lid, p.id];
    if (b.description !== undefined) { vals.push(b.description || null); sets.push(`description = $${vals.length}`); }
    if (b.criteria) { vals.push(JSON.stringify(b.criteria)); sets.push(`criteria = $${vals.length}::jsonb`); }
    if (sets.length) await ctx.db.query(`UPDATE linked_roles SET ${sets.join(', ')} WHERE id = $1 AND guild_id = $2`, vals);
    await audit(ctx, p.id, req.userId, 'LINKED_ROLE_UPDATE', p.lid, b);
    await push(p.id); if (b.criteria) background(p.id);
    return (await linkedRoleViews(ctx, p.id, req.userId)).find((v) => v.id === p.lid);
  });

  /** Unlinking keeps the role and whoever holds it; it just becomes an ordinary, hand-assigned role again. */
  app.delete('/guilds/:id/linked-roles/:lid', async (req, reply) => {
    const p = parse(lid, req.params);
    const gp = await guildAccess(ctx, req.userId, p.id); need(guildPerms(gp), Perm.MANAGE_ROLES);
    const [row] = await ctx.db.query('SELECT l.*, r.position FROM linked_roles l JOIN roles r ON r.id = l.role_id WHERE l.id = $1 AND l.guild_id = $2', [p.lid, p.id]);
    if (!row) throw notFound('Linked role');
    needOutrank(gp, row.position);
    await ctx.db.query('DELETE FROM linked_roles WHERE id = $1', [p.lid]);
    await ctx.db.query(`UPDATE roles SET managed_kind = NULL WHERE id = $1 AND managed_kind = 'linked'`, [row.role_id]);
    await audit(ctx, p.id, req.userId, 'LINKED_ROLE_DELETE', p.lid, { roleId: row.role_id });
    await push(p.id);
    return reply.code(204).send();
  });

  /** "Check again": re-evaluates the caller now (after verifying a connection, for example). */
  app.post('/guilds/:id/linked-roles/refresh', async (req) => {
    const { id } = parse(gid, req.params); await guildAccess(ctx, req.userId, id);
    limitOrThrow(ctx.rl, `linked-refresh:${req.userId}`, 12, 60_000, ctx.config.rateLimit);
    await refreshMember(ctx, id, req.userId);
    return linkedRoleViews(ctx, id, req.userId);
  });

  /** Evaluate everyone (up to 5000 members). */
  app.post('/guilds/:id/linked-roles/sync', async (req) => {
    const { id } = parse(gid, req.params); need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_ROLES);
    limitOrThrow(ctx.rl, `linked-sync:${id}`, 2, 60_000, ctx.config.rateLimit);
    const r = await syncGuild(ctx, id, 5000);
    return { checked: r.checked, changed: r.changed };
  });

  /** Apps installed here that declared metadata fields (for the criteria editor). */
  app.get('/guilds/:id/linked-roles/apps', async (req): Promise<RoleMetadataApp[]> => {
    const { id } = parse(gid, req.params); need(guildPerms(await guildAccess(ctx, req.userId, id)), Perm.MANAGE_ROLES);
    const rows = await ctx.db.query(`SELECT a.id, a.name, a.icon, a.role_metadata FROM applications a JOIN application_installs i ON i.application_id = a.id WHERE i.guild_id = $1 AND jsonb_array_length(a.role_metadata) > 0 ORDER BY a.name LIMIT 50`, [id]);
    return rows.map((r) => ({ appId: r.id, name: r.name, icon: r.icon ?? null, fields: r.role_metadata as RoleMetadataField[] }));
  });

  // ---------- bot API (app-provided metadata) ----------
  const botOnly = (req: { isBot: boolean; applicationId: string | null }) => { if (!req.isBot || !req.applicationId) throw new ApiError(403, 'USER_FORBIDDEN', 'Only bots can use this endpoint').num(20002); return req.applicationId; };
  app.get('/applications/@me/role-metadata', async (req) => {
    const [a] = await ctx.db.query('SELECT role_metadata FROM applications WHERE id = $1', [botOnly(req)]);
    return a.role_metadata as RoleMetadataField[];
  });
  app.put('/applications/@me/role-metadata', async (req) => {
    const appId = botOnly(req);
    const fields = parse(z.array(fieldSchema).max(LINKED_ROLE_LIMITS.metadataKeys), req.body);
    if (new Set(fields.map((f) => f.key)).size !== fields.length) throw badRequest('Duplicate key');
    limitOrThrow(ctx.rl, `role-meta-schema:${appId}`, 10, 60_000, ctx.config.rateLimit);
    await ctx.db.query('UPDATE applications SET role_metadata = $2::jsonb WHERE id = $1', [appId, JSON.stringify(fields.map((f) => ({ ...f, description: f.description ?? null })))]);
    return fields;
  });
  const userParam = z.object({ userId: idSchema });
  /** Servers where this app is installed and the user is a member. A bot can only describe people it shares a server with. */
  const shared = async (appId: string, userId: string) => (await ctx.db.query('SELECT i.guild_id FROM application_installs i JOIN members m ON m.guild_id = i.guild_id AND m.user_id = $2 WHERE i.application_id = $1', [appId, userId])).length > 0;
  app.put('/applications/@me/users/:userId/role-metadata', async (req) => {
    const appId = botOnly(req); const { userId } = parse(userParam, req.params);
    limitOrThrow(ctx.rl, `role-meta-set:${appId}`, 300, 60_000, ctx.config.rateLimit);
    const body = parse(z.object({ values: z.record(z.string().regex(/^[a-z0-9_]{1,50}$/), z.union([z.number().int().min(-LINKED_ROLE_LIMITS.metadataMax).max(LINKED_ROLE_LIMITS.metadataMax), z.boolean()])) }).strict(), req.body);
    const [a] = await ctx.db.query('SELECT role_metadata FROM applications WHERE id = $1', [appId]); const schema = a.role_metadata as RoleMetadataField[];
    for (const [k, v] of Object.entries(body.values)) {
      const f = schema.find((x) => x.key === k); if (!f) throw badRequest(`Unknown metadata key "${k}"; declare it with PUT /applications/@me/role-metadata`);
      if (typeof v !== (f.type === 'boolean' ? 'boolean' : 'number')) throw badRequest(`"${k}" is a ${f.type}`);
    }
    if (!(await shared(appId, userId))) throw notFound('User');
    await ctx.db.query(`INSERT INTO app_user_metadata (application_id, user_id, data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (application_id, user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [appId, userId, JSON.stringify(body.values)]);
    await refreshUserEverywhere(ctx, userId, { appId });
    return { userId, values: body.values };
  });
  app.get('/applications/@me/users/:userId/role-metadata', async (req) => {
    const appId = botOnly(req); const { userId } = parse(userParam, req.params);
    const [r] = await ctx.db.query('SELECT data FROM app_user_metadata WHERE application_id = $1 AND user_id = $2', [appId, userId]);
    if (!r) throw notFound('Metadata');
    return { userId, values: r.data };
  });
  app.delete('/applications/@me/users/:userId/role-metadata', async (req, reply) => {
    const appId = botOnly(req); const { userId } = parse(userParam, req.params);
    await ctx.db.query('DELETE FROM app_user_metadata WHERE application_id = $1 AND user_id = $2', [appId, userId]);
    await refreshUserEverywhere(ctx, userId, { appId });
    return reply.code(204).send();
  });
  void ALL_PERMS;
}
