import type { StageBlock, StageInstance, StageQueueEntry } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { audit } from './guilds';

export const stageDTO = (r: any): StageInstance => ({ id: r.id, guildId: r.guild_id, channelId: r.channel_id, topic: r.topic, privacyLevel: 2, scheduledEventId: r.scheduled_event_id ?? null, createdAt: iso(r.created_at)! });

/** Starts a stage instance (one per stage channel). Returns null when one is already live. */
export async function startStage(ctx: Ctx, o: { id: string; guildId: string; channelId: string; topic: string; createdBy: string; scheduledEventId?: string | null }): Promise<StageInstance | null> {
  const rows = await ctx.db.query(
    'INSERT INTO stage_instances (id, guild_id, channel_id, topic, scheduled_event_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (channel_id) DO NOTHING RETURNING *',
    [o.id, o.guildId, o.channelId, o.topic, o.scheduledEventId ?? null, o.createdBy]);
  if (!rows.length) return null;
  const dto = stageDTO(rows[0]);
  await ctx.hub.toChannel(o.channelId, 'STAGE_INSTANCE_CREATE', dto);
  await audit(ctx, o.guildId, o.createdBy, 'STAGE_INSTANCE_CREATE', o.id, { channelId: o.channelId, topic: o.topic });
  return dto;
}

export async function endStage(ctx: Ctx, channelId: string, actorId: string): Promise<StageInstance | null> {
  const rows = await ctx.db.query('DELETE FROM stage_instances WHERE channel_id = $1 RETURNING *', [channelId]);
  if (!rows.length) return null;
  const hadHands = (await ctx.db.query('DELETE FROM stage_hand_queue WHERE channel_id = $1 RETURNING user_id', [channelId])).length > 0;
  await ctx.db.query('DELETE FROM stage_speaker_blocks WHERE channel_id = $1', [channelId]);
  if (hadHands) await ctx.hub.toChannel(channelId, 'STAGE_QUEUE_UPDATE', { channelId, queue: [] });
  const dto = stageDTO(rows[0]);
  await ctx.hub.toChannel(channelId, 'STAGE_INSTANCE_DELETE', dto);
  await audit(ctx, dto.guildId, actorId, 'STAGE_INSTANCE_DELETE', dto.id, { channelId, topic: dto.topic });
  return dto;
}

/** Ends instances nobody is in anymore (older than 60s, to give the host time to join). */
export async function endEmptyStages(ctx: Ctx) {
  const rows = await ctx.db.query(`SELECT channel_id, created_by FROM stage_instances WHERE created_at < now() - interval '60 seconds'`);
  if (!rows.length) return 0;
  const occupied = new Set((await ctx.voice.all()).map((s) => s.channelId).filter(Boolean));
  let n = 0;
  for (const r of rows) if (!occupied.has(r.channel_id)) { await endStage(ctx, r.channel_id, r.created_by); n++; }
  return n;
}

// ---------- raised-hand queue (persisted) ----------
/** A hand stays in the queue this long after its owner left the stage (a reconnect restores the original place). */
export const HAND_GRACE_SECONDS = 120;

/** The queue, first come first served. Hands of members who are away (left_at set) are not part of it. */
export async function listHandQueue(ctx: Ctx, channelId: string): Promise<StageQueueEntry[]> {
  const rows = await ctx.db.query('SELECT user_id, anonymous, raised_at FROM stage_hand_queue WHERE channel_id = $1 AND left_at IS NULL ORDER BY seq', [channelId]);
  return rows.map((r: any, i: number) => ({ userId: r.user_id, anonymous: !!r.anonymous, requestToSpeakAt: iso(r.raised_at)!, position: i + 1 }));
}

/** The queue as everybody may see it: anonymous hands lose their identity. */
export const publicQueue = (q: StageQueueEntry[]): StageQueueEntry[] => q.map((e) => (e.anonymous ? { ...e, userId: null } : e));

/** Tell the channel the queue changed, and every member in line (plus `userId`, who may just have left it) where they stand now. */
export async function publishHandQueue(ctx: Ctx, channelId: string, userId?: string, queue?: StageQueueEntry[]) {
  const q = queue ?? await listHandQueue(ctx, channelId);
  await ctx.hub.toChannel(channelId, 'STAGE_QUEUE_UPDATE', { channelId, queue: publicQueue(q) });
  // everybody in line learns their (possibly moved) place, plus the member who just raised / lowered / lost their hand
  const owners = new Set<string>(q.map((e) => e.userId!)); if (userId) owners.add(userId);
  for (const id of owners) {
    const mine = q.find((e) => e.userId === id);
    await ctx.hub.toUser(id, 'STAGE_HAND_UPDATE', { channelId, raised: !!mine, anonymous: !!mine?.anonymous, position: mine?.position ?? null });
  }
}

/** Puts a hand in the queue. Raising again keeps the original place (and just updates `anonymous`). Returns the raise time. */
export async function raiseHand(ctx: Ctx, channelId: string, userId: string, anonymous: boolean): Promise<string> {
  const [r] = await ctx.db.query(
    `INSERT INTO stage_hand_queue (channel_id, user_id, anonymous) VALUES ($1,$2,$3)
     ON CONFLICT (channel_id, user_id) DO UPDATE SET left_at = NULL, anonymous = EXCLUDED.anonymous RETURNING raised_at`, [channelId, userId, anonymous]);
  return iso(r.raised_at)!;
}

/** Removes a hand. Returns whether there was one. */
export async function lowerHand(ctx: Ctx, channelId: string, userId: string): Promise<boolean> {
  return (await ctx.db.query('DELETE FROM stage_hand_queue WHERE channel_id = $1 AND user_id = $2 RETURNING 1', [channelId, userId])).length > 0;
}

/** The member left the stage: keep their place for HAND_GRACE_SECONDS. Returns whether they had a hand up. */
export async function markHandAway(ctx: Ctx, channelId: string, userId: string): Promise<boolean> {
  return (await ctx.db.query('UPDATE stage_hand_queue SET left_at = now() WHERE channel_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING 1', [channelId, userId])).length > 0;
}

/** The member came back within the grace period: their hand (and place in line) is restored. */
export async function restoreHand(ctx: Ctx, channelId: string, userId: string): Promise<{ raisedAt: string; anonymous: boolean } | null> {
  const [r] = await ctx.db.query(
    `UPDATE stage_hand_queue SET left_at = NULL WHERE channel_id = $1 AND user_id = $2 AND (left_at IS NULL OR left_at > now() - ($3 || ' seconds')::interval) RETURNING raised_at, anonymous`,
    [channelId, userId, String(HAND_GRACE_SECONDS)]);
  return r ? { raisedAt: iso(r.raised_at)!, anonymous: !!r.anonymous } : null;
}

/** Sweeper: park hands whose owner is no longer in the stage (e.g. after a server restart), drop hands that stayed away too long. */
export async function sweepHandQueue(ctx: Ctx) {
  const live = await ctx.db.query('SELECT channel_id, user_id FROM stage_hand_queue WHERE left_at IS NULL');
  const changed = new Set<string>();
  for (const r of live) {
    const st = await ctx.voice.get(r.user_id);
    if (st?.channelId !== r.channel_id && await markHandAway(ctx, r.channel_id, r.user_id)) changed.add(r.channel_id);
  }
  for (const r of await ctx.db.query(`DELETE FROM stage_hand_queue WHERE left_at < now() - ($1 || ' seconds')::interval RETURNING channel_id`, [String(HAND_GRACE_SECONDS)])) changed.add(r.channel_id);
  for (const ch of changed) await publishHandQueue(ctx, ch);
  return changed.size;
}

// ---------- speaker blocks ----------
export const blockDTO = (r: any): StageBlock => ({ userId: r.user_id, blockedBy: r.blocked_by, reason: r.reason ?? null, createdAt: iso(r.created_at)! });
export const listBlocks = async (ctx: Ctx, channelId: string) => (await ctx.db.query('SELECT * FROM stage_speaker_blocks WHERE channel_id = $1 ORDER BY created_at', [channelId])).map(blockDTO);

/**
 * Why `userId` may not speak on this stage, or null. Two reasons: a moderator blocked them here (`MODERATOR`), or the stage's host
 * and they have blocked each other (`HOST_BLOCKED`, either direction), which keeps a blocked user off the host's stage as a speaker.
 */
export async function speakerBlockReason(ctx: Ctx, channelId: string, userId: string): Promise<'MODERATOR' | 'HOST_BLOCKED' | null> {
  const [b] = await ctx.db.query('SELECT 1 AS x FROM stage_speaker_blocks WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
  if (b) return 'MODERATOR';
  const [h] = await ctx.db.query(
    `SELECT 1 AS x FROM stage_instances si JOIN relationships r ON r.type = 'blocked' AND ((r.user_id = si.created_by AND r.other_id = $2) OR (r.other_id = si.created_by AND r.user_id = $2))
     WHERE si.channel_id = $1 AND si.created_by <> $2 LIMIT 1`, [channelId, userId]);
  return h ? 'HOST_BLOCKED' : null;
}
