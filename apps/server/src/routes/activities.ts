import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { activitiesSchema, normalizeActivities } from '../services/activities';

/**
 * Rich presence. A user's own client (or a bot, for itself) publishes what it is doing; peers see it in presence events.
 * Nothing is stored beyond the live connection: activities are cleared when the last gateway session ends.
 */
export function activityRoutes(app: FastifyInstance, ctx: Ctx) {
  app.put('/users/@me/activities', async (req) => {
    const { activities } = parse(z.object({ activities: activitiesSchema }).strict(), req.body);
    limitOrThrow(ctx.rl, `activity:${req.userId}`, 30, 60_000, ctx.config.rateLimit);
    const list = normalizeActivities(activities);
    await ctx.db.query('UPDATE users SET activities = $2::jsonb WHERE id = $1', [req.userId, JSON.stringify(list)]);
    await ctx.hub.broadcastPresence(req.userId);
    return { activities: list };
  });
  app.get('/users/@me/activities', async (req) => {
    const [u] = await ctx.db.query('SELECT activities FROM users WHERE id = $1', [req.userId]);
    return { activities: Array.isArray(u?.activities) ? u.activities : [] };
  });
  app.delete('/users/@me/activities', async (req, reply) => {
    await ctx.db.query(`UPDATE users SET activities = '[]'::jsonb WHERE id = $1`, [req.userId]);
    await ctx.hub.broadcastPresence(req.userId);
    return reply.code(204).send();
  });
}
