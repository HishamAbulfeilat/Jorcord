import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, snowflake, type CommandPermissionOverwrite } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { COMMAND_LIMITS, parseCommand, type ParsedCommand } from '../lib/commands';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { getApplication, isInstalled } from '../services/apps';
import { commandDTO, listUsableCommands } from '../services/commands';
import { audit } from '../services/guilds';
import { guildAccess, guildPerms, need } from '../services/perms';

const appParams = z.object({ app: idSchema });
const guildParams = appParams.extend({ gid: idSchema });
const permEntry = z.object({ id: idSchema, type: z.union([z.literal(1), z.literal(2), z.literal(3)]), permission: z.boolean() }).strict();

export function commandRoutes(app: FastifyInstance, ctx: Ctx) {
  /** The application's own bot token, or the owning user's session, may manage its commands. Anyone else sees a 404. */
  async function manage(req: { userId: string; isBot: boolean; applicationId: string | null }, appId: string) {
    const row = await getApplication(ctx, appId);
    const ok = row && (req.isBot ? req.applicationId === appId : row.owner_id === req.userId);
    if (!row || !ok) throw notFound('Application');
    return row;
  }
  async function scopeOf(row: any, gid: string | null) {
    if (gid && !(await isInstalled(ctx, row.id, gid))) throw forbidden('The application is not installed in this server', 'MISSING_ACCESS').num(50001);
    return { guildId: gid, key: gid ?? '' };
  }
  const emit = async (name: 'APPLICATION_COMMAND_CREATE' | 'APPLICATION_COMMAND_UPDATE' | 'APPLICATION_COMMAND_DELETE', row: any) => {
    if (row.guild_id) await ctx.hub.toGuild(row.guild_id, name, commandDTO(row)); // global commands are fetched on demand, not broadcast
  };

  async function upsert(q: Pick<Ctx['db'], 'query'>, appId: string, scope: { guildId: string | null; key: string }, c: ParsedCommand, enforceLimit = true) {
    const [existing] = await q.query('SELECT * FROM application_commands WHERE application_id = $1 AND scope_key = $2 AND type = $3 AND name = $4', [appId, scope.key, c.type, c.name]);
    if (!existing && enforceLimit) {
      const [n] = await q.query('SELECT count(*)::int AS n FROM application_commands WHERE application_id = $1 AND scope_key = $2 AND type = $3', [appId, scope.key, c.type]);
      if (n.n >= (COMMAND_LIMITS[c.type] ?? 15)) throw new ApiError(400, 'MAX_COMMANDS', 'Maximum number of application commands reached').num(30032);
    }
    const version = snowflake();
    const vals = [c.description, JSON.stringify(c.options), c.defaultMemberPermissions, c.dmPermission && !scope.guildId, c.nsfw, version];
    if (existing) {
      const [r] = await q.query('UPDATE application_commands SET description=$2, options=$3::jsonb, default_member_permissions=$4, dm_permission=$5, nsfw=$6, version=$7 WHERE id=$1 RETURNING *', [existing.id, ...vals]);
      return { row: r, created: false };
    }
    const id = snowflake();
    const [r] = await q.query(
      `INSERT INTO application_commands (id, application_id, guild_id, scope_key, type, name, description, options, default_member_permissions, dm_permission, nsfw, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) RETURNING *`, [id, appId, scope.guildId, scope.key, c.type, c.name, ...vals]);
    return { row: r, created: true };
  }

  // Both the global and the guild variant share these handlers; `gid` is undefined for global.
  for (const base of ['/applications/:app', '/applications/:app/guilds/:gid']) {
    const gidOf = (req: any) => (base.includes(':gid') ? parse(guildParams, req.params).gid : (parse(appParams, req.params), null));
    app.get(`${base}/commands`, async (req) => {
      const row = await manage(req, parse(appParams, req.params).app); const sc = await scopeOf(row, gidOf(req));
      return (await ctx.db.query('SELECT * FROM application_commands WHERE application_id = $1 AND scope_key = $2 ORDER BY type, name', [row.id, sc.key])).map(commandDTO);
    });
    app.post(`${base}/commands`, async (req, reply) => {
      const row = await manage(req, parse(appParams, req.params).app); const sc = await scopeOf(row, gidOf(req));
      const c = parseCommand(req.body);
      limitOrThrow(ctx.rl, `cmd-create:${row.id}:${sc.key}`, 200, 86400_000, ctx.config.rateLimit); // Discord documents 200 creates/day/guild
      const { row: r, created } = await upsert(ctx.db, row.id, sc, c);
      await emit(created ? 'APPLICATION_COMMAND_CREATE' : 'APPLICATION_COMMAND_UPDATE', r);
      return reply.code(created ? 201 : 200).send(commandDTO(r));
    });
    app.get(`${base}/commands/:cid`, async (req) => {
      const p = parse(appParams.extend({ cid: idSchema }), req.params);
      const row = await manage(req, p.app); const sc = await scopeOf(row, gidOf(req));
      const [r] = await ctx.db.query('SELECT * FROM application_commands WHERE id = $1 AND application_id = $2 AND scope_key = $3', [p.cid, row.id, sc.key]);
      if (!r) throw notFound('Command');
      return commandDTO(r);
    });
    app.patch(`${base}/commands/:cid`, async (req) => {
      const p = parse(appParams.extend({ cid: idSchema }), req.params);
      const row = await manage(req, p.app); const sc = await scopeOf(row, gidOf(req));
      const [cur] = await ctx.db.query('SELECT * FROM application_commands WHERE id = $1 AND application_id = $2 AND scope_key = $3', [p.cid, row.id, sc.key]);
      if (!cur) throw notFound('Command');
      const b = (req.body ?? {}) as Record<string, any>;
      const merged = parseCommand({
        type: cur.type, name: b.name ?? cur.name, description: b.description ?? cur.description, options: b.options ?? cur.options,
        defaultMemberPermissions: b.defaultMemberPermissions !== undefined ? b.defaultMemberPermissions : cur.default_member_permissions, dmPermission: b.dmPermission ?? cur.dm_permission, nsfw: b.nsfw ?? cur.nsfw,
      });
      const bodyKeys = Object.keys(b).filter((k) => !['name', 'description', 'options', 'defaultMemberPermissions', 'dmPermission', 'nsfw'].includes(k));
      if (bodyKeys.length) throw badRequest(`Unknown field ${bodyKeys[0]}`);
      const [dup] = merged.name !== cur.name ? await ctx.db.query('SELECT 1 AS x FROM application_commands WHERE application_id = $1 AND scope_key = $2 AND type = $3 AND name = $4', [row.id, sc.key, cur.type, merged.name]) : [];
      if (dup) throw new ApiError(409, 'CONFLICT', 'A command with that name already exists');
      const [r] = await ctx.db.query(
        'UPDATE application_commands SET name=$2, description=$3, options=$4::jsonb, default_member_permissions=$5, dm_permission=$6, nsfw=$7, version=$8 WHERE id=$1 RETURNING *',
        [p.cid, merged.name, merged.description, JSON.stringify(merged.options), merged.defaultMemberPermissions, merged.dmPermission && !sc.guildId, merged.nsfw, snowflake()]);
      await emit('APPLICATION_COMMAND_UPDATE', r);
      return commandDTO(r);
    });
    app.delete(`${base}/commands/:cid`, async (req, reply) => {
      const p = parse(appParams.extend({ cid: idSchema }), req.params);
      const row = await manage(req, p.app); const sc = await scopeOf(row, gidOf(req));
      const [r] = await ctx.db.query('DELETE FROM application_commands WHERE id = $1 AND application_id = $2 AND scope_key = $3 RETURNING *', [p.cid, row.id, sc.key]);
      if (!r) throw notFound('Command');
      await ctx.db.query('DELETE FROM command_permissions WHERE application_id = $1 AND command_id = $2', [row.id, p.cid]);
      await emit('APPLICATION_COMMAND_DELETE', r);
      return reply.code(204).send();
    });
    /** Bulk overwrite: the list becomes the complete command set for this scope. */
    app.put(`${base}/commands`, async (req) => {
      const row = await manage(req, parse(appParams, req.params).app); const sc = await scopeOf(row, gidOf(req));
      if (!Array.isArray(req.body) || req.body.length > 200) throw badRequest('Body must be an array of at most 200 commands');
      limitOrThrow(ctx.rl, `cmd-bulk:${row.id}:${sc.key}`, 20, 3600_000, ctx.config.rateLimit);
      const parsed = req.body.map(parseCommand);
      const keys = parsed.map((c) => `${c.type}:${c.name}`);
      if (new Set(keys).size !== keys.length) throw badRequest('Duplicate command type/name');
      for (const t of [1, 2, 3]) if (parsed.filter((c) => c.type === t).length > (COMMAND_LIMITS[t] ?? 15)) throw new ApiError(400, 'MAX_COMMANDS', 'Maximum number of application commands reached').num(30032);
      const before = await ctx.db.query('SELECT * FROM application_commands WHERE application_id = $1 AND scope_key = $2', [row.id, sc.key]);
      const results = await ctx.db.tx(async (q) => {
        const out: { row: any; created: boolean }[] = [];
        for (const c of parsed) out.push(await upsert(q, row.id, sc, c, false));
        const keep = out.map((o) => o.row.id as string);
        await q.query('DELETE FROM application_commands WHERE application_id = $1 AND scope_key = $2 AND NOT (id = ANY($3::text[]))', [row.id, sc.key, keep]);
        return out;
      });
      const kept = new Set(results.map((o) => o.row.id));
      for (const o of results) await emit(o.created ? 'APPLICATION_COMMAND_CREATE' : 'APPLICATION_COMMAND_UPDATE', o.row);
      for (const old of before) if (!kept.has(old.id)) await emit('APPLICATION_COMMAND_DELETE', old);
      if (before.length) await ctx.db.query('DELETE FROM command_permissions WHERE application_id = $1 AND command_id = ANY($2::text[]) AND NOT (command_id = ANY($3::text[]))', [row.id, before.map((b) => b.id), [...kept]]);
      return results.map((o) => commandDTO(o.row));
    });
  }

  // ---------- command permissions (guild managers, user sessions only) ----------
  async function permManager(req: { userId: string; isBot: boolean }, p: { app: string; gid: string }) {
    if (req.isBot) throw new ApiError(403, 'BOT_FORBIDDEN', 'Bots cannot use this endpoint').num(20001);
    const row = await getApplication(ctx, p.app);
    if (!row || !(await isInstalled(ctx, p.app, p.gid))) throw notFound('Application');
    need(guildPerms(await guildAccess(ctx, req.userId, p.gid)), Perm.MANAGE_GUILD, Perm.MANAGE_ROLES);
    return row;
  }
  const permDTO = (rows: any[]): CommandPermissionOverwrite[] => rows.map((r) => ({ id: r.target_id, type: r.target_type, permission: r.permission }));
  app.get('/applications/:app/guilds/:gid/commands/permissions', async (req) => {
    const p = parse(guildParams, req.params); await permManager(req, p);
    const rows = await ctx.db.query('SELECT * FROM command_permissions WHERE application_id = $1 AND guild_id = $2 ORDER BY command_id', [p.app, p.gid]);
    const by = new Map<string, any[]>(); for (const r of rows) by.set(r.command_id, [...(by.get(r.command_id) ?? []), r]);
    return [...by].map(([commandId, rs]) => ({ commandId, applicationId: p.app, guildId: p.gid, permissions: permDTO(rs) }));
  });
  app.get('/applications/:app/guilds/:gid/commands/:cid/permissions', async (req) => {
    const p = parse(guildParams.extend({ cid: idSchema }), req.params); await permManager(req, p);
    const rows = await ctx.db.query('SELECT * FROM command_permissions WHERE application_id = $1 AND guild_id = $2 AND command_id = $3', [p.app, p.gid, p.cid]);
    return { commandId: p.cid, applicationId: p.app, guildId: p.gid, permissions: permDTO(rows) };
  });
  /** `cid` may be the application id itself to set the application-wide default overwrites. */
  app.put('/applications/:app/guilds/:gid/commands/:cid/permissions', async (req) => {
    const p = parse(guildParams.extend({ cid: idSchema }), req.params); await permManager(req, p);
    const b = parse(z.object({ permissions: z.array(permEntry).max(100) }).strict(), req.body);
    if (p.cid !== p.app) { const [c] = await ctx.db.query('SELECT 1 AS x FROM application_commands WHERE id = $1 AND application_id = $2 AND (guild_id IS NULL OR guild_id = $3)', [p.cid, p.app, p.gid]); if (!c) throw notFound('Command'); }
    const dupe = new Set(b.permissions.map((e) => `${e.type}:${e.id}`));
    if (dupe.size !== b.permissions.length) throw badRequest('Duplicate permission target');
    for (const e of b.permissions) { // targets must belong to this guild
      const ok = e.type === 1 ? (await ctx.db.query('SELECT 1 AS x FROM roles WHERE id = $1 AND guild_id = $2', [e.id, p.gid]))[0]
        : e.type === 2 ? (await ctx.db.query('SELECT 1 AS x FROM members WHERE user_id = $1 AND guild_id = $2', [e.id, p.gid]))[0]
        : (await ctx.db.query('SELECT 1 AS x FROM channels WHERE id = $1 AND guild_id = $2', [e.id, p.gid]))[0];
      if (!ok) throw badRequest('Permission target not found in this server', { id: e.id });
    }
    await ctx.db.tx(async (q) => {
      await q.query('DELETE FROM command_permissions WHERE application_id = $1 AND guild_id = $2 AND command_id = $3', [p.app, p.gid, p.cid]);
      for (const e of b.permissions) await q.query('INSERT INTO command_permissions (application_id, guild_id, command_id, target_id, target_type, permission) VALUES ($1,$2,$3,$4,$5,$6)', [p.app, p.gid, p.cid, e.id, e.type, e.permission]);
    });
    await audit(ctx, p.gid, req.userId, 'APPLICATION_COMMAND_PERMISSION_UPDATE', p.cid, { applicationId: p.app, permissions: b.permissions });
    return { commandId: p.cid, applicationId: p.app, guildId: p.gid, permissions: b.permissions };
  });

  /** What the composer shows: every command the caller may run here (global + guild, installed apps only, permissions applied). */
  app.get('/guilds/:id/application-commands', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const q = parse(z.object({ channelId: idSchema.optional() }), req.query);
    return listUsableCommands(ctx, id, req.userId, q.channelId);
  });
}
