import type { Ctx } from '../ctx';
import { badRequest, notFound } from '../errors';
import { getUser, usersByIds } from './serializers';

/** Which of `ownerIds` ignore `authorId`. Ignoring never blocks delivery; it only silences pings (clients hide the text). */
export async function ignorersOf(ctx: Ctx, authorId: string, ownerIds: string[]): Promise<string[]> {
  if (!ownerIds.length) return [];
  return (await ctx.db.query('SELECT user_id FROM ignored_users WHERE other_id = $1 AND user_id = ANY($2::text[])', [authorId, ownerIds])).map((r) => r.user_id as string);
}

export async function listIgnored(ctx: Ctx, userId: string) {
  const rows = await ctx.db.query('SELECT other_id FROM ignored_users WHERE user_id = $1 ORDER BY created_at', [userId]);
  const users = await usersByIds(ctx, rows.map((r) => r.other_id));
  return rows.map((r) => users.get(r.other_id)).filter((u): u is NonNullable<typeof u> => !!u);
}

export async function setIgnored(ctx: Ctx, userId: string, otherId: string, ignored: boolean) {
  if (otherId === userId) throw badRequest('Cannot target yourself');
  if (ignored) {
    const target = await getUser(ctx, otherId);
    if (!target) throw notFound('User');
    const [n] = await ctx.db.query('SELECT count(*)::int AS n FROM ignored_users WHERE user_id = $1', [userId]);
    if (n.n >= 500) throw badRequest('You can ignore at most 500 people');
    await ctx.db.query('INSERT INTO ignored_users (user_id, other_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, otherId]);
  } else await ctx.db.query('DELETE FROM ignored_users WHERE user_id = $1 AND other_id = $2', [userId, otherId]);
  await ctx.hub.toUser(userId, 'IGNORE_UPDATE', { userId: otherId, ignored });
}
