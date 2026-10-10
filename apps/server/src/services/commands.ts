import { CommandOptionType as OT, CommandType, Perm, has, type ApplicationCommand, type CommandOption, type InteractionOptionValue } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { iso } from '../lib/ids';
import { loadGuildPerm, permsFor, loadOverwrites } from './perms';

export const commandDTO = (r: any): ApplicationCommand => ({
  id: r.id, applicationId: r.application_id, guildId: r.guild_id ?? null, type: r.type, name: r.name, description: r.description, options: r.options ?? [],
  defaultMemberPermissions: r.default_member_permissions ?? null, dmPermission: r.dm_permission, nsfw: r.nsfw, version: r.version,
});

export interface InvokerInfo { guildId: string | null; userId: string; channelId: string; perms: bigint; memberRoleIds: string[]; channelParentId?: string | null }

/**
 * Discord-style command permission evaluation (public docs, "Permissions"):
 * administrators pass; a channel overwrite of `false` denies; a user overwrite is decisive; else any role overwrite `true` allows (all `false` denies);
 * else the @everyone overwrite; else default_member_permissions (null = everyone). Command-specific overwrites replace app-wide ones.
 * In every case the caller also needs USE_SLASH_COMMANDS in the channel.
 */
export async function canUseCommand(ctx: Ctx, cmd: any, who: InvokerInfo): Promise<boolean> {
  if (!who.guildId) return !!cmd.dm_permission && (cmd.guild_id ?? null) === null;
  if (cmd.guild_id && cmd.guild_id !== who.guildId) return false;
  if (!has(who.perms, Perm.USE_SLASH_COMMANDS)) return false;
  if (has(who.perms, Perm.ADMINISTRATOR)) return true;
  const rows = await ctx.db.query(
    'SELECT command_id, target_id, target_type, permission FROM command_permissions WHERE application_id = $1 AND guild_id = $2 AND command_id IN ($3, $1)', [cmd.application_id, who.guildId, cmd.id]);
  const specific = rows.filter((r) => r.command_id === cmd.id), set = specific.length ? specific : rows.filter((r) => r.command_id === cmd.application_id);
  const ch = set.find((r) => r.target_type === 3 && (r.target_id === who.channelId || r.target_id === who.channelParentId));
  if (ch && !ch.permission) return false;
  const u = set.find((r) => r.target_type === 2 && r.target_id === who.userId);
  if (u) return !!u.permission;
  const roles = set.filter((r) => r.target_type === 1 && who.memberRoleIds.includes(r.target_id));
  if (roles.some((r) => r.permission)) return true;
  if (roles.length) return false;
  const ev = set.find((r) => r.target_type === 1 && r.target_id === who.guildId);
  if (ev) return !!ev.permission;
  if (cmd.default_member_permissions == null) return true;
  const need = BigInt(cmd.default_member_permissions);
  return (who.perms & need) === need;
}

/** Commands the user could run in a guild: global + guild commands of applications installed there. */
export async function listUsableCommands(ctx: Ctx, guildId: string, userId: string, channelId?: string) {
  const gp = await loadGuildPerm(ctx, guildId, userId);
  if (!gp) return { commands: [], applications: [] };
  let chId = channelId ?? '', parent: string | null = null;
  let perms = permsFor(gp);
  if (channelId) {
    const [ch] = await ctx.db.query('SELECT id, parent_id, type FROM channels WHERE id = $1 AND guild_id = $2', [channelId, guildId]);
    if (ch) { chId = ch.id; parent = ch.parent_id; perms = permsFor(gp, await loadOverwrites(ctx, ch.type === 'thread' && ch.parent_id ? ch.parent_id : ch.id)); }
  }
  const rows = await ctx.db.query(
    `SELECT c.* FROM application_commands c JOIN application_installs i ON i.application_id = c.application_id AND i.guild_id = $1
      WHERE (c.guild_id IS NULL OR c.guild_id = $1)
      ORDER BY c.application_id, c.type, c.name`, [guildId]);
  const out = [];
  for (const r of rows) if (await canUseCommand(ctx, r, { guildId, userId, channelId: chId, perms, memberRoleIds: gp.memberRoleIds, channelParentId: parent })) out.push(commandDTO(r));
  const appIds = [...new Set(out.map((c) => c.applicationId))];
  const apps = appIds.length ? await ctx.db.query('SELECT a.id, a.name, a.icon, a.bot_user_id FROM applications a WHERE a.id = ANY($1::text[])', [appIds]) : [];
  return { commands: out, applications: apps.map((a) => ({ id: a.id, name: a.name, icon: a.icon ?? null, botUserId: a.bot_user_id })) };
}

const bad = (m: string, d?: unknown) => new ApiError(400, 'INVALID_INTERACTION', m, d).num(50035);

/** Validates the options a user supplied against the command definition. Returns the normalised tree. `autocomplete` relaxes required/choice checks. */
export async function validateInvocation(ctx: Ctx, defs: CommandOption[], supplied: unknown, guildId: string | null, channelId: string, autocomplete = false): Promise<InteractionOptionValue[]> {
  const list = Array.isArray(supplied) ? supplied : supplied === undefined ? [] : (() => { throw bad('options must be an array'); })();
  if (list.length > 25) throw bad('Too many options');
  const hasSub = defs.some((d) => d.type === OT.SUB_COMMAND || d.type === OT.SUB_COMMAND_GROUP);
  if (hasSub) {
    if (list.length !== 1) throw bad('Choose exactly one sub command');
    const o = list[0] as any; const def = defs.find((d) => d.name === o?.name);
    if (!def) throw bad(`Unknown option ${String(o?.name).slice(0, 40)}`);
    if (o.type !== def.type) throw bad(`Option ${def.name} has the wrong type`);
    return [{ name: def.name, type: def.type, options: await validateInvocation(ctx, def.options ?? [], o.options, guildId, channelId, autocomplete) }];
  }
  const out: InteractionOptionValue[] = [], seen = new Set<string>();
  for (const raw of list as any[]) {
    const def = defs.find((d) => d.name === raw?.name);
    if (!def) throw bad(`Unknown option ${String(raw?.name).slice(0, 40)}`);
    if (seen.has(def.name)) throw bad(`Option ${def.name} given twice`);
    seen.add(def.name);
    if (raw.type !== def.type) throw bad(`Option ${def.name} has the wrong type`);
    const v = raw.value, label = `Option ${def.name}`;
    if (autocomplete && raw.focused) { out.push({ name: def.name, type: def.type, value: typeof v === 'string' || typeof v === 'number' ? v : '', focused: true }); continue; }
    switch (def.type) {
      case OT.STRING:
        if (typeof v !== 'string') throw bad(`${label} must be a string`);
        if (v.length > (def.maxLength ?? 6000) || v.length < (def.minLength ?? 0)) throw bad(`${label} has an invalid length`);
        break;
      case OT.INTEGER: case OT.NUMBER:
        if (typeof v !== 'number' || !Number.isFinite(v) || (def.type === OT.INTEGER && !Number.isInteger(v))) throw bad(`${label} must be ${def.type === OT.INTEGER ? 'an integer' : 'a number'}`);
        if ((def.minValue !== undefined && v < def.minValue) || (def.maxValue !== undefined && v > def.maxValue)) throw bad(`${label} is out of range`);
        break;
      case OT.BOOLEAN: if (typeof v !== 'boolean') throw bad(`${label} must be a boolean`); break;
      case OT.USER: case OT.ROLE: case OT.CHANNEL: case OT.MENTIONABLE: {
        if (typeof v !== 'string' || !/^\d{1,20}$/.test(v)) throw bad(`${label} must be an id`);
        const ok = await resolveEntity(ctx, def.type, v, guildId, channelId);
        if (!ok) throw bad(`${label} refers to something that does not exist here`);
        break;
      }
      default: throw bad(`${label}: attachments are not supported`);
    }
    if (!autocomplete && def.choices && !def.choices.some((c) => c.value === v)) throw bad(`${label} must be one of the offered choices`);
    out.push({ name: def.name, type: def.type, value: v });
  }
  if (!autocomplete) for (const d of defs) if (d.required && !seen.has(d.name)) throw bad(`Option ${d.name} is required`);
  return out;
}

async function resolveEntity(ctx: Ctx, type: number, id: string, guildId: string | null, channelId: string): Promise<boolean> {
  const user = async () => guildId
    ? !!(await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, id]))[0]
    : !!(await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channelId, id]))[0];
  const role = async () => !!guildId && !!(await ctx.db.query('SELECT 1 AS x FROM roles WHERE guild_id = $1 AND id = $2', [guildId, id]))[0];
  const channel = async () => !!guildId && !!(await ctx.db.query('SELECT 1 AS x FROM channels WHERE guild_id = $1 AND id = $2', [guildId, id]))[0];
  if (type === OT.USER) return user();
  if (type === OT.ROLE) return role();
  if (type === OT.CHANNEL) return channel();
  return (await user()) || (await role());
}
export { CommandType, iso };
