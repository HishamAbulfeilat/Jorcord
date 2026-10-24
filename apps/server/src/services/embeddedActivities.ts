import { activityOrigin, Perm, has } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { forbidden } from '../errors';

let cache: { at: number; origins: string[] } | null = null;
const TTL_MS = 60_000;

/** Distinct https origins of every registered embedded activity (for the web app's `frame-src`). Cached for a minute per process. */
export async function activityOriginsCached(db: Ctx['db']): Promise<string[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.origins;
  const rows = await db.query('SELECT DISTINCT activity_url FROM applications WHERE activity_url IS NOT NULL LIMIT 500');
  const origins = [...new Set(rows.map((r) => activityOrigin(r.activity_url)).filter((o): o is string => !!o))];
  cache = { at: Date.now(), origins };
  return origins;
}
export const resetActivityOriginCache = () => { cache = null; };

/**
 * Launching a third-party activity needs the USE_EMBEDDED_ACTIVITIES permission when this build has that bit
 * (permission package B adds it); without the bit the safe fallback is being allowed to connect to the voice channel,
 * which `requireInCall` already proves, plus the ability to send messages (an activity can act on the user's behalf in the call).
 */
export function assertMayLaunchEmbedded(perms: bigint) {
  const bit = (Perm as Record<string, bigint>).USE_EMBEDDED_ACTIVITIES;
  if (bit !== undefined) { if (!has(perms, bit)) throw forbidden('You need the Use Activities permission to launch apps in this channel').num(50013); return; }
  if (!has(perms, Perm.CONNECT) || !has(perms, Perm.SEND_MESSAGES)) throw forbidden('You cannot launch apps in this channel').num(50013);
}
