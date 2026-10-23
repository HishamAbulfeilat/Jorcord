import { DISCORD_PERMISSION_BITS, Perm, type PermName } from './permissions';
import type { Id } from './types';

// ---------------------------------------------------------------------------------------------------------------------
// Opt-in end-to-end encrypted 1:1 DMs ("secret chats"). See docs/E2EE_DMS.md for the protocol and the threat model.
// ---------------------------------------------------------------------------------------------------------------------

/** A message in a secret chat has `content` = this prefix + base64url(JSON of an E2eeEnvelope). */
export const E2EE_ENVELOPE_PREFIX = 'jc-e2ee1:';
/** Upper bound for the whole `content` string of an encrypted message (the server never sees plaintext, so it caps the envelope instead). */
export const E2EE_MAX_ENVELOPE_CHARS = 24_000;
/** Plaintext limits the client enforces before encrypting: characters like a normal message, and UTF-8 bytes so the envelope always fits E2EE_MAX_ENVELOPE_CHARS. */
export const E2EE_MAX_PLAINTEXT_CHARS = 4000;
export const E2EE_MAX_PLAINTEXT_BYTES = 6000;
/** Active (non-revoked) devices one account may publish. */
export const E2EE_MAX_DEVICES = 10;

/** A published device identity. The private half never leaves the device. */
export interface E2eeDevice {
  id: Id; userId: Id;
  /** base64url of the raw (uncompressed, 65 byte) P-256 ECDH public key */
  publicKey: string;
  label: string | null; createdAt: string; lastSeenAt: string | null;
  /** set only when a listing asks for revoked devices too: their old messages still verify, nothing new may be sent from or to them */
  revokedAt?: string | null;
}

/** Per-recipient-device wrap of the message key. */
export interface E2eeWrap { iv: string; wk: string }
/**
 * What `content` carries. `from` is the sender's device id, `epk` the sender's ephemeral ECDH public key for this message,
 * `iv`/`ct` the AES-GCM encryption of the plaintext under a random per-message key, and `keys` that message key wrapped once per recipient device
 * (including the sender's other devices and the sender's own device).
 */
export interface E2eeEnvelope { v: 1; from: Id; epk: string; iv: string; ct: string; keys: Record<Id, E2eeWrap> }

const B64U = /^[A-Za-z0-9_-]+$/;
export function toB64u(bytes: Uint8Array): string {
  let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64u(s: string): Uint8Array {
  if (!B64U.test(s)) throw new Error('bad base64url');
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

export function encodeEnvelope(env: E2eeEnvelope): string {
  return E2EE_ENVELOPE_PREFIX + toB64u(new TextEncoder().encode(JSON.stringify(env)));
}
/** Structural check shared by the server (so it only ever stores well-formed ciphertext) and the clients. Returns null for anything else. */
export function parseEnvelope(content: string): E2eeEnvelope | null {
  if (typeof content !== 'string' || !content.startsWith(E2EE_ENVELOPE_PREFIX) || content.length > E2EE_MAX_ENVELOPE_CHARS) return null;
  let j: any;
  try { j = JSON.parse(new TextDecoder().decode(fromB64u(content.slice(E2EE_ENVELOPE_PREFIX.length)))); } catch { return null; }
  if (!j || typeof j !== 'object' || j.v !== 1) return null;
  const id = (x: unknown) => typeof x === 'string' && /^\d{1,20}$/.test(x);
  const b64 = (x: unknown, min: number, max: number) => typeof x === 'string' && x.length >= min && x.length <= max && B64U.test(x);
  if (!id(j.from) || !b64(j.epk, 80, 100) || !b64(j.iv, 16, 16) || !b64(j.ct, 22, 20_000)) return null;
  if (!j.keys || typeof j.keys !== 'object' || Array.isArray(j.keys)) return null;
  const entries = Object.entries(j.keys as Record<string, any>);
  if (!entries.length || entries.length > E2EE_MAX_DEVICES * 2) return null;
  for (const [k, w] of entries) if (!id(k) || !w || typeof w !== 'object' || !b64(w.iv, 16, 16) || !b64(w.wk, 40, 80)) return null;
  const keys: Record<string, E2eeWrap> = {};
  for (const [k, w] of entries) keys[k] = { iv: (w as any).iv, wk: (w as any).wk };
  return { v: 1, from: j.from, epk: j.epk, iv: j.iv, ct: j.ct, keys };
}
export const isEnvelope = (content: string) => parseEnvelope(content) !== null;

// ---------------------------------------------------------------------------------------------------------------------
// Notification digest ("quiet mode")
// ---------------------------------------------------------------------------------------------------------------------

export type DigestFrequency = 'hourly' | 'daily';
/** Servers with more members than this get "mentions only" automatically when the user joins (unless they opted out). */
export const LARGE_SERVER_MEMBER_THRESHOLD = 250;
export interface DigestPrefs { frequency: DigestFrequency; largeServerMentionsOnly: boolean; largeServerThreshold: number }
/** One line of a digest: what piled up in one channel while the pings were held back. */
export interface DigestItem { guildId: Id | null; channelId: Id; count: number; mentions: number; lastMessageId: Id }
/** An Inbox entry that summarises a batch of held-back notifications. Counts and ids only: no message text is copied. */
export interface DigestEntry { id: Id; periodStart: string; periodEnd: string; total: number; items: DigestItem[]; readAt: string | null; createdAt: string }

// ---------------------------------------------------------------------------------------------------------------------
// Server structure export / import
// ---------------------------------------------------------------------------------------------------------------------

export const SERVER_EXPORT_FORMAT = 'jorcord-server-export';
export type ExportChannelType = 'text' | 'voice' | 'announcement' | 'stage' | 'forum' | 'media' | 'category';
export interface ExportRole {
  key: string; name: string; color: number; hoist: boolean; mentionable: boolean; position: number;
  /** Jorcord permission bits (decimal string). */ permissions: string;
  /** The same permissions by name, for humans and other tools. */ permissionNames: string[];
  /** The same permissions as Discord's bit positions (decimal string), informational. */ discordPermissions: string;
}
export interface ExportChannel {
  key: string; type: ExportChannelType; name: string; topic: string | null; nsfw: boolean; slowmode: number; bitrate: number | null; userLimit: number | null;
  position: number; parentKey: string | null; overwrites: { target: string; allow: string; deny: string }[];
}
export interface ExportEmoji { name: string; animated: boolean; /** path inside the zip, when the export carries the image */ file: string | null }
export interface ServerExport {
  format: typeof SERVER_EXPORT_FORMAT; version: 1; exportedAt: string;
  source: { name: string; description: string | null };
  settings: { verificationLevel: number; explicitFilter: number; defaultNotifications: 'all' | 'mentions'; everyonePermissions: string };
  roles: ExportRole[]; channels: ExportChannel[]; emoji: ExportEmoji[];
}
/** Result of an import (or of a dry run, with `dryRun: true` and nothing created). */
export interface ImportReport {
  dryRun: boolean; source: 'jorcord' | 'discord-template';
  created: { roles: number; categories: number; channels: number; emoji: number };
  warnings: string[];
}
export const IMPORT_LIMITS = { jsonBytes: 2 * 1024 * 1024, zipBytes: 8 * 1024 * 1024, emojiBytes: 512 * 1024, roles: 250, channels: 500, emoji: 250, entries: 600 } as const;

const DISCORD_NAMES = (Object.keys(DISCORD_PERMISSION_BITS) as PermName[]).filter((n) => n !== 'RECORD_VOICE'); // Discord has no such permission
/** Discord permission integer -> Jorcord bits, through DISCORD_PERMISSION_BITS. Bits Jorcord has no equivalent for are dropped. */
export function discordToJorcordPerms(discord: bigint): bigint {
  let out = 0n;
  for (const n of DISCORD_NAMES) if ((discord >> BigInt(DISCORD_PERMISSION_BITS[n])) & 1n) out |= Perm[n];
  return out;
}
/** Jorcord bits -> the Discord permission integer (informational; RECORD_VOICE has no Discord equivalent). */
export function jorcordToDiscordPerms(perms: bigint): bigint {
  let out = 0n;
  for (const n of DISCORD_NAMES) if ((perms & Perm[n]) === Perm[n]) out |= 1n << BigInt(DISCORD_PERMISSION_BITS[n]);
  return out;
}
export const permissionNames = (perms: bigint): PermName[] => (Object.keys(Perm) as PermName[]).filter((n) => (perms & Perm[n]) === Perm[n]);
