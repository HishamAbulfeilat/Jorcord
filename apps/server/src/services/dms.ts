import type { Ctx } from '../ctx';
import { ApiError, forbidden, notFound } from '../errors';
import { assertServerAllowsDm, sharedContext } from './memberDms';
import { privacyOf } from './privacy';
import { channelDTO } from './serializers';
import { clearVoiceState } from './voice';

export const MAX_GROUP_DM = 10;

const participantIds = async (ctx: Ctx, channelId: string) =>
  (await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 ORDER BY joined_at, user_id', [channelId])).map((r) => r.user_id as string);

/** Adds a user to a group DM on behalf of `actorId` (already verified to be a participant). */
export async function addGroupRecipient(ctx: Ctx, channel: any, actorId: string, userId: string) {
  const current = await participantIds(ctx, channel.id);
  if (current.includes(userId)) return channelDTO(ctx, channel); // idempotent
  if (current.length >= MAX_GROUP_DM) throw new ApiError(400, 'MAX_RECIPIENTS', `A group DM holds at most ${MAX_GROUP_DM} people`);
  const [u] = await ctx.db.query('SELECT id FROM users WHERE id = $1 AND NOT bot AND deleted_at IS NULL', [userId]);
  if (!u) throw notFound('User');
  const [blk] = await ctx.db.query(
    `SELECT 1 AS x FROM relationships WHERE type = 'blocked' AND ((user_id = $1 AND other_id = ANY($2::text[])) OR (other_id = $1 AND user_id = ANY($2::text[]))) LIMIT 1`, [userId, current]);
  if (blk) throw forbidden('Cannot add this user', 'BLOCKED');
  const [isFriend] = await ctx.db.query(`SELECT 1 AS x FROM relationships WHERE user_id = $1 AND other_id = $2 AND type = 'friend'`, [actorId, userId]);
  if (!isFriend) { // same anti-spam rule as creating a DM: friends or a shared server (that lets its members DM each other) with the person adding
    const sc = await sharedContext(ctx, actorId, userId);
    if (!sc.shared) throw forbidden('You need to be friends or share a server with this user', 'NO_SHARED_CONTEXT');
    assertServerAllowsDm(sc);
  }
  if (!isFriend && !(await privacyOf(ctx, userId)).allowDmsFromServerMembers) throw forbidden('This user does not accept direct messages from server members', 'DM_DISABLED');
  await ctx.db.query('INSERT INTO dm_participants (channel_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [channel.id, userId]);
  await ctx.pcache.invalidate({ k: 'dm', channelId: channel.id });
  const dto = await channelDTO(ctx, channel);
  await ctx.hub.toUser(userId, 'CHANNEL_CREATE', dto);
  await ctx.hub.toUsers(current, 'CHANNEL_UPDATE', dto);
  return dto;
}

/** Removes a participant (leave or kick). Hands ownership on if the owner leaves; deletes the channel when empty. */
export async function removeGroupRecipient(ctx: Ctx, channel: any, userId: string) {
  const removed = await ctx.db.query('DELETE FROM dm_participants WHERE channel_id = $1 AND user_id = $2 RETURNING user_id', [channel.id, userId]);
  if (!removed.length) return;
  await ctx.pcache.invalidate({ k: 'dm', channelId: channel.id });
  const st = await ctx.voice.get(userId);
  if (st?.channelId === channel.id) await clearVoiceState(ctx, userId);
  await ctx.hub.toUser(userId, 'CHANNEL_DELETE', { id: channel.id, guildId: null });
  const left = await participantIds(ctx, channel.id);
  if (!left.length) { await ctx.db.query('DELETE FROM channels WHERE id = $1', [channel.id]); await ctx.pcache.invalidate({ k: 'dm', channelId: channel.id }); return; }
  if (channel.owner_id === userId) await ctx.db.query('UPDATE channels SET owner_id = $2 WHERE id = $1', [channel.id, left[0]]);
  const [fresh] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [channel.id]);
  await ctx.hub.toUsers(left, 'CHANNEL_UPDATE', await channelDTO(ctx, fresh));
}
