/** 64-bit permission bitfield (bigint). Mirrors Discord's model. */
export const Perm = {
  CREATE_INVITE: 1n << 0n, KICK_MEMBERS: 1n << 1n, BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n, VIEW_AUDIT_LOG: 1n << 7n, PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n, VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n,
  SEND_TTS: 1n << 12n, MANAGE_MESSAGES: 1n << 13n, EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n, READ_MESSAGE_HISTORY: 1n << 16n, MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n, CONNECT: 1n << 20n, SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n, DEAFEN_MEMBERS: 1n << 23n, MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n, CHANGE_NICKNAME: 1n << 26n, MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n, MANAGE_WEBHOOKS: 1n << 29n, MANAGE_EMOJIS: 1n << 30n,
  USE_SLASH_COMMANDS: 1n << 31n, REQUEST_TO_SPEAK: 1n << 32n,
  MANAGE_THREADS: 1n << 33n, CREATE_PUBLIC_THREADS: 1n << 34n,
  CREATE_PRIVATE_THREADS: 1n << 35n, SEND_IN_THREADS: 1n << 36n,
  USE_SOUNDBOARD: 1n << 37n, MODERATE_MEMBERS: 1n << 40n,
} as const;
export type PermName = keyof typeof Perm;
export const ALL_PERMS = Object.values(Perm).reduce((a, b) => a | b, 0n);
export const DEFAULT_EVERYONE =
  Perm.CREATE_INVITE | Perm.ADD_REACTIONS | Perm.STREAM | Perm.VIEW_CHANNEL |
  Perm.SEND_MESSAGES | Perm.EMBED_LINKS | Perm.ATTACH_FILES | Perm.READ_MESSAGE_HISTORY |
  Perm.USE_EXTERNAL_EMOJIS | Perm.CONNECT | Perm.SPEAK | Perm.USE_VAD |
  Perm.CHANGE_NICKNAME | Perm.USE_SLASH_COMMANDS | Perm.REQUEST_TO_SPEAK |
  Perm.CREATE_PUBLIC_THREADS | Perm.SEND_IN_THREADS | Perm.USE_SOUNDBOARD;

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
