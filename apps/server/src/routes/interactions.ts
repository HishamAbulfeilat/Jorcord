import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../ctx';
import { limitOrThrow } from '../lib/ratelimit';
import { parse } from '../lib/ids';
import { applyCallback, createFollowup, deleteFollowup, editFollowup, getFollowup, invoke, loadInteraction } from '../services/interactions';
import { channelAccess } from '../services/perms';

/** User side: invoke a command / component / modal submit / autocomplete. Requires a user session (bots are rejected by the auth hook). */
export function interactionRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/interactions', async (req, reply) => {
    limitOrThrow(ctx.rl, `ix-user:${req.userId}`, 60, 60_000, ctx.config.rateLimit);
    const r = await invoke(ctx, req.userId, req.body, (channelId) => channelAccess(ctx, req.userId, parse(z.string().regex(/^\d{1,20}$/), channelId)));
    return reply.code(202).send(r);
  });
}

/** App side: the interaction token (15 minutes) is the credential. */
export function interactionPublicRoutes(app: FastifyInstance, ctx: Ctx) {
  const tp = z.object({ id: z.string().regex(/^\d{1,20}$/), token: z.string().min(20).max(100) });
  const load = async (params: unknown) => {
    const p = parse(tp, params);
    limitOrThrow(ctx.rl, `ix-app:${p.id}`, 60, 60_000, ctx.config.rateLimit);
    return loadInteraction(ctx, p.id, p.token);
  };
  app.post('/interactions/:id/:token/callback', async (req, reply) => {
    const row = await load(req.params);
    await applyCallback(ctx, row, req.body);
    return reply.code(204).send();
  });
  app.post('/interactions/:id/:token/messages', async (req, reply) => reply.code(201).send(await createFollowup(ctx, await load(req.params), req.body)));
  app.get('/interactions/:id/:token/messages/:mid', async (req) => getFollowup(ctx, await load(req.params), parse(z.object({ mid: z.union([z.literal('@original'), z.string().regex(/^\d{1,20}$/)]) }), req.params).mid));
  app.patch('/interactions/:id/:token/messages/:mid', async (req) => editFollowup(ctx, await load(req.params), parse(z.object({ mid: z.union([z.literal('@original'), z.string().regex(/^\d{1,20}$/)]) }), req.params).mid, req.body));
  app.delete('/interactions/:id/:token/messages/:mid', async (req, reply) => {
    await deleteFollowup(ctx, await load(req.params), parse(z.object({ mid: z.union([z.literal('@original'), z.string().regex(/^\d{1,20}$/)]) }), req.params).mid);
    return reply.code(204).send();
  });
}
