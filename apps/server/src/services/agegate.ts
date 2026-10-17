import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import type { Access } from './perms';

export const ageConfirmed = async (ctx: Ctx, userId: string): Promise<boolean> =>
  !!(await ctx.db.query('SELECT age_confirmed_at FROM users WHERE id = $1', [userId]))[0]?.age_confirmed_at;

/** Age-restricted (nsfw) server channels need the caller's 18+ confirmation (users.age_confirmed_at). Bots and DMs are exempt. */
export async function ageGate(ctx: Ctx, userId: string, isBot: boolean, a: Pick<Access, 'channel' | 'permChannel'>) {
  const nsfw = !!(a.permChannel?.nsfw ?? a.channel.nsfw);
  if (!nsfw || !a.channel.guild_id || isBot) return;
  if (!(await ageConfirmed(ctx, userId))) throw new ApiError(403, 'AGE_RESTRICTED', 'This channel is age-restricted. Confirm that you are 18 or older to view it.');
}
