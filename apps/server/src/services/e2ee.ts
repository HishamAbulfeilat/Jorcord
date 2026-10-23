import { createECDH } from 'node:crypto';
import { E2EE_MAX_ENVELOPE_CHARS, fromB64u, parseEnvelope, type E2eeDevice, type E2eeEnvelope } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { iso } from '../lib/ids';

/** A valid public key is the 65 byte uncompressed encoding of a point that really is on P-256 (an invalid-curve key would weaken the peer's ECDH). */
export function validatePublicKey(b64u: string): boolean {
  let raw: Uint8Array;
  try { raw = fromB64u(b64u); } catch { return false; }
  if (raw.length !== 65 || raw[0] !== 4) return false;
  try { const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(Buffer.from(raw)); return true; } catch { return false; }
}

export const deviceDTO = (r: any): E2eeDevice => ({ id: r.id, userId: r.user_id, publicKey: r.public_key, label: r.label ?? null, createdAt: iso(r.created_at)!, lastSeenAt: iso(r.last_seen_at), ...(r.revoked_at ? { revokedAt: iso(r.revoked_at) } : {}) });

export async function activeDevices(ctx: Ctx, userIds: string[], includeRevoked = false): Promise<E2eeDevice[]> {
  if (!userIds.length) return [];
  return (await ctx.db.query(`SELECT * FROM e2ee_devices WHERE user_id = ANY($1::text[]) ${includeRevoked ? '' : 'AND revoked_at IS NULL'} ORDER BY created_at, id`, [userIds])).map(deviceDTO);
}

/** Tells the user's own sessions and everybody they have a secret chat with that the device list changed (clients re-fetch and re-check the safety number). */
export async function announceDevices(ctx: Ctx, userId: string) {
  const peers = await ctx.db.query(
    `SELECT DISTINCT p2.user_id FROM dm_participants p1 JOIN channels c ON c.id = p1.channel_id AND c.encrypted JOIN dm_participants p2 ON p2.channel_id = c.id
      WHERE p1.user_id = $1 AND p2.user_id <> $1`, [userId]);
  await ctx.hub.toUsers([userId, ...peers.map((p) => p.user_id as string)], 'E2EE_DEVICES_UPDATE', { userId });
}

/**
 * What the server can and cannot check about a message in a secret chat. It cannot read it. It does insist on a well-formed envelope from one of the
 * author's own active devices that carries a wrap for at least one active device of every participant and for nobody else (so a client bug cannot
 * silently strand the recipient, and an envelope cannot smuggle plaintext in).
 */
export async function assertEncryptedPayload(ctx: Ctx, channel: { id: string }, authorId: string, content: string): Promise<E2eeEnvelope> {
  if (content.length > E2EE_MAX_ENVELOPE_CHARS) throw new ApiError(413, 'E2EE_TOO_LARGE', 'Encrypted message is too large');
  const env = parseEnvelope(content);
  if (!env) throw new ApiError(400, 'E2EE_REQUIRED', 'Messages in a secret chat must be end-to-end encrypted by the client');
  const parts = (await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [channel.id])).map((r) => r.user_id as string);
  const devices = await ctx.db.query('SELECT id, user_id FROM e2ee_devices WHERE user_id = ANY($1::text[]) AND revoked_at IS NULL', [parts]);
  const owner = new Map(devices.map((d) => [d.id as string, d.user_id as string]));
  if (owner.get(env.from) !== authorId) throw new ApiError(400, 'E2EE_BAD_DEVICE', 'The sending device is not one of your active devices');
  const covered = new Set<string>();
  for (const id of Object.keys(env.keys)) {
    const u = owner.get(id);
    if (!u) throw new ApiError(400, 'E2EE_UNKNOWN_DEVICE', 'The message is wrapped for a device that is not an active participant device', { deviceId: id });
    covered.add(u);
  }
  for (const p of parts) if (!covered.has(p)) throw new ApiError(400, 'E2EE_MISSING_RECIPIENT', 'The message is not wrapped for every participant', { userId: p });
  return env;
}

export const activeDeviceCount = async (ctx: Ctx, userId: string) =>
  ((await ctx.db.query('SELECT count(*)::int AS n FROM e2ee_devices WHERE user_id = $1 AND revoked_at IS NULL', [userId]))[0]?.n ?? 0) as number;
