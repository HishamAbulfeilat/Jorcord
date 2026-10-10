import { randomBytes } from 'node:crypto';
import { DEFAULT_EVERYONE, MAX_TEMPLATE_CHANNELS, snowflake, type GuildTemplate, type SerializedTemplate, type TemplateChannel } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { insertChannel } from './guilds';

const B62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const templateCode = () => Array.from(randomBytes(12), (b) => B62[b % 62]).join('');

/** Snapshot a server into a template: roles (not bot-managed), channels with their role overwrites, and a few settings. */
export async function serializeGuild(ctx: Ctx, guildId: string): Promise<SerializedTemplate> {
  const [g] = await ctx.db.query('SELECT verification_level, explicit_filter, default_notifications FROM guilds WHERE id = $1', [guildId]);
  const roleRows = await ctx.db.query('SELECT * FROM roles WHERE guild_id = $1 ORDER BY position, id', [guildId]);
  const everyone = roleRows.find((r) => r.id === guildId);
  const roles = roleRows.filter((r) => r.id !== guildId && !r.managed_app_id && !r.managed_kind);
  const roleKey = new Map(roles.map((r, i) => [r.id as string, `r${i}`]));
  const chRows = (await ctx.db.query(`SELECT * FROM channels WHERE guild_id = $1 AND type <> 'thread' ORDER BY position, id`, [guildId])).slice(0, MAX_TEMPLATE_CHANNELS);
  const chKey = new Map(chRows.map((c, i) => [c.id as string, `c${i}`]));
  const ows = chRows.length ? await ctx.db.query(`SELECT * FROM overwrites WHERE type = 'role' AND channel_id = ANY($1::text[]) ORDER BY channel_id, target_id`, [chRows.map((c) => c.id)]) : [];
  return {
    v: 1,
    settings: { verificationLevel: g.verification_level ?? 0, explicitFilter: g.explicit_filter ?? 0, defaultNotifications: g.default_notifications ?? 'mentions', everyonePermissions: everyone?.permissions ?? DEFAULT_EVERYONE.toString() },
    roles: roles.map((r) => ({ key: roleKey.get(r.id)!, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions, position: r.position })),
    channels: chRows.map((c) => ({
      key: chKey.get(c.id)!, type: c.type, name: c.name ?? '', topic: c.topic ?? null, nsfw: !!c.nsfw, slowmode: c.slowmode ?? 0, bitrate: c.bitrate ?? null, userLimit: c.user_limit ?? null,
      position: c.position, parentKey: c.parent_id ? chKey.get(c.parent_id) ?? null : null,
      overwrites: ows.filter((o) => o.channel_id === c.id && (o.target_id === guildId || roleKey.has(o.target_id))).map((o) => ({ target: o.target_id === guildId ? 'everyone' : roleKey.get(o.target_id)!, allow: o.allow, deny: o.deny })),
    } satisfies TemplateChannel)),
  };
}

/** JSONB does not keep key order, so compare canonical (sorted-key) forms. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
export const sameTemplate = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export async function templateDTO(ctx: Ctx, r: any, o: { dirty?: boolean; preview?: boolean } = {}): Promise<GuildTemplate> {
  const [g] = await ctx.db.query('SELECT id, name, icon FROM guilds WHERE id = $1', [r.guild_id]);
  const s = r.serialized as SerializedTemplate;
  const dirty = o.dirty ? !sameTemplate(s, await serializeGuild(ctx, r.guild_id)) : undefined;
  return {
    code: r.code, guildId: r.guild_id, name: r.name, description: r.description ?? null, creatorId: r.creator_id, usageCount: r.usage_count, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    ...(dirty !== undefined ? { isDirty: dirty } : {}),
    sourceGuild: g ? { id: g.id, name: g.name, icon: g.icon ?? null } : undefined,
    ...(o.preview ? { preview: { roles: s.roles.map((x) => ({ name: x.name, color: x.color })), channels: s.channels.map((c) => ({ name: c.name, type: c.type, parent: c.parentKey ? s.channels.find((p) => p.key === c.parentKey)?.name ?? null : null })) } } : {}),
  };
}

/** Build a brand-new server from a template snapshot; the caller becomes the owner. Returns the guild id. */
export async function createGuildFromTemplate(ctx: Ctx, ownerId: string, t: SerializedTemplate, input: { name: string; icon?: string | null }): Promise<string> {
  const id = snowflake();
  await ctx.db.tx(async (q) => {
    await q.query('INSERT INTO guilds (id, name, icon, owner_id, verification_level, explicit_filter, default_notifications) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, input.name, input.icon ?? null, ownerId, t.settings.verificationLevel, t.settings.explicitFilter, t.settings.defaultNotifications]);
    await q.query(`INSERT INTO roles (id, guild_id, name, permissions, position) VALUES ($1,$1,'@everyone',$2,0)`, [id, t.settings.everyonePermissions]);
    await q.query('INSERT INTO members (guild_id, user_id) VALUES ($1,$2)', [id, ownerId]);
    const roleIds = new Map<string, string>([['everyone', id]]);
    for (const r of [...t.roles].sort((a, b) => a.position - b.position)) {
      const rid = snowflake(); roleIds.set(r.key, rid);
      await q.query('INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [rid, id, r.name, r.color, r.hoist, Math.max(1, r.position), r.permissions, r.mentionable]);
    }
    const chIds = new Map<string, string>(); let firstText: string | null = null;
    const ordered = [...t.channels].sort((a, b) => (a.type === 'category' ? 0 : 1) - (b.type === 'category' ? 0 : 1) || a.position - b.position); // categories first so children can point at them
    for (const c of ordered) {
      const cid = await insertChannel(q, { guildId: id, type: c.type, name: c.name, topic: c.topic, position: c.position, parentId: c.parentKey ? chIds.get(c.parentKey) ?? null : null, nsfw: c.nsfw, slowmode: c.slowmode, bitrate: c.bitrate, userLimit: c.userLimit });
      chIds.set(c.key, cid);
      if (!firstText && c.type === 'text') firstText = cid;
      for (const o of c.overwrites) { const target = roleIds.get(o.target); if (target) await q.query(`INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES ($1,$2,'role',$3,$4) ON CONFLICT DO NOTHING`, [cid, target, o.allow, o.deny]); }
    }
    await q.query('UPDATE guilds SET system_channel_id = $2 WHERE id = $1', [id, firstText]);
  });
  return id;
}

/** Template shape check: a stored/edited template must still describe a sane server. */
export function validTemplate(t: SerializedTemplate): boolean {
  if (!t || t.v !== 1 || !Array.isArray(t.roles) || !Array.isArray(t.channels) || t.channels.length > MAX_TEMPLATE_CHANNELS) return false;
  const keys = new Set(t.channels.map((c) => c.key));
  return t.channels.every((c) => !c.parentKey || keys.has(c.parentKey));
}
