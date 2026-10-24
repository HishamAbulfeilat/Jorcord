import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { ApiError, notFound } from '../errors';
import { idSchema, iso, parse } from '../lib/ids';
import { listUserInstalledCommands, uninstallApplicationForUser } from '../services/userInstalls';

/** User-installable apps: the caller's own installs and the commands those installs provide. Human sessions only (see BOT_BLOCKED). */
export function userInstallRoutes(app: FastifyInstance, ctx: Ctx) {
  const humansOnly = (req: { isBot: boolean }) => { if (req.isBot) throw new ApiError(403, 'BOT_FORBIDDEN', 'Bots cannot use this endpoint').num(20001); };
  app.get('/users/@me/application-commands', async (req) => { humansOnly(req); return listUserInstalledCommands(ctx, req.userId); });
  app.get('/users/@me/application-installs', async (req) => {
    humansOnly(req);
    const rows = await ctx.db.query(
      `SELECT i.application_id, i.installed_at, a.name, a.icon, a.description, a.bot_user_id FROM application_user_installs i JOIN applications a ON a.id = i.application_id WHERE i.user_id = $1 ORDER BY i.installed_at DESC`, [req.userId]);
    return rows.map((r) => ({ applicationId: r.application_id, name: r.name, icon: r.icon ?? null, description: r.description ?? '', botUserId: r.bot_user_id, installedAt: iso(r.installed_at)! }));
  });
  app.delete('/users/@me/application-installs/:app', async (req, reply) => {
    humansOnly(req);
    const { app: appId } = parse(z.object({ app: idSchema }), req.params);
    if (!(await uninstallApplicationForUser(ctx, appId, req.userId))) throw notFound('Installation');
    return reply.code(204).send();
  });
}
