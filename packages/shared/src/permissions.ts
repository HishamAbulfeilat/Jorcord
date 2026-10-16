/**
 * 64-bit permission bitfield (bigint). The *algorithm* mirrors Discord's; the bit POSITIONS are Jorcord's own and intentionally differ
 * from Discord's above bit 32 (see DISCORD_PERMISSION_BITS for the name -> Discord position mapping, and docs/PARITY.md).
 */
export const Perm = {
  CREATE_INVITE: 1n << 0n, KICK_MEMBERS: 1n << 1n, BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n, VIEW_AUDIT_LOG: 1n << 7n, PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n, VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n,
  SEND_TTS: 1n << 12n, MANAGE_MESSAGES: 1n << 13n, EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n, READ_MESSAGE_HISTORY: 1n << 16n, MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n, SEND_VOICE_MESSAGES: 1n << 19n, CONNECT: 1n << 20n, SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n, DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n, CHANGE_NICKNAME: 1n << 26n, MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n, MANAGE_WEBHOOKS: 1n << 29n, MANAGE_EMOJIS: 1n << 30n,
  USE_SLASH_COMMANDS: 1n << 31n, REQUEST_TO_SPEAK: 1n << 32n,
  MANAGE_THREADS: 1n << 33n, CREATE_PUBLIC_THREADS: 1n << 34n,
  CREATE_PRIVATE_THREADS: 1n << 35n, SEND_IN_THREADS: 1n << 36n,
  USE_SOUNDBOARD: 1n << 37n, MANAGE_EVENTS: 1n << 38n, CREATE_EVENTS: 1n << 39n,
  MODERATE_MEMBERS: 1n << 40n, SEND_POLLS: 1n << 41n, USE_EXTERNAL_APPS: 1n << 42n,
} as const;
export type PermName = keyof typeof Perm;
export const ALL_PERMS = Object.values(Perm).reduce((a, b) => a | b, 0n);
export const DEFAULT_EVERYONE =
  Perm.CREATE_INVITE | Perm.ADD_REACTIONS | Perm.STREAM | Perm.VIEW_CHANNEL |
  Perm.SEND_MESSAGES | Perm.EMBED_LINKS | Perm.ATTACH_FILES | Perm.READ_MESSAGE_HISTORY |
  Perm.USE_EXTERNAL_EMOJIS | Perm.CONNECT | Perm.SPEAK | Perm.USE_VAD |
  Perm.CHANGE_NICKNAME | Perm.USE_SLASH_COMMANDS | Perm.REQUEST_TO_SPEAK |
  Perm.CREATE_PUBLIC_THREADS | Perm.SEND_IN_THREADS | Perm.USE_SOUNDBOARD | Perm.SEND_POLLS | Perm.USE_EXTERNAL_APPS |
  Perm.SEND_VOICE_MESSAGES;
/** Bits added after the first release; migration 005 ORs them into existing @everyone roles. */
export const PERMS_ADDED_TO_EVERYONE_IN_005 = Perm.SEND_POLLS | Perm.USE_EXTERNAL_APPS;

/** Jorcord permission name -> the bit position Discord uses for the equivalent permission (public docs, topics/permissions). Informational only: never put Discord positions on the wire. */
export const DISCORD_PERMISSION_BITS: Record<PermName, number> = {
  CREATE_INVITE: 0, KICK_MEMBERS: 1, BAN_MEMBERS: 2, ADMINISTRATOR: 3, MANAGE_CHANNELS: 4, MANAGE_GUILD: 5, ADD_REACTIONS: 6, VIEW_AUDIT_LOG: 7,
  PRIORITY_SPEAKER: 8, STREAM: 9, VIEW_CHANNEL: 10, SEND_MESSAGES: 11, SEND_TTS: 12, MANAGE_MESSAGES: 13, EMBED_LINKS: 14, ATTACH_FILES: 15,
  READ_MESSAGE_HISTORY: 16, MENTION_EVERYONE: 17, USE_EXTERNAL_EMOJIS: 18, CONNECT: 20, SPEAK: 21, MUTE_MEMBERS: 22, DEAFEN_MEMBERS: 23,
  MOVE_MEMBERS: 24, USE_VAD: 25, CHANGE_NICKNAME: 26, MANAGE_NICKNAMES: 27, MANAGE_ROLES: 28, MANAGE_WEBHOOKS: 29, MANAGE_EMOJIS: 30 /* MANAGE_GUILD_EXPRESSIONS */,
  USE_SLASH_COMMANDS: 31 /* USE_APPLICATION_COMMANDS */, REQUEST_TO_SPEAK: 32, MANAGE_THREADS: 34, CREATE_PUBLIC_THREADS: 35, CREATE_PRIVATE_THREADS: 36,
  SEND_IN_THREADS: 38 /* SEND_MESSAGES_IN_THREADS */, USE_SOUNDBOARD: 42, MANAGE_EVENTS: 33, CREATE_EVENTS: 44, MODERATE_MEMBERS: 40, SEND_POLLS: 49, USE_EXTERNAL_APPS: 50, SEND_VOICE_MESSAGES: 45,
};

export const has = (perms: bigint, p: bigint) => (perms & Perm.ADMINISTRATOR) !== 0n || (perms & p) === p;

export interface Overwrite { id: string; type: 'role' | 'member'; allow: bigint; deny: bigint }

/** Compute effective permissions for a member in a channel (Discord algorithm). */
export function computePermissions(opts: {
  isOwner: boolean; everyoneRoleId: string; everyonePerms: bigint;
  memberRoleIds: string[]; rolePerms: Record<string, bigint>;
  memberId: string; overwrites?: Overwrite[]; timedOut?: boolean;
}): bigint {
  if (opts.isOwner) return ALL_PERMS;
  let p = opts.everyonePerms;
  for (const r of opts.memberRoleIds) p |= opts.rolePerms[r] ?? 0n;
  if (p & Perm.ADMINISTRATOR) return ALL_PERMS;
  const ow = opts.overwrites ?? [];
  const ev = ow.find((o) => o.type === 'role' && o.id === opts.everyoneRoleId);
  if (ev) p = (p & ~ev.deny) | ev.allow;
  let allow = 0n, deny = 0n;
  for (const o of ow) if (o.type === 'role' && opts.memberRoleIds.includes(o.id)) { allow |= o.allow; deny |= o.deny; }
  p = (p & ~deny) | allow;
  const mem = ow.find((o) => o.type === 'member' && o.id === opts.memberId);
  if (mem) p = (p & ~mem.deny) | mem.allow;
  if (opts.timedOut) p &= Perm.VIEW_CHANNEL | Perm.READ_MESSAGE_HISTORY;
  return p;
}
