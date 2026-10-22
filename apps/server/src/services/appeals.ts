import { Perm, has, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { iso } from '../lib/ids';
import { actionEmail } from './emailTemplates';

export const APPEAL_MIN = 10, APPEAL_MAX = 1000;

export interface AppealRow { id: string; guild_id: string; user_id: string; ban_created_at: Date | string; message: string; status: string; decided_by: string | null; decision_reason: string | null; decided_at: Date | string | null; created_at: Date | string }

/** What the appellant sees: their own text plus the verdict. Moderator identity is not exposed. */
export const ownAppealDTO = (r: AppealRow) => ({ id: r.id, status: r.status as 'pending' | 'approved' | 'denied', message: r.message, createdAt: iso(r.created_at)!, decidedAt: iso(r.decided_at), decisionReason: r.decision_reason ?? null });

/** Ids of everyone who can act on appeals in a guild (owner, administrators, BAN_MEMBERS holders). Used for content-free notifications. */
export async function appealModeratorIds(ctx: Ctx, guildId: string): Promise<string[]> {
  const [g] = await ctx.db.query('SELECT owner_id FROM guilds WHERE id = $1', [guildId]);
  const roles = await ctx.db.query('SELECT id, permissions FROM roles WHERE guild_id = $1', [guildId]);
  const modRoles = roles.filter((r) => { const p = BigInt(r.permissions); return has(p, Perm.ADMINISTRATOR) || has(p, Perm.BAN_MEMBERS); }).map((r) => r.id as string);
  const ids = new Set<string>(g ? [g.owner_id] : []);
  if (modRoles.length) {
    const rows = await ctx.db.query('SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[]) LIMIT 200', [guildId, modRoles]);
    rows.forEach((r) => ids.add(r.user_id));
  }
  return [...ids];
}

/** Notification hooks. Gateway events never carry appeal text; the decision email is the only place the reason leaves the app. */
export async function notifyAppealCreated(ctx: Ctx, appealId: string, guildId: string) {
  const mods = await appealModeratorIds(ctx, guildId);
  if (mods.length) await ctx.hub.toUsers(mods, 'BAN_APPEAL_CREATE', { id: appealId, guildId });
}
export async function notifyAppealDecided(ctx: Ctx, a: AppealRow, guildName: string) {
  await ctx.hub.toUser(a.user_id, 'BAN_APPEAL_UPDATE', { id: a.id, guildId: a.guild_id, status: a.status as 'approved' | 'denied', decisionReason: a.decision_reason ?? null });
  const [u] = await ctx.db.query('SELECT email FROM users WHERE id = $1 AND deleted_at IS NULL', [a.user_id]);
  if (!u?.email) return;
  const approved = a.status === 'approved';
  const m = actionEmail({
    subject: `Your ban appeal for ${guildName} was ${approved ? 'approved' : 'denied'}`,
    heading: approved ? 'Your ban appeal was approved' : 'Your ban appeal was denied',
    paragraphs: [
      approved ? `The moderators of "${guildName}" lifted your ban. You can rejoin with a new invite.` : `The moderators of "${guildName}" reviewed your appeal and kept the ban in place. Each ban can be appealed once.`,
      ...(a.decision_reason ? [`Moderator note: ${a.decision_reason}`] : []),
    ],
  });
  await ctx.mailer.send({ to: u.email, ...m });
}

export const newAppealId = () => snowflake();
