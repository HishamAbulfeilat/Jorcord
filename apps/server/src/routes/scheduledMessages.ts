import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SCHEDULED_MESSAGE_LIMITS as LIM, snowflake } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { ageGate } from '../services/agegate';
import { channelAccess } from '../services/perms';
import { assertCanPost, scheduledDTO, validContent } from '../services/scheduledMessages';

const createBody = z.object({
  content: z.string().max(8000), sendAt: z.string().datetime({ offset: true }), replyTo: idSchema.nullable().optional(),
}).strict();

/** Compose now, send later. Only the author sees and manages their scheduled messages. */
export function scheduledMessageRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post('/channels/:id/scheduled-messages', async (req, reply) => {
    if (req.isBot) throw new ApiError(403, 'BOTS_CANNOT_USE_ENDPOINT', 'Bots cannot schedule messages').num(20001);
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(createBody, req.body);
    limitOrThrow(ctx.rl, `sched:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    validContent(b.content);
    const at = Date.parse(b.sendAt);
    if (at < Date.now() + LIM.minDelayMs || at > Date.now() + LIM.maxDelayMs) throw badRequest('Choose a time between 10 seconds and 30 days from now');
    const a = await channelAccess(ctx, req.userId, id);
    await ageGate(ctx, req.userId, false, a);
    await assertCanPost(ctx, a, req.userId, { slowmode: false });
    if (b.replyTo) {
      const [ref] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [b.replyTo, id]);
      if (!ref) throw badRequest('Replied-to message not found in this channel');
    }
    const [n] = await ctx.db.query("SELECT count(*)::int AS n FROM scheduled_messages WHERE author_id = $1 AND status IN ('pending','sending')", [req.userId]);
    if (n.n >= LIM.maxPending) throw new ApiError(400, 'LIMIT_REACHED', `You can have at most ${LIM.maxPending} scheduled messages`);
    const [row] = await ctx.db.query(
      'INSERT INTO scheduled_messages (id, author_id, channel_id, guild_id, content, reply_to, send_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [snowflake(), req.userId, id, a.channel.guild_id ?? null, b.content, b.replyTo ?? null, new Date(at)]);
    const dto = scheduledDTO(row);
    await ctx.hub.toUser(req.userId, 'SCHEDULED_MESSAGE_UPDATE', dto).catch(() => {});
    return reply.code(201).send(dto);
  });

  /** Pending ones, plus anything sent / failed / canceled in the last week (so a failure is not silent). */
  app.get('/users/@me/scheduled-messages', async (req) => {
    const rows = await ctx.db.query(
      `SELECT * FROM scheduled_messages WHERE author_id = $1 AND (status IN ('pending','sending') OR finished_at > now() - interval '7 days') ORDER BY send_at LIMIT 100`, [req.userId]);
    return rows.map(scheduledDTO);
  });

  /** Cancel a pending one. A finished one is removed from the list. Someone else's id is a 404. */
  app.delete('/users/@me/scheduled-messages/:id', async (req, reply) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const [row] = await ctx.db.query('SELECT * FROM scheduled_messages WHERE id = $1 AND author_id = $2', [id, req.userId]);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unknown scheduled message');
    if (row.status === 'sending') throw new ApiError(409, 'CONFLICT', 'This message is being sent right now');
    if (row.status === 'pending') {
      const [c] = await ctx.db.query("UPDATE scheduled_messages SET status = 'canceled', finished_at = now() WHERE id = $1 AND status = 'pending' RETURNING *", [id]);
      if (!c) throw new ApiError(409, 'CONFLICT', 'This message was just sent');
      await ctx.hub.toUser(req.userId, 'SCHEDULED_MESSAGE_UPDATE', scheduledDTO(c)).catch(() => {});
    } else await ctx.db.query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
    return reply.code(204).send();
  });
}
