import type { Ctx } from '../ctx';

/** Adds `userId` to a thread's member list. Emits THREAD_MEMBERS_UPDATE when the membership is new. */
export async function joinThread(ctx: Ctx, thread: { id: string; guild_id: string }, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('INSERT INTO thread_members (thread_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING user_id', [thread.id, userId]);
  if (!rows.length) return false;
  await ctx.hub.toChannel(thread.id, 'THREAD_MEMBERS_UPDATE', { id: thread.id, guildId: thread.guild_id, addedUserIds: [userId], removedUserIds: [] });
  return true;
}

export async function leaveThread(ctx: Ctx, thread: { id: string; guild_id: string }, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('DELETE FROM thread_members WHERE thread_id = $1 AND user_id = $2 RETURNING user_id', [thread.id, userId]);
  if (!rows.length) return false;
  await ctx.hub.toChannel(thread.id, 'THREAD_MEMBERS_UPDATE', { id: thread.id, guildId: thread.guild_id, addedUserIds: [], removedUserIds: [userId] });
  return true;
}
