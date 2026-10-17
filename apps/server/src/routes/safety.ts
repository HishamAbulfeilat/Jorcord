import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { idSchema, parse } from '../lib/ids';
import { audit } from '../services/guilds';
import { guildAccess, guildPerms, need } from '../services/perms';
import { SAFETY_PRESETS, normalizeRaid, safetyDTO } from '../services/safety';
import { GUILD_SELECT, guildDTO } from '../services/serializers';

const patchSafety = z.object({
  verificationLevel: z.number().int().min(0).max(4), explicitFilter: z.number().int().min(0).max(2), defaultNotifications: z.enum(['all', 'mentions']),
  raidProtection: z.object({ enabled: z.boolean(), maxJoins: z.number().int().min(3).max(100), windowSeconds: z.number().int().min(10).max(600), lockMinutes: z.number().int().min(5).max(1440) }).partial().strict(),
  /** true pauses invites/joins for 24 h, false resumes them */ pauseInvites: z.boolean(),
}).partial().strict();

/** Safety Setup: verification level, explicit-media filter, default notifications, raid protection and the invite pause. All MANAGE_GUILD. */
export function safetyRoutes(app: FastifyInstance, ctx: Ctx) {
  const gid = z.object({ id: idSchema });
  const load = async (id: string) => (await ctx.db.query('SELECT * FROM guilds WHERE id = $1', [id]))[0];
  const apply = async (id: string, actor: string, b: z.infer<typeof patchSafety>) => {
    const cur = await load(id);
    const sets: string[] = []; const vals: unknown[] = [id];
    const set = (col: string, v: unknown, cast = '') => { vals.push(v); sets.push(`${col} = $${vals.length}${cast}`); };
    if (b.verificationLevel !== undefined) set('verification_level', b.verificationLevel);
    if (b.explicitFilter !== undefined) set('explicit_filter', b.explicitFilter);
    if (b.defaultNotifications !== undefined) set('default_notifications', b.defaultNotifications);
    if (b.raidProtection) set('raid_protection', JSON.stringify(normalizeRaid({ ...normalizeRaid(cur.raid_protection), ...b.raidProtection })), '::jsonb');
    if (b.pauseInvites !== undefined) set('invites_paused_until', b.pauseInvites ? new Date(Date.now() + 86_400_000) : null);
    if (!sets.length) return;
    await ctx.db.query(`UPDATE guilds SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(ctx, id, actor, 'SAFETY_UPDATE', id, b);
    const [fresh] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [id]);
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', guildDTO(fresh));
  };
  const gate = async (userId: string, id: string) => { need(guildPerms(await guildAccess(ctx, userId, id)), Perm.MANAGE_GUILD); };

  app.get('/guilds/:id/safety', async (req) => { const { id } = parse(gid, req.params); await gate(req.userId, id); return safetyDTO(await load(id)); });
  app.patch('/guilds/:id/safety', async (req) => {
    const { id } = parse(gid, req.params); const b = parse(patchSafety, req.body); await gate(req.userId, id);
    await apply(id, req.userId, b); return safetyDTO(await load(id));
  });
  /** One click: apply a preset (basic | recommended | strict). Does not touch an active invite pause. */
  app.post('/guilds/:id/safety/preset', async (req) => {
    const { id } = parse(gid, req.params); const { preset } = parse(z.object({ preset: z.enum(['basic', 'recommended', 'strict']) }).strict(), req.body); await gate(req.userId, id);
    await apply(id, req.userId, SAFETY_PRESETS[preset] as any); return safetyDTO(await load(id));
  });
}
