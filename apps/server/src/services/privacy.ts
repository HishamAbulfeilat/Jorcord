import type { Privacy } from '@jorcord/shared';
import { DEFAULT_PRIVACY } from '@jorcord/shared';
import type { Ctx } from '../ctx';

/** Stored JSON merged over the defaults, so older rows and partial updates always yield a complete object. */
export function normalizePrivacy(raw: unknown): Privacy {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Privacy>;
  const fr: Partial<Privacy['friendRequests']> = r.friendRequests && typeof r.friendRequests === 'object' ? r.friendRequests : {};
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    allowDmsFromServerMembers: b(r.allowDmsFromServerMembers, DEFAULT_PRIVACY.allowDmsFromServerMembers),
    messageRequests: b(r.messageRequests, DEFAULT_PRIVACY.messageRequests),
    showActivity: b(r.showActivity, DEFAULT_PRIVACY.showActivity),
    friendRequests: {
      everyone: b(fr.everyone, DEFAULT_PRIVACY.friendRequests.everyone),
      friendsOfFriends: b(fr.friendsOfFriends, DEFAULT_PRIVACY.friendRequests.friendsOfFriends),
      serverMembers: b(fr.serverMembers, DEFAULT_PRIVACY.friendRequests.serverMembers),
    },
  };
}

export async function privacyOf(ctx: Ctx, userId: string): Promise<Privacy> {
  const [r] = await ctx.db.query('SELECT privacy FROM users WHERE id = $1', [userId]);
  return normalizePrivacy(r?.privacy);
}

/** May `from` send a friend request to `to`, given `to`'s "who can send me friend requests" setting? */
export async function canSendFriendRequest(ctx: Ctx, from: string, to: string): Promise<boolean> {
  const fr = (await privacyOf(ctx, to)).friendRequests;
  if (fr.everyone) return true;
  if (fr.friendsOfFriends) {
    const [x] = await ctx.db.query(`SELECT 1 AS x FROM relationships a JOIN relationships b ON b.other_id = a.other_id AND b.user_id = $2 AND b.type = 'friend' WHERE a.user_id = $1 AND a.type = 'friend' LIMIT 1`, [from, to]);
    if (x) return true;
  }
  if (fr.serverMembers) {
    const [x] = await ctx.db.query('SELECT 1 AS x FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1', [from, to]);
    if (x) return true;
  }
  return false;
}
