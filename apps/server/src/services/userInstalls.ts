import { InteractionContextType as CTX, IntegrationType as IT } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { commandDTO } from './commands';

export const isUserInstalled = async (ctx: Ctx, appId: string, userId: string) =>
  !!(await ctx.db.query('SELECT 1 AS x FROM application_user_installs WHERE application_id = $1 AND user_id = $2', [appId, userId]))[0];

/** Installs an application to a user account (idempotent). Only the `applications.commands` scope makes sense for a user install. */
export async function installApplicationForUser(ctx: Ctx, appId: string, userId: string) {
  await ctx.db.query(
    `INSERT INTO application_user_installs (application_id, user_id, scopes) VALUES ($1,$2,'["applications.commands"]'::jsonb) ON CONFLICT (application_id, user_id) DO NOTHING`, [appId, userId]);
}

export async function uninstallApplicationForUser(ctx: Ctx, appId: string, userId: string): Promise<boolean> {
  const rows = await ctx.db.query('DELETE FROM application_user_installs WHERE application_id = $1 AND user_id = $2 RETURNING application_id', [appId, userId]);
  return rows.length > 0;
}

/** Global commands of the user's installed apps that are marked user-installable. */
export async function listUserInstalledCommands(ctx: Ctx, userId: string) {
  const rows = await ctx.db.query(
    `SELECT c.* FROM application_commands c JOIN application_user_installs i ON i.application_id = c.application_id AND i.user_id = $1
      WHERE c.guild_id IS NULL AND c.integration_types @> '[1]'::jsonb ORDER BY c.application_id, c.type, c.name`, [userId]);
  const commands = rows.map(commandDTO);
  const appIds = [...new Set(commands.map((c) => c.applicationId))];
  const apps = appIds.length ? await ctx.db.query('SELECT id, name, icon, bot_user_id FROM applications WHERE id = ANY($1::text[])', [appIds]) : [];
  return { commands, applications: apps.map((a) => ({ id: a.id, name: a.name, icon: a.icon ?? null, botUserId: a.bot_user_id })) };
}

/** Whether `cmd` may be used in `context` (null `contexts` = every context the command's integration types allow, except private channels, which must opt in). */
export function commandAllowsContext(cmd: { contexts?: number[] | null; dm_permission?: boolean }, context: number): boolean {
  if (cmd.contexts) return cmd.contexts.includes(context);
  if (context === CTX.PRIVATE_CHANNEL) return false;
  if (context === CTX.BOT_DM) return !!cmd.dm_permission;
  return true;
}
export const commandAllowsIntegration = (cmd: { integration_types?: number[] | null }, type: number) => (cmd.integration_types ?? [IT.GUILD_INSTALL]).includes(type);
