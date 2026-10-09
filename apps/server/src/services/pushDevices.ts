import type { Ctx } from '../ctx';

/** Forget the push devices registered by the given (now revoked) auth sessions, so a signed-out device stops getting notifications. */
export async function dropPushDevices(ctx: Ctx, sessionIds: string[]) {
  if (!sessionIds.length) return;
  await ctx.db.query('DELETE FROM push_devices WHERE session_id = ANY($1::text[])', [sessionIds]);
}
