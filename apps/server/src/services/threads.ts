import type { Channel } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { channelDTO, channelsDTO } from './serializers';

/** Adds `userId` to a thread's member list. Emits THREAD_MEMBERS_UPDATE when the membership is new; a private thread also appears (THREAD_CREATE) for the new member. */
export async function joinThread(ctx: Ctx, thread: { id: string; guild_id: string; thread_private?: boolean }, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('INSERT INTO thread_members (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [thread.id, userId]);
  if (!rows.length) return false;
  if (thread.thread_private) { // the invitee could not see the thread before: hand it over
    const [row] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [thread.id]);
    if (row) await ctx.hub.toUsers([userId], 'THREAD_CREATE', await channelDTO(ctx, row));
  }
  await ctx.hub.toChannel(thread.id, 'THREAD_MEMBERS_UPDATE', { id: thread.id, guildId: thread.guild_id, addedUserIds: [userId], removedUserIds: [] });
  return true;
}

export async function leaveThread(ctx: Ctx, thread: { id: string; guild_id: string; parent_id?: string | null; thread_private?: boolean }, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('DELETE FROM thread_members WHERE thread_id = $1 AND user_id = $2 RETURNING user_id', [thread.id, userId]);
  if (!rows.length) return false;
  await ctx.hub.toChannel(thread.id, 'THREAD_MEMBERS_UPDATE', { id: thread.id, guildId: thread.guild_id, addedUserIds: [], removedUserIds: [userId] });
  if (thread.thread_private) await ctx.hub.toUsers([userId], 'THREAD_DELETE', { id: thread.id, guildId: thread.guild_id, parentId: thread.parent_id ?? null });
  return true;
}

/** Builds a THREAD_LIST_SYNC payload: the active threads (under `channelIds`, or the whole guild) the user can see plus their memberships. */
export async function threadListSync(ctx: Ctx, guildId: string, threadRows: any[], userId: string, channelIds?: string[]) {
  const rows = channelIds ? threadRows.filter((t) => channelIds.includes(t.parent_id)) : threadRows;
  const threads: Channel[] = await channelsDTO(ctx, rows);
  const members = !rows.length ? [] : (await ctx.db.query('SELECT thread_id, user_id, joined_at FROM thread_members WHERE user_id = $2 AND thread_id = ANY($1::text[])', [rows.map((r) => r.id), userId]))
    .map((r) => ({ threadId: r.thread_id as string, userId: r.user_id as string, joinedAt: new Date(r.joined_at).toISOString() }));
  return { guildId, ...(channelIds ? { channelIds } : {}), threads, members };
}
