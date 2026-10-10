import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ONBOARDING_LIMITS, Perm, has, snowflake, type Onboarding, type OnboardingPrompt } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit, visibleChannelRows } from '../services/guilds';
import { guildAccess, guildPerms, need, needOutrank } from '../services/perms';
import { GUILD_SELECT, guildDTO, memberDTO } from '../services/serializers';
import { trackVisibility } from '../services/visibility';

const optionSchema = z.object({
  id: idSchema.optional(), title: z.string().trim().min(1).max(50), description: z.string().trim().max(100).nullable().optional(), emoji: z.string().max(64).nullable().optional(),
  channelIds: z.array(idSchema).max(25).default([]), roleIds: z.array(idSchema).max(10).default([]),
}).strict();
const promptSchema = z.object({
  id: idSchema.optional(), title: z.string().trim().min(1).max(100), singleSelect: z.boolean().default(false), required: z.boolean().default(false),
  options: z.array(optionSchema).min(1).max(ONBOARDING_LIMITS.optionsPerPrompt),
}).strict();
const putOnboarding = z.object({ enabled: z.boolean(), defaultChannelIds: z.array(idSchema).max(50), prompts: z.array(promptSchema).max(ONBOARDING_LIMITS.prompts) }).partial().strict();

/** Server onboarding: managers define questions whose answers grant roles and opt members into channels; members answer once (and may redo it). */
export function onboardingRoutes(app: FastifyInstance, ctx: Ctx) {
  const gid = z.object({ id: idSchema });
  const prompts = async (guildId: string): Promise<OnboardingPrompt[]> =>
    (await ctx.db.query('SELECT * FROM onboarding_prompts WHERE guild_id = $1 ORDER BY position, id', [guildId])).map((r) => ({ id: r.id, title: r.title, singleSelect: r.single_select, required: r.required, options: r.options }));

  app.get('/guilds/:id/onboarding', async (req) => {
    const { id } = parse(gid, req.params);
    const gp = await guildAccess(ctx, req.userId, id);
    const manager = has(guildPerms(gp), Perm.MANAGE_GUILD);
    const [g] = await ctx.db.query('SELECT features, default_channel_ids FROM guilds WHERE id = $1', [id]);
    let list = await prompts(id); let defaults: string[] = g.default_channel_ids ?? [];
    if (!manager) { // never leak ids of channels the member cannot see
      const visible = new Set((await visibleChannelRows(ctx, id, req.userId)).map((c) => c.id as string));
      list = list.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o, channelIds: o.channelIds.filter((c) => visible.has(c)) })) }));
      defaults = defaults.filter((c) => visible.has(c));
    }
    const [r] = await ctx.db.query('SELECT * FROM member_onboarding WHERE guild_id = $1 AND user_id = $2', [id, req.userId]);
    const out: Onboarding = { enabled: (g.features as string[]).includes('ONBOARDING'), defaultChannelIds: defaults, prompts: list,
      responses: r ? { optionIds: r.option_ids, channelIds: r.channel_ids, completedAt: iso(r.completed_at)! } : null };
    return out;
  });

  app.put('/guilds/:id/onboarding', async (req) => {
    const { id } = parse(gid, req.params);
    const b = parse(putOnboarding, req.body);
    const actor = await guildAccess(ctx, req.userId, id); const perms = guildPerms(actor);
    need(perms, Perm.MANAGE_GUILD);
    limitOrThrow(ctx.rl, `onboarding:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    if (b.prompts || b.defaultChannelIds) {
      const channels = new Map((await ctx.db.query('SELECT id, type FROM channels WHERE guild_id = $1', [id])).map((c) => [c.id as string, c.type as string]));
      for (const c of [...(b.defaultChannelIds ?? []), ...(b.prompts ?? []).flatMap((p) => p.options.flatMap((o) => o.channelIds))]) if (!channels.has(c) || channels.get(c) === 'category' || channels.get(c) === 'thread') throw badRequest('Unknown or unsupported channel in onboarding');
      const roleIds = [...new Set((b.prompts ?? []).flatMap((p) => p.options.flatMap((o) => o.roleIds)))];
      if (roleIds.length) {
        const roles = await ctx.db.query('SELECT id, position, permissions, managed_app_id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [id, roleIds]);
        if (roles.length !== roleIds.length || roleIds.includes(id)) throw badRequest('Unknown role in onboarding');
        need(perms, Perm.MANAGE_ROLES);
        for (const r of roles) {
          if (r.managed_app_id) throw badRequest('Bot roles cannot be handed out');
          needOutrank(actor, r.position);
          if (!has(perms, Perm.ADMINISTRATOR) && (BigInt(r.permissions) & ~perms) !== 0n) throw new ApiError(403, 'ESCALATION', 'Cannot hand out permissions you do not have');
        }
      }
    }
    if (b.prompts) {
      const existing = new Set((await prompts(id)).map((p) => p.id));
      await ctx.db.tx(async (q) => {
        await q.query('DELETE FROM onboarding_prompts WHERE guild_id = $1', [id]);
        let pos = 0;
        for (const p of b.prompts!) {
          const pid = p.id && existing.has(p.id) ? p.id : snowflake();
          const options = p.options.map((o) => ({ id: o.id ?? snowflake(), title: o.title, description: o.description ?? null, emoji: o.emoji ?? null, channelIds: [...new Set(o.channelIds)], roleIds: [...new Set(o.roleIds)] }));
          await q.query('INSERT INTO onboarding_prompts (id, guild_id, title, single_select, required, position, options) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)', [pid, id, p.title, p.singleSelect, p.required, pos++, JSON.stringify(options)]);
        }
      });
    }
    const sets: string[] = []; const vals: unknown[] = [id];
    if (b.defaultChannelIds) { vals.push(JSON.stringify([...new Set(b.defaultChannelIds)])); sets.push(`default_channel_ids = $${vals.length}::jsonb`); }
    if (b.enabled !== undefined) {
      const [g] = await ctx.db.query('SELECT features FROM guilds WHERE id = $1', [id]);
      const f = new Set<string>(g.features); b.enabled ? f.add('ONBOARDING') : f.delete('ONBOARDING');
      vals.push(JSON.stringify([...f])); sets.push(`features = $${vals.length}::jsonb`);
    }
    if (sets.length) await ctx.db.query(`UPDATE guilds SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(ctx, id, req.userId, 'ONBOARDING_UPDATE', id, { enabled: b.enabled, prompts: b.prompts?.length });
    const [fresh] = await ctx.db.query(`${GUILD_SELECT} WHERE g.id = $1`, [id]);
    await ctx.hub.toGuild(id, 'GUILD_UPDATE', guildDTO(fresh));
    const [g] = await ctx.db.query('SELECT features, default_channel_ids FROM guilds WHERE id = $1', [id]);
    return { enabled: (g.features as string[]).includes('ONBOARDING'), defaultChannelIds: g.default_channel_ids, prompts: await prompts(id) } satisfies Onboarding;
  });

  /** Answer the questions: replaces my previous answers, grants/removes the option roles and records the channels I opted into. */
  app.put('/guilds/:id/onboarding/responses', async (req) => {
    const { id } = parse(gid, req.params);
    const { optionIds } = parse(z.object({ optionIds: z.array(idSchema).max(60) }).strict(), req.body);
    const gp = await guildAccess(ctx, req.userId, id);
    limitOrThrow(ctx.rl, `onboarding-answer:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    const list = await prompts(id); const chosen = new Set(optionIds);
    const known = new Set(list.flatMap((p) => p.options.map((o) => o.id)));
    if ([...chosen].some((o) => !known.has(o))) throw badRequest('Unknown option');
    for (const p of list) {
      const n = p.options.filter((o) => chosen.has(o.id)).length;
      if (p.singleSelect && n > 1) throw badRequest(`"${p.title}" takes a single answer`);
      if (p.required && n === 0) throw badRequest(`"${p.title}" needs an answer`);
    }
    const all = list.flatMap((p) => p.options); const picked = all.filter((o) => chosen.has(o.id));
    const grant = new Set(picked.flatMap((o) => o.roleIds)); const managed = new Set(all.flatMap((o) => o.roleIds));
    const have = new Set(gp.memberRoleIds);
    const live = new Set((await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[])', [id, [...managed]])).map((r) => r.id as string)); // roles deleted since are skipped
    const adds = [...grant].filter((r) => live.has(r) && !have.has(r)); const removes = [...managed].filter((r) => !grant.has(r) && have.has(r));
    const channelIds = [...new Set(picked.flatMap((o) => o.channelIds))];
    const settled = await trackVisibility(ctx, id, { userIds: [req.userId] });
    if (removes.length) await ctx.db.query('DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2 AND role_id = ANY($3::text[])', [id, req.userId, removes]);
    for (const r of adds) await ctx.db.query('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, req.userId, r]);
    await ctx.db.query(`INSERT INTO member_onboarding (guild_id, user_id, option_ids, channel_ids) VALUES ($1,$2,$3::jsonb,$4::jsonb)
      ON CONFLICT (guild_id, user_id) DO UPDATE SET option_ids = EXCLUDED.option_ids, channel_ids = EXCLUDED.channel_ids, completed_at = now()`, [id, req.userId, JSON.stringify([...chosen]), JSON.stringify(channelIds)]);
    if (adds.length || removes.length) {
      await ctx.pcache.invalidate({ k: 'member', guildId: id, userId: req.userId });
      await settled();
      const m = await memberDTO(ctx, id, req.userId); if (m) await ctx.hub.toGuild(id, 'MEMBER_UPDATE', m);
    }
    const [r] = await ctx.db.query('SELECT * FROM member_onboarding WHERE guild_id = $1 AND user_id = $2', [id, req.userId]);
    return { optionIds: r.option_ids, channelIds: r.channel_ids, completedAt: iso(r.completed_at)! };
  });
}
