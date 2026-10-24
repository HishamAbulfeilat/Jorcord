import { MASS_DM_DEFAULTS, linkWarnings, messageFingerprint, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';

/**
 * Mass-DM spam brake. It only looks at first contact: messages to someone who has never answered the sender and is not a friend
 * (message requests included). Established conversations are never touched.
 * A sender who sends near-identical text to many different strangers inside the window, or any text to a great many of them,
 * is limited: they cannot open new conversations or message unanswered strangers until `dm_limited_until` passes. The incident is logged for operators.
 */
export const MASS_DM = {
  ...MASS_DM_DEFAULTS,
  /** same (fingerprinted) text to this many different strangers */ sameTextRecipients: MASS_DM_DEFAULTS.maxRecipients,
  /** ...or this many when the text carries a suspicious link */ sameTextWithLinkRecipients: 3,
  /** any text to this many different strangers */ anyTextRecipients: 15,
};

const LIMIT_MESSAGE = 'You are sending too many messages to people who have not replied. New conversations are paused for a while.';

export async function assertNotDmLimited(ctx: Ctx, userId: string) {
  const [u] = await ctx.db.query('SELECT dm_limited_until FROM users WHERE id = $1', [userId]);
  if (u?.dm_limited_until && new Date(u.dm_limited_until).getTime() > Date.now()) throw new ApiError(403, 'DM_LIMITED', LIMIT_MESSAGE, { until: new Date(u.dm_limited_until).toISOString() });
}

/** Called before a message is stored in a 1:1 DM. Throws DM_LIMITED when the sender is limited or just tripped the detector. */
export async function guardFirstContact(ctx: Ctx, channel: any, authorId: string, content: string) {
  if (channel.type !== 'dm') return;
  const others = await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND user_id <> $2', [channel.id, authorId]);
  if (others.length !== 1) return;
  const recipient = others[0]!.user_id as string;
  const [answered] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE channel_id = $1 AND author_id <> $2 AND type IN (\'default\',\'reply\') LIMIT 1', [channel.id, authorId]);
  if (answered) return; // a real conversation
  const [rel] = await ctx.db.query(`SELECT 1 AS x FROM relationships WHERE user_id = $1 AND other_id = $2 AND type = 'friend'`, [authorId, recipient]);
  if (rel) return;
  const [author] = await ctx.db.query('SELECT bot, dm_limited_until FROM users WHERE id = $1', [authorId]);
  if (!author || author.bot) return;
  if (author.dm_limited_until && new Date(author.dm_limited_until).getTime() > Date.now()) await assertNotDmLimited(ctx, authorId);

  const fp = messageFingerprint(content);
  if (fp.length < 3) return; // attachments/stickers only: nothing to compare
  const hasLink = linkWarnings(content).length > 0;
  const win = MASS_DM.windowMinutes;
  const [dupe] = await ctx.db.query(`SELECT 1 AS x FROM dm_request_events WHERE sender_id = $1 AND recipient_id = $2 AND fingerprint = $3 AND created_at > now() - ($4::int * interval '1 minute')`, [authorId, recipient, fp, win]);
  if (!dupe) await ctx.db.query('INSERT INTO dm_request_events (id, sender_id, recipient_id, fingerprint, has_link) VALUES ($1,$2,$3,$4,$5)', [snowflake(), authorId, recipient, fp, hasLink]);
  if (Math.random() < 0.02) await ctx.db.query(`DELETE FROM dm_request_events WHERE created_at < now() - interval '2 days'`);
  const [c] = await ctx.db.query(
    `SELECT count(DISTINCT recipient_id) FILTER (WHERE fingerprint = $3)::int AS same, count(DISTINCT recipient_id)::int AS anyone
       FROM dm_request_events WHERE sender_id = $1 AND created_at > now() - ($2::int * interval '1 minute')`, [authorId, win, fp]);
  const needSame = hasLink ? MASS_DM.sameTextWithLinkRecipients : MASS_DM.sameTextRecipients;
  const reason = c.same >= needSame ? (hasLink ? 'identical_dm_with_link' : 'identical_dm') : c.anyone >= MASS_DM.anyTextRecipients ? 'many_strangers' : null;
  if (!reason) return;
  const until = new Date(Date.now() + MASS_DM.limitMinutes * 60_000);
  await ctx.db.query('UPDATE users SET dm_limited_until = $2 WHERE id = $1', [authorId, until]);
  await ctx.db.query('INSERT INTO mass_dm_incidents (id, sender_id, reason, recipients, sample, limited_until) VALUES ($1,$2,$3,$4,$5,$6)', [snowflake(), authorId, reason, reason === 'many_strangers' ? c.anyone : c.same, content.slice(0, 200), until]);
  ctx.log.warn({ senderId: authorId, reason, recipients: c.same, until }, 'mass-DM spam detected; sender limited');
  void import('./safetyAlerts').then((m) => m.alertMassDm(ctx, authorId, { reason, recipients: reason === 'many_strangers' ? c.anyone : c.same })).catch(() => {}); // moderator alert channels
  throw new ApiError(403, 'DM_LIMITED', LIMIT_MESSAGE, { until: until.toISOString() });
}
