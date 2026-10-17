import { CommandOptionType as OT, has, type CommandOption, type DirectoryCategory } from '@jorcord/shared';
import type { Ctx } from '../../ctx';
import { ApiError, badRequest, forbidden } from '../../errors';
import { loadGuildPerm, loadOverwrites, permsFor, type GuildPerm } from '../perms';

/** What one built-in command handler gets. Everything here is server-derived; the handler never trusts the client for permissions. */
export interface CmdCtx {
  ctx: Ctx; app: any; interaction: any;
  userId: string; guildId: string; channel: any;
  /** The caller's guild-level permission inputs (roles, hierarchy position, owner flag). */
  caller: GuildPerm;
  /** The caller's effective permissions in the channel the command was used in. */
  callerPerms: bigint;
  /** "sub" or "group sub" for sub commands, '' for a plain command. */
  sub: string;
  opt<T extends string | number | boolean = string>(name: string): T | undefined;
  /** Replies to the interaction. Ephemeral by default: only the caller sees it. */
  reply(content: string, o?: { ephemeral?: boolean }): Promise<void>;
}
export interface SysCommand {
  name: string; description: string; options?: CommandOption[];
  /** Hides the command from members without this permission (and the dispatcher re-checks it). */
  requires?: bigint;
  /** Per caller, per server. */
  limit: { max: number; windowMs: number };
  run(c: CmdCtx): Promise<void>;
}
export interface SysBot {
  key: 'welcome' | 'moderation' | 'utility';
  name: string; description: string; summary: string; category: DirectoryCategory; tags: string[];
  /** Permissions the bot's managed role is offered with at install (also what the directory suggests). */
  permissions: bigint;
  commands: SysCommand[];
}

export const sub = (name: string, description: string, options: CommandOption[] = []): CommandOption => ({ type: OT.SUB_COMMAND, name, description, options });
export const str = (name: string, description: string, o: Partial<CommandOption> = {}): CommandOption => ({ type: OT.STRING, name, description, ...o });
export const int = (name: string, description: string, o: Partial<CommandOption> = {}): CommandOption => ({ type: OT.INTEGER, name, description, ...o });
export const bool = (name: string, description: string, o: Partial<CommandOption> = {}): CommandOption => ({ type: OT.BOOLEAN, name, description, ...o });
export const user = (name: string, description: string, o: Partial<CommandOption> = {}): CommandOption => ({ type: OT.USER, name, description, ...o });
export const channelOpt = (name: string, description: string, o: Partial<CommandOption> = {}): CommandOption => ({ type: OT.CHANNEL, name, description, ...o });
export const roleOpt = (name: string, description: string, o: Partial<CommandOption> = {}): CommandOption => ({ type: OT.ROLE, name, description, ...o });

/** Effective permissions of `gp` in a channel (threads use their parent's overwrites). */
export async function permsIn(ctx: Ctx, gp: GuildPerm, channel: any): Promise<bigint> {
  return permsFor(gp, await loadOverwrites(ctx, channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id));
}
export function requirePerm(perms: bigint, bit: bigint, what: string) {
  if (!has(perms, bit)) throw forbidden(`You need the ${what} permission to use this`, 'MISSING_PERMISSIONS');
}
/** The bot itself must hold the permission too (server admins can take it away in Bots & Apps). */
export async function requireBotPerm(c: Pick<CmdCtx, 'ctx' | 'app' | 'guildId' | 'channel'>, bit: bigint, what: string, channel: any = c.channel) {
  const gp = await loadGuildPerm(c.ctx, c.guildId, c.app.bot_user_id);
  if (!gp || !has(await permsIn(c.ctx, gp, channel), bit)) throw badRequest(`${c.app.name} is missing the ${what} permission here. Ask a server manager to grant it under Server Settings > Bots & Apps.`);
}
export const isUserFacing = (e: unknown): e is ApiError => e instanceof ApiError && e.status < 500;

/** "10m", "2h", "1d", "1w", "90s" or a bare number of minutes -> milliseconds. */
export function parseDuration(s: string): number | null {
  const m = /^\s*(\d{1,6})\s*(s|m|h|d|w)?\s*$/i.exec(s);
  if (!m) return null;
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[(m[2] ?? 'm').toLowerCase() as 's'];
  return Number(m[1]) * unit;
}
