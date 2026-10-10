/** Permission-aware UI helpers. All gating here is cosmetic: the server enforces via computePermissions. */
import { ALL_PERMS, Perm, computePermissions, has, type Overwrite, type PermName } from '@jorcord/shared';
import type { Channel, Guild, Member, Role, OverwriteDTO } from '@jorcord/shared';

export const toBig = (s: string | number | bigint | null | undefined): bigint => { try { return BigInt(s ?? 0); } catch { return 0n; } };
export const toOverwrites = (o: OverwriteDTO[] = []): Overwrite[] => o.map((x) => ({ id: x.id, type: x.type, allow: toBig(x.allow), deny: toBig(x.deny) }));

export function everyoneRole(roles: Role[], guildId: string): Role | undefined {
  return roles.find((r) => r.id === guildId) ?? roles.find((r) => r.name === '@everyone') ?? [...roles].sort((a, b) => a.position - b.position)[0];
}

export interface PermCtx { guild: Pick<Guild, 'id' | 'ownerId'>; roles: Role[]; member: Pick<Member, 'roles' | 'timeoutUntil'> & { user: { id: string } } | undefined }

/** Effective permissions for the member in the guild (no channel) or in a given channel. */
export function effectivePerms(ctx: PermCtx, channel?: Pick<Channel, 'overwrites' | 'parentId'> & { parentOverwrites?: OverwriteDTO[] }): bigint {
  const { guild, roles, member } = ctx;
  if (!member) return 0n;
  const ev = everyoneRole(roles, guild.id);
  const rolePerms: Record<string, bigint> = {};
  for (const r of roles) rolePerms[r.id] = toBig(r.permissions);
  const timedOut = !!member.timeoutUntil && new Date(member.timeoutUntil).getTime() > Date.now();
  return computePermissions({
    isOwner: guild.ownerId === member.user.id, everyoneRoleId: ev?.id ?? guild.id, everyonePerms: ev ? toBig(ev.permissions) : 0n,
    memberRoleIds: member.roles, rolePerms, memberId: member.user.id, overwrites: toOverwrites(channel?.overwrites), timedOut,
  });
}

export const can = (perms: bigint, ...ps: bigint[]) => ps.every((p) => has(perms, p));
export const canAny = (perms: bigint, ...ps: bigint[]) => ps.some((p) => has(perms, p));
export const isAdmin = (perms: bigint) => (perms & Perm.ADMINISTRATOR) !== 0n || perms === ALL_PERMS;

export const MANAGEMENT_PERMS = Perm.MANAGE_GUILD | Perm.MANAGE_ROLES | Perm.MANAGE_CHANNELS | Perm.KICK_MEMBERS | Perm.BAN_MEMBERS | Perm.VIEW_AUDIT_LOG | Perm.MANAGE_EMOJIS | Perm.MANAGE_WEBHOOKS | Perm.MODERATE_MEMBERS;
export const canOpenGuildSettings = (perms: bigint) => canAny(perms, Perm.MANAGE_GUILD, Perm.MANAGE_ROLES, Perm.MANAGE_CHANNELS, Perm.VIEW_AUDIT_LOG, Perm.MANAGE_EMOJIS, Perm.BAN_MEMBERS, Perm.MANAGE_WEBHOOKS);

/** What the composer may do in a channel. */
export function composerState(perms: bigint, channel: Pick<Channel, 'type' | 'archived'> & { locked?: boolean }, opts: { pending?: boolean } = {}): { canView: boolean; canSend: boolean; canAttach: boolean; canEmbed: boolean; reason?: string } {
  const canView = has(perms, Perm.VIEW_CHANNEL);
  const isThread = channel.type === 'thread';
  // A locked thread (open or archived) takes no messages from anyone without MANAGE_THREADS (server: 403 errorCode 50083).
  // An archived thread that is not locked is reopened by whoever posts, but the client asks for an explicit Unarchive first.
  const lockedOut = isThread && !!channel.locked && !has(perms, Perm.MANAGE_THREADS);
  const canSend = has(perms, isThread ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES) && !channel.archived && !lockedOut && !opts.pending && channel.type !== 'category';
  const reason = !canSend ? (opts.pending ? 'Accept the server rules to start chatting.' : channel.archived ? (channel.locked ? 'This thread is archived and locked.' : 'This thread is archived.') : lockedOut ? 'This thread is locked.' : 'You do not have permission to send messages in this channel.') : undefined;
  return { canView, canSend, canAttach: canSend && has(perms, Perm.ATTACH_FILES), canEmbed: has(perms, Perm.EMBED_LINKS), reason };
}

export function highestPosition(guild: Pick<Guild, 'ownerId'>, roles: Role[], member: Pick<Member, 'roles'> & { user: { id: string } }): number {
  if (guild.ownerId === member.user.id) return Number.POSITIVE_INFINITY;
  let best = 0;
  for (const r of roles) if (member.roles.includes(r.id) && r.position > best) best = r.position;
  return best;
}
/** Hierarchy rule: you can manage a member/role only when strictly below your highest role. */
export function canManageMember(guild: Pick<Guild, 'ownerId'>, roles: Role[], actor: Member, target: Member, actorPerms: bigint, need: bigint): boolean {
  if (actor.user.id === target.user.id) return false;
  if (target.user.id === guild.ownerId) return false;
  if (!has(actorPerms, need)) return false;
  return highestPosition(guild, roles, actor) > highestPosition(guild, roles, target);
}
export function canManageRole(guild: Pick<Guild, 'ownerId'>, roles: Role[], actor: Member, role: Role, actorPerms: bigint): boolean {
  if (!has(actorPerms, Perm.MANAGE_ROLES)) return false;
  if (guild.ownerId === actor.user.id) return true;
  return highestPosition(guild, roles, actor) > role.position;
}
export function canEditMessage(msg: { author: { id: string }; type: string }, meId: string) { return msg.author.id === meId && (msg.type === 'default' || msg.type === 'reply'); }
export function canDeleteMessage(msg: { author: { id: string } }, meId: string, perms: bigint) { return msg.author.id === meId || has(perms, Perm.MANAGE_MESSAGES); }
export const canPinMessage = (perms: bigint, isDm: boolean) => isDm || has(perms, Perm.MANAGE_MESSAGES);

export const intToHex = (c: number) => '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
export const hexToInt = (h: string) => parseInt(h.replace('#', ''), 16) || 0;

export function roleColor(member: Pick<Member, 'roles'> | undefined, roles: Role[]): string | undefined {
  if (!member) return undefined;
  let best: Role | undefined;
  for (const r of roles) if (member.roles.includes(r.id) && r.color && (!best || r.position > best.position)) best = r;
  return best ? intToHex(best.color) : undefined;
}

/** The icon of the member's highest role that has one (shown beside their name, like Discord role icons). */
export function roleIcon(member: Pick<Member, 'roles'> | undefined, roles: Role[]): Role | undefined {
  if (!member) return undefined;
  let best: Role | undefined;
  for (const r of roles) if (r.icon && member.roles.includes(r.id) && (!best || r.position > best.position)) best = r;
  return best;
}

export interface MemberGroup { id: string; name: string; members: Member[] }
/** Member list grouping: hoisted roles (highest first) holding online members, then Online, then Offline. */
export function groupMembers(members: Member[], roles: Role[], presenceOf: (id: string) => string | undefined, guildId: string): MemberGroup[] {
  const hoisted = roles.filter((r) => r.hoist && r.id !== guildId).sort((a, b) => b.position - a.position);
  const groups = new Map<string, MemberGroup>();
  const online: Member[] = [], offline: Member[] = [];
  const nm = (m: Member) => (m.nick ?? m.user.displayName ?? m.user.username).toLowerCase();
  const sorted = [...members].sort((a, b) => nm(a).localeCompare(nm(b)));
  for (const m of sorted) {
    const p = presenceOf(m.user.id);
    if (!p || p === 'offline' || p === 'invisible') { offline.push(m); continue; }
    const hr = hoisted.find((r) => m.roles.includes(r.id));
    if (hr) { if (!groups.has(hr.id)) groups.set(hr.id, { id: hr.id, name: hr.name, members: [] }); groups.get(hr.id)!.members.push(m); }
    else online.push(m);
  }
  const res: MemberGroup[] = hoisted.filter((r) => groups.has(r.id)).map((r) => groups.get(r.id)!);
  if (online.length) res.push({ id: 'online', name: 'Online', members: online });
  if (offline.length) res.push({ id: 'offline', name: 'Offline', members: offline });
  return res;
}

export interface PermMeta { name: PermName; label: string; desc: string; group: string; voice?: boolean }
const P = (name: PermName, label: string, desc: string, group: string): PermMeta => ({ name, label, desc, group });
export const PERMISSION_META: PermMeta[] = [
  P('VIEW_CHANNEL', 'View Channels', 'Allows members to view channels by default (excluding private channels).', 'General'),
  P('MANAGE_CHANNELS', 'Manage Channels', 'Create, edit, or delete channels.', 'General'),
  P('MANAGE_ROLES', 'Manage Roles', 'Create new roles and edit or delete roles lower than their highest role.', 'General'),
  P('MANAGE_EMOJIS', 'Manage Expressions', 'Add, edit or remove custom emoji and stickers.', 'General'),
  P('VIEW_AUDIT_LOG', 'View Audit Log', 'View a record of who made which changes in this server.', 'General'),
  P('MANAGE_WEBHOOKS', 'Manage Webhooks', 'Create, edit, or delete webhooks.', 'General'),
  P('MANAGE_GUILD', 'Manage Server', 'Change the server name, icon and other settings.', 'General'),
  P('MANAGE_EVENTS', 'Manage Events', 'Edit and cancel events created by anyone.', 'Events'),
  P('CREATE_EVENTS', 'Create Events', 'Create events for the server (and edit or cancel your own).', 'Events'),
  P('CREATE_INVITE', 'Create Invite', 'Invite new people to this server.', 'Membership'),
  P('CHANGE_NICKNAME', 'Change Nickname', 'Change their own nickname.', 'Membership'),
  P('MANAGE_NICKNAMES', 'Manage Nicknames', 'Change the nicknames of other members.', 'Membership'),
  P('KICK_MEMBERS', 'Kick Members', 'Remove members from this server.', 'Membership'),
  P('BAN_MEMBERS', 'Ban Members', 'Permanently ban members from this server.', 'Membership'),
  P('MODERATE_MEMBERS', 'Timeout Members', 'Prevent members from sending messages, reacting, or speaking.', 'Membership'),
  P('SEND_MESSAGES', 'Send Messages', 'Send messages in text channels.', 'Text'),
  P('SEND_IN_THREADS', 'Send Messages in Threads', 'Send messages in threads.', 'Text'),
  P('CREATE_PUBLIC_THREADS', 'Create Public Threads', 'Start threads anyone in the channel can view.', 'Text'),
  P('CREATE_PRIVATE_THREADS', 'Create Private Threads', 'Start invite-only threads.', 'Text'),
  P('EMBED_LINKS', 'Embed Links', 'Links shared will show an embed.', 'Text'),
  P('ATTACH_FILES', 'Attach Files', 'Upload files or media.', 'Text'),
  P('ADD_REACTIONS', 'Add Reactions', 'Add new reactions to a message.', 'Text'),
  P('USE_EXTERNAL_EMOJIS', 'Use External Emoji', 'Use emoji from other servers.', 'Text'),
  P('MENTION_EVERYONE', 'Mention @everyone, @here and All Roles', 'Notify everyone in the channel.', 'Text'),
  P('MANAGE_MESSAGES', 'Manage Messages', 'Delete messages by other members or pin any message.', 'Text'),
  P('MANAGE_THREADS', 'Manage Threads', 'Rename, delete, close and enable slow mode for threads.', 'Text'),
  P('READ_MESSAGE_HISTORY', 'Read Message History', 'Read messages sent previously in channels.', 'Text'),
  P('SEND_TTS', 'Send Text-to-Speech Messages', 'Send messages using text-to-speech.', 'Text'),
  P('USE_SLASH_COMMANDS', 'Use Application Commands', 'Use commands from applications.', 'Text'),
  P('USE_EXTERNAL_APPS', 'Use External Apps', 'Let people see the replies of apps they run here to everyone, not only themselves.', 'Text'),
  P('SEND_POLLS', 'Create Polls', 'Start polls in text channels.', 'Text'),
  P('CONNECT', 'Connect', 'Join voice channels.', 'Voice'),
  P('SPEAK', 'Speak', 'Talk in voice channels.', 'Voice'),
  P('STREAM', 'Video', 'Share video, screen share, or stream a game.', 'Voice'),
  P('USE_SOUNDBOARD', 'Use Soundboard', 'Send sounds from the server soundboard.', 'Voice'),
  P('USE_VAD', 'Use Voice Activity', 'Talk by speaking, without push-to-talk.', 'Voice'),
  P('PRIORITY_SPEAKER', 'Priority Speaker', 'Be more easily heard; others are attenuated.', 'Voice'),
  P('MUTE_MEMBERS', 'Mute Members', 'Mute other members in voice.', 'Voice'),
  P('DEAFEN_MEMBERS', 'Deafen Members', 'Deafen other members in voice.', 'Voice'),
  P('MOVE_MEMBERS', 'Move Members', 'Move members between voice channels.', 'Voice'),
  P('REQUEST_TO_SPEAK', 'Request to Speak', 'Request to speak in stage channels.', 'Voice'),
  P('ADMINISTRATOR', 'Administrator', 'Members with this permission have every permission and bypass channel overrides. This is dangerous.', 'Advanced'),
];

export type OverwriteState = 'allow' | 'deny' | 'inherit';
export function overwriteState(ow: Pick<OverwriteDTO, 'allow' | 'deny'> | undefined, p: PermName): OverwriteState {
  if (!ow) return 'inherit';
  if ((toBig(ow.allow) & Perm[p]) !== 0n) return 'allow';
  if ((toBig(ow.deny) & Perm[p]) !== 0n) return 'deny';
  return 'inherit';
}
export function setOverwriteState(ow: Pick<OverwriteDTO, 'allow' | 'deny'>, p: PermName, s: OverwriteState): { allow: string; deny: string } {
  let a = toBig(ow.allow) & ~Perm[p], d = toBig(ow.deny) & ~Perm[p];
  if (s === 'allow') a |= Perm[p]; else if (s === 'deny') d |= Perm[p];
  return { allow: a.toString(), deny: d.toString() };
}
export function togglePerm(bits: string, p: PermName, on: boolean): string {
  const b = toBig(bits); return (on ? b | Perm[p] : b & ~Perm[p]).toString();
}
export const hasPermBit = (bits: string, p: PermName) => (toBig(bits) & Perm[p]) !== 0n;
