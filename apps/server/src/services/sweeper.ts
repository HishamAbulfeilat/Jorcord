import type { Ctx } from '../ctx';
import { finalizeDuePolls } from './polls';
import { sweepEvents } from './scheduled';
import { endEmptyStages } from './stage';
import { channelsDTO } from './serializers';

/** Thread auto-archive: no activity for `auto_archive_minutes` -> archived (THREAD_UPDATE). Atomic, so multi-node safe. */
export async function archiveIdleThreads(ctx: Ctx) {
  const rows = await ctx.db.query(
    `UPDATE channels SET archived = true WHERE type = 'thread' AND NOT archived AND activity_at + (auto_archive_minutes * interval '1 minute') <= now() RETURNING *`);
  if (!rows.length) return 0;
  for (const dto of await channelsDTO(ctx, rows)) await ctx.hub.toChannel(dto.id, 'THREAD_UPDATE', dto);
  return rows.length;
}

async function pruneInteractions(ctx: Ctx) {
  await ctx.db.query(`DELETE FROM interactions WHERE expires_at < now() - interval '1 hour'`);
  await ctx.db.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`);
  await ctx.db.query(`DELETE FROM oauth_tokens WHERE expires_at < now()`);
}

/** One pass of every time-driven lifecycle. Exposed for tests; the server runs it on an interval (config.sweepIntervalMs). */
export async function runSweeps(ctx: Ctx) {
  const step = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { ctx.log.warn({ err: e, step: name }, 'sweep step failed'); } };
  await step('polls', () => finalizeDuePolls(ctx));
  await step('events', () => sweepEvents(ctx));
  await step('stages', () => endEmptyStages(ctx));
  await step('threads', () => archiveIdleThreads(ctx));
  await step('interactions', () => pruneInteractions(ctx));
}
