import type { Ctx } from '../ctx';
import { disconnectMember } from './voice';
import { removeGroupRecipient } from './dms';
import { deleteGuildCascade, transferGuildOwnership } from './guilds';
import { actionEmail } from './emailTemplates';
import { userDTO } from './serializers';

const webUrl = (ctx: Ctx, path: string) => `${ctx.config.publicUrl.replace(/\/$/, '')}${path}`;

/**
 * Account deletion has two phases. `scheduleAccountDeletion` (DELETE /users/@me) signs every session out and sets `deletion_due_at`; logging in again
 * before that moment cancels it (see `issueTokens`). `sweepAccountDeletions` runs from the sweeper and calls `purgeAccount` once the grace period is over.
 */
export async function scheduleAccountDeletion(ctx: Ctx, user: { id: string; email: string | null }): Promise<Date> {
  const dueAt = new Date(Date.now() + ctx.config.accountDeletionGraceMs);
  await ctx.db.query('UPDATE users SET deletion_due_at = $2 WHERE id = $1 AND deleted_at IS NULL', [user.id, dueAt]);
  await ctx.db.query('UPDATE sessions SET revoked = true WHERE user_id = $1 AND NOT revoked', [user.id]);
  await ctx.db.query('DELETE FROM push_devices WHERE user_id = $1', [user.id]);
  ctx.hub.disconnectUser(user.id);
  if (user.email) {
    const days = Math.round(ctx.config.accountDeletionGraceMs / 86_400_000);
    void ctx.mailer.send({ to: user.email, ...actionEmail({
      subject: 'Your Jorcord account is scheduled for deletion',
      heading: 'Your account will be deleted',
      paragraphs: [`Your Jorcord account will be permanently deleted on ${dueAt.toUTCString()} (in ${days} days).`, 'To keep your account, sign in again before that date. Signing in cancels the deletion.'],
      action: { label: 'Sign in to keep your account', url: webUrl(ctx, '/login') },
      footnote: ['If you did not request this, sign in and change your password right away.'],
    }) }).catch((e) => ctx.log.warn({ err: e }, 'deletion email failed'));
  }
  return dueAt;
}

/**
 * Erases accounts whose grace period is over. A server the account still owns by then (it may have created one during the grace period) is handed
 * to its most senior member, or deleted when nobody else is in it.
 */
export async function sweepAccountDeletions(ctx: Ctx): Promise<number> {
  const due = await ctx.db.query('SELECT id FROM users WHERE deletion_due_at IS NOT NULL AND deletion_due_at <= now() AND deleted_at IS NULL AND NOT bot ORDER BY deletion_due_at LIMIT 20');
  let n = 0;
  for (const u of due) {
    try {
      for (const g of await ctx.db.query('SELECT id FROM guilds WHERE owner_id = $1', [u.id])) {
        const [heir] = await ctx.db.query(
          `SELECT m.user_id FROM members m JOIN users x ON x.id = m.user_id AND NOT x.bot AND x.deleted_at IS NULL AND x.deletion_due_at IS NULL
            WHERE m.guild_id = $1 AND m.user_id <> $2
            ORDER BY coalesce((SELECT max(r.position) FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.guild_id = m.guild_id AND mr.user_id = m.user_id), 0) DESC, m.joined_at, m.user_id LIMIT 1`, [g.id, u.id]);
        if (heir) await transferGuildOwnership(ctx, g.id, heir.user_id, u.id); else await deleteGuildCascade(ctx, g.id);
      }
      await purgeAccount(ctx, u.id);
      n++;
    } catch (e) { ctx.log.warn({ err: e, userId: u.id }, 'account deletion failed'); }
  }
  return n;
}

/** Permanently deletes the account: personal data is erased, messages stay attributed to an anonymous "Deleted User". */
export async function purgeAccount(ctx: Ctx, id: string) {
    // who must hear about it (computed before memberships disappear)
    const audience = (await ctx.db.query(
      `SELECT DISTINCT x.uid FROM (SELECT m2.user_id AS uid FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = $1
         UNION SELECT other_id FROM relationships WHERE user_id = $1) x WHERE x.uid <> $1 LIMIT 5000`, [id])).map((r) => r.uid as string);
    const guildIds = (await ctx.db.query('SELECT guild_id FROM members WHERE user_id = $1', [id])).map((r) => r.guild_id as string);
    const groups = await ctx.db.query(`SELECT c.* FROM channels c JOIN dm_participants p ON p.channel_id = c.id WHERE p.user_id = $1 AND c.type = 'group_dm'`, [id]);
    for (const g of groups) await removeGroupRecipient(ctx, g, id);
    await disconnectMember(ctx, id).catch((e) => ctx.log.warn({ err: e }, 'voice disconnect on erase failed'));
    const ownedApps = await ctx.db.query('SELECT id, bot_user_id FROM applications WHERE owner_id = $1', [id]);
    const exportKeys = (await ctx.db.query('SELECT storage_key FROM export_jobs WHERE user_id = $1 AND storage_key IS NOT NULL', [id])).map((r) => r.storage_key as string);
    const orphanFiles = await ctx.db.query('DELETE FROM files WHERE uploader_id = $1 AND NOT attached RETURNING key', [id]);
    await ctx.db.tx(async (q) => {
      await q.query('DELETE FROM members WHERE user_id = $1', [id]);
      await q.query('DELETE FROM relationships WHERE user_id = $1 OR other_id = $1', [id]);
      await q.query('DELETE FROM reactions WHERE user_id = $1', [id]);
      await q.query('DELETE FROM read_states WHERE user_id = $1', [id]);
      await q.query('DELETE FROM boosts WHERE user_id = $1', [id]);
      await q.query('DELETE FROM thread_members WHERE user_id = $1', [id]);
      await q.query('DELETE FROM dm_participants WHERE user_id = $1 AND channel_id IN (SELECT id FROM channels WHERE type = \'group_dm\')', [id]);
      await q.query('DELETE FROM auth_tokens WHERE user_id = $1', [id]);
      await q.query('DELETE FROM sessions WHERE user_id = $1', [id]);
      await q.query('DELETE FROM user_passkeys WHERE user_id = $1', [id]);
      for (const t of ['push_devices', 'notification_settings', 'user_notes', 'dm_ignores', 'saved_messages', 'reminders', 'gif_favorites', 'connections', 'oauth_tokens', 'oauth_codes', 'app_user_metadata', 'bot_reminders', 'remote_auth'])
        await q.query(`DELETE FROM ${t} WHERE user_id = $1`, [id]); // personal data tied to the account (table names are constants)
      await q.query('DELETE FROM user_notes WHERE target_id = $1', [id]);
      await q.query('DELETE FROM export_jobs WHERE user_id = $1', [id]);
      for (const a of ownedApps) {
        await q.query('DELETE FROM roles WHERE managed_app_id = $1', [a.id]);
        await q.query('DELETE FROM applications WHERE id = $1', [a.id]);
        await q.query('DELETE FROM users WHERE id = $1', [a.bot_user_id]);
      }
      await q.query('DELETE FROM ban_appeals WHERE user_id = $1', [id]);
      await q.query('DELETE FROM webauthn_challenges WHERE user_id = $1', [id]);
      await q.query(`UPDATE users SET username = $2, display_name = 'Deleted User', email = NULL, password_hash = NULL, avatar = NULL, banner = NULL, accent_color = NULL,
        bio = NULL, pronouns = NULL, custom_status = NULL, settings = '{}'::jsonb, mfa_secret = NULL, mfa_enabled = false, verified = false, presence = 'offline', server_tag = NULL, deletion_due_at = NULL, deleted_at = now() WHERE id = $1`, [id, `deleted_${id}`]);
    });
    await ctx.pcache.invalidate({ k: 'user', userId: id });
    for (const f of orphanFiles) await ctx.storage.delete(f.key).catch(() => {});
    for (const k of exportKeys) await ctx.storage.delete(k).catch(() => {}); // archives of personal data go with the account
    for (const a of ownedApps) { ctx.hub.disconnectUser(a.bot_user_id); await ctx.pcache.invalidate({ k: 'user', userId: a.bot_user_id }); }
    ctx.hub.disconnectUser(id);
    const [gone] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [id]);
    await ctx.hub.toUsers(audience, 'USER_UPDATE', userDTO(ctx, gone));
    for (const gid of guildIds) await ctx.hub.toGuild(gid, 'MEMBER_REMOVE', { guildId: gid, userId: id });
    for (const o of audience) await ctx.hub.toUser(o, 'RELATIONSHIP_REMOVE', { userId: id });
}
