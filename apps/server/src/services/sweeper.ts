import type { Ctx } from '../ctx';
import { finalizeDuePolls } from './polls';
import { sweepEvents } from './scheduled';
import { endEmptyStages, sweepHandQueue } from './stage';
import { sweepPrioritySpeakers } from './voice';
import { channelsDTO } from './serializers';
import { fireDueReminders } from './reminders';
import { syncGuild } from './linkedroles';
import { fireDueBotReminders } from './sysbots';
import { sweepUnattachedUploads } from './files';
import { pollStreamFeeds } from './streamfeeds';
import { expireExports } from './dataExport';
import { sendDueScheduledMessages } from './scheduledMessages';
import { sweepAccountDeletions } from './accountDeletion';

/** Thread auto-archive: no activity for `auto_archive_minutes` -> archived (THREAD_UPDATE). Atomic, so multi-node safe. */
export async function archiveIdleThreads(ctx: Ctx) {
  const rows = await ctx.db.query(
    `UPDATE channels SET archived = true WHERE type = 'thread' AND NOT archived AND activity_at + (auto_archive_minutes * interval '1 minute') <= now() RETURNING *`);
  if (!rows.length) return 0;
  for (const dto of await channelsDTO(ctx, rows)) await ctx.hub.toChannel(dto.id, 'THREAD_UPDATE', dto);
  return rows.length;
}

/** Server-side custom status expiry: clear the row and tell everyone who can see the user. */
export async function expireStatuses(ctx: Ctx) {
  const rows = await ctx.db.query(`UPDATE users SET custom_status = NULL WHERE custom_status ? 'expiresAt' AND (custom_status->>'expiresAt')::timestamptz <= now() RETURNING id`);
  for (const r of rows) await ctx.hub.broadcastPresence(r.id).catch(() => {});
  return rows.length;
}

async function pruneInteractions(ctx: Ctx) {
  await ctx.db.query(`DELETE FROM interactions WHERE expires_at < now() - interval '1 hour'`);
  await ctx.db.query(`DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 hour'`);
  await ctx.db.query(`DELETE FROM oauth_tokens WHERE expires_at < now()`);
  await ctx.db.query(`DELETE FROM remote_auth WHERE expires_at < now() - interval '10 minutes'`);
  await ctx.db.query(`DELETE FROM dm_request_events WHERE created_at < now() - interval '2 days'`);
}

/**
 * Account/server age criteria become true with the passage of time and nothing else happens at that moment, so every 10 minutes a slice (300 members per
 * server, rotating) of servers that have such linked roles is re-evaluated.
 */
const ageCursor = new Map<string, string>(); let lastAgePass = 0;
export async function sweepLinkedRoles(ctx: Ctx, force = false) {
  if (!force && Date.now() - lastAgePass < 600_000) return 0;
  lastAgePass = Date.now();
  const guilds = await ctx.db.query(`SELECT DISTINCT guild_id FROM linked_roles WHERE criteria @> '[{"type":"account_age_days"}]'::jsonb OR criteria @> '[{"type":"join_age_days"}]'::jsonb`);
  let changed = 0;
  for (const g of guilds) {
    const r = await syncGuild(ctx, g.guild_id, 300, ageCursor.get(g.guild_id) ?? '');
    if (r.next) ageCursor.set(g.guild_id, r.next); else ageCursor.delete(g.guild_id);
    changed += r.changed;
  }
  return changed;
}

/** One pass of every time-driven lifecycle. Exposed for tests; the server runs it on an interval (config.sweepIntervalMs). */
export async function runSweeps(ctx: Ctx) {
  const step = async (name: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { ctx.log.warn({ err: e, step: name }, 'sweep step failed'); } };
  await step('polls', () => finalizeDuePolls(ctx));
  await step('events', () => sweepEvents(ctx));
  await step('stages', () => endEmptyStages(ctx));
  await step('stage-hands', () => sweepHandQueue(ctx));
  await step('priority-speakers', () => sweepPrioritySpeakers(ctx));
  await step('threads', () => archiveIdleThreads(ctx));
  await step('statuses', () => expireStatuses(ctx));
  await step('reminders', () => fireDueReminders(ctx));
  await step('bot-reminders', () => fireDueBotReminders(ctx));
  await step('linked-roles', () => sweepLinkedRoles(ctx));
  await step('interactions', () => pruneInteractions(ctx));
  await step('uploads', () => sweepUnattachedUploads(ctx));
  await step('stream-feeds', () => pollStreamFeeds(ctx));
  await step('exports', () => expireExports(ctx));
  await step('scheduled-messages', () => sendDueScheduledMessages(ctx));
  await step('account-deletions', () => sweepAccountDeletions(ctx));
}
