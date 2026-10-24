import { ALL_PERMS, snowflake, type Application, type OAuthScope } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { iso, isId } from '../lib/ids';
import { audit, buildGuildFull } from './guilds';
import { memberDTO, roleDTO, userDTO } from './serializers';

/** Bot token = base64url(botUserId) + "." + 32 random bytes. Only sha256(token) is stored; the plaintext is returned once. */
export function newBotToken(botUserId: string): { token: string; hash: string } {
  const token = `${Buffer.from(botUserId).toString('base64url')}.${randomToken(32)}`;
  return { token, hash: sha256(token) };
}
export async function verifyBotToken(ctx: Ctx, token: string): Promise<{ userId: string; applicationId: string } | null> {
  const dot = token.indexOf('.');
  if (dot < 1 || token.length > 200) return null;
  let id: string; try { id = Buffer.from(token.slice(0, dot), 'base64url').toString(); } catch { return null; }
  if (!isId(id)) return null;
  const [app] = await ctx.db.query('SELECT id, bot_user_id, bot_token_hash FROM applications WHERE bot_user_id = $1', [id]);
  if (!app || !safeEqual(app.bot_token_hash, sha256(token))) return null;
  return { userId: app.bot_user_id, applicationId: app.id };
}

export async function applicationDTO(ctx: Ctx, r: any, secrets: { token?: string; clientSecret?: string } = {}): Promise<Application> {
  const [bot] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [r.bot_user_id]);
  return {
    id: r.id, ownerId: r.owner_id, name: r.name, description: r.description ?? '', icon: r.icon ?? null, botUser: userDTO(ctx, bot), botPublic: r.bot_public,
    redirectUris: r.redirect_uris ?? [], publicKey: r.public_key, interactionsEndpointUrl: r.interactions_endpoint_url ?? null, privilegedIntents: r.privileged_intents ?? 0, activityUrl: r.activity_url ?? null, createdAt: iso(r.created_at)!,
    directory: { listed: !!r.directory_listed, category: r.directory_category ?? 'other', summary: r.directory_summary ?? '', tags: r.directory_tags ?? [], permissions: r.directory_permissions ?? '0' },
    ...(secrets.token ? { token: secrets.token } : {}), ...(secrets.clientSecret ? { clientSecret: secrets.clientSecret } : {}),
  };
}
export const getApplication = async (ctx: Ctx, id: string) => (await ctx.db.query('SELECT * FROM applications WHERE id = $1', [id]))[0] ?? null;

export const isInstalled = async (ctx: Ctx, appId: string, guildId: string) =>
  !!(await ctx.db.query('SELECT 1 AS x FROM application_installs WHERE application_id = $1 AND guild_id = $2', [appId, guildId]))[0];

/** Adds an application to a guild (bot member + managed role when `bot` is in scopes; install record when `applications.commands`). Idempotent. */
export async function installApplication(ctx: Ctx, o: { app: any; guildId: string; scopes: OAuthScope[]; permissions: bigint; installedBy: string }) {
  const { app, guildId } = o;
  const wantsBot = o.scopes.includes('bot');
  const [existing] = await ctx.db.query('SELECT * FROM application_installs WHERE application_id = $1 AND guild_id = $2', [app.id, guildId]);
  const merged = [...new Set([...(existing?.scopes ?? []), ...o.scopes])];
  let roleId: string | null = existing?.role_id ?? null;
  let newRole = false;
  if (wantsBot) {
    const perms = (o.permissions & ALL_PERMS).toString();
    if (roleId) await ctx.db.query('UPDATE roles SET permissions = $2 WHERE id = $1', [roleId, perms]);
    else {
      roleId = snowflake(); newRole = true;
      await ctx.db.query(`UPDATE roles SET position = position + 1 WHERE guild_id = $1 AND position >= 1 AND id <> $1`, [guildId]);
      // lowest non-@everyone position: an integration role can never outrank a human role
      await ctx.db.query(`INSERT INTO roles (id, guild_id, name, permissions, position, managed_app_id) VALUES ($1,$2,$3,$4,1,$5)`, [roleId, guildId, app.name, perms, app.id]);
    }
    await ctx.db.query('INSERT INTO members (guild_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [guildId, app.bot_user_id]);
    await ctx.db.query('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [guildId, app.bot_user_id, roleId]);
  }
  await ctx.db.query(
    `INSERT INTO application_installs (application_id, guild_id, scopes, installed_by, role_id) VALUES ($1,$2,$3::jsonb,$4,$5)
     ON CONFLICT (application_id, guild_id) DO UPDATE SET scopes = EXCLUDED.scopes, role_id = EXCLUDED.role_id`, [app.id, guildId, JSON.stringify(merged), o.installedBy, roleId]);
  await ctx.pcache.invalidate({ k: 'guild', guildId });
  if (wantsBot) {
    if (!existing?.role_id) {
      await audit(ctx, guildId, o.installedBy, 'BOT_ADD', app.bot_user_id, { applicationId: app.id, permissions: o.permissions.toString() });
      const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [roleId]);
      if (newRole) await ctx.hub.toGuild(guildId, 'ROLE_CREATE', roleDTO(role));
      const m = await memberDTO(ctx, guildId, app.bot_user_id);
      if (m) await ctx.hub.toGuild(guildId, 'MEMBER_ADD', m, { exclude: app.bot_user_id });
      await ctx.hub.toUser(app.bot_user_id, 'GUILD_CREATE', await buildGuildFull(ctx, guildId, app.bot_user_id));
    } else {
      const [role] = await ctx.db.query('SELECT * FROM roles WHERE id = $1', [roleId]);
      await ctx.hub.toGuild(guildId, 'ROLE_UPDATE', roleDTO(role));
    }
  }
}

/** Removes install records and the managed role when a bot leaves / is kicked / is banned. Call after the member row is gone. */
export async function uninstallBot(ctx: Ctx, guildId: string, botUserId: string) {
  const rows = await ctx.db.query(
    'DELETE FROM application_installs WHERE guild_id = $1 AND application_id IN (SELECT id FROM applications WHERE bot_user_id = $2) RETURNING role_id', [guildId, botUserId]);
  if (rows.length) await ctx.db.query('DELETE FROM system_bot_settings WHERE guild_id = $1 AND bot_key IN (SELECT system_key FROM applications WHERE bot_user_id = $2 AND system_key IS NOT NULL)', [guildId, botUserId]);
  for (const r of rows) if (r.role_id) {
    await ctx.db.query(`DELETE FROM roles WHERE id = $1 AND guild_id = $2 AND managed_app_id IS NOT NULL`, [r.role_id, guildId]);
    await ctx.hub.toGuild(guildId, 'ROLE_DELETE', { id: r.role_id, guildId });
  }
  if (rows.length) await ctx.pcache.invalidate({ k: 'guild', guildId });
}
