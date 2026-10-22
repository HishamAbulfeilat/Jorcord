import { snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';

export type ChallengePurpose = 'register' | 'login' | 'mfa' | 'mfa_ticket';
const CHALLENGE_TTL_MS = 5 * 60_000, TICKET_TTL_MS = 5 * 60_000;

export const rpOf = (ctx: Ctx) => ({ rpID: ctx.config.webauthn.rpId, rpName: ctx.config.webauthn.rpName, origins: ctx.config.webauthn.origins });

/** Stores a challenge (base64url string from the library). Expired rows are pruned opportunistically. */
export async function storeChallenge(ctx: Ctx, challenge: string, purpose: ChallengePurpose, userId: string | null, ref: string | null = null, ttlMs = CHALLENGE_TTL_MS) {
  await ctx.db.query('DELETE FROM webauthn_challenges WHERE expires_at < now()');
  await ctx.db.query('INSERT INTO webauthn_challenges (id, challenge, purpose, user_id, ref, expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [snowflake(), challenge, purpose, userId, ref, new Date(Date.now() + ttlMs)]);
}

/** Atomically consumes a challenge: single use, purpose-bound, unexpired. Returns the row or null. */
export async function consumeChallenge(ctx: Ctx, challenge: string, purpose: ChallengePurpose): Promise<{ user_id: string | null; ref: string | null } | null> {
  const rows = await ctx.db.query('DELETE FROM webauthn_challenges WHERE challenge = $1 AND purpose = $2 AND expires_at > now() RETURNING user_id, ref', [challenge, purpose]);
  return rows[0] ?? null;
}

/** The challenge a browser signed is echoed inside clientDataJSON; read it to find the stored row (the library re-verifies everything). */
export function challengeFromResponse(response: any): string | null {
  try {
    const json = JSON.parse(Buffer.from(String(response?.response?.clientDataJSON ?? ''), 'base64url').toString('utf8'));
    return typeof json.challenge === 'string' && json.challenge.length <= 256 ? json.challenge : null;
  } catch { return null; }
}

export const ticketTtlMs = TICKET_TTL_MS;

export const bad = (m = 'Passkey verification failed') => new ApiError(400, 'PASSKEY_FAILED', m);

export function passkeyDTO(r: any) {
  return {
    id: r.id as string, name: r.name as string, createdAt: new Date(r.created_at).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    deviceType: (r.device_type ?? null) as string | null, backedUp: !!r.backed_up, transports: (r.transports ?? []) as string[],
  };
}
