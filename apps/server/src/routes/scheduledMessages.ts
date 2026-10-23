import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SCHEDULED_MESSAGE_LIMITS as LIM, snowflake, type Attachment } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest } from '../errors';
import { idSchema, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { ageGate } from '../services/agegate';
import { channelAccess } from '../services/perms';
import { assertCanPostIn } from '../services/posting';
import { claimScheduledAttachments, notify, releaseScheduledAttachments, scheduledDTO, validContent } from '../services/scheduledMessages';

const sendAtSchema = z.string().datetime({ offset: true });
const createBody = z.object({
  content: z.string().max(8000).default(''), sendAt: sendAtSchema, replyTo: idSchema.nullable().optional(), attachments: z.array(idSchema).max(10).optional(),
}).strict();
const patchBody = z.object({
  content: z.string().max(8000).optional(), sendAt: sendAtSchema.optional(), replyTo: idSchema.nullable().optional(), attachments: z.array(idSchema).max(10).optional(),
}).strict();

function checkWindow(sendAt: string) {
  const at = Date.parse(sendAt);
  if (at < Date.now() + LIM.minDelayMs || at > Date.now() + LIM.maxDelayMs) throw badRequest('Choose a time between 10 seconds and 30 days from now');
  return at;
}

/** Compose now, send later. Only the author sees and manages their scheduled messages. */
export function scheduledMessageRoutes(app: FastifyInstance, ctx: Ctx) {
  async function checkReply(channelId: string, replyTo: string | null | undefined) {
    if (!replyTo) return;
    const [ref] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [replyTo, channelId]);
    if (!ref) throw badRequest('Replied-to message not found in this channel');
  }

  app.post('/channels/:id/scheduled-messages', async (req, reply) => {
    if (req.isBot) throw new ApiError(403, 'BOTS_CANNOT_USE_ENDPOINT', 'Bots cannot schedule messages').num(20001);
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(createBody, req.body);
    limitOrThrow(ctx.rl, `sched:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const ids = [...new Set(b.attachments ?? [])];
    validContent(b.content, ids.length);
    const at = checkWindow(b.sendAt);
    const a = await channelAccess(ctx, req.userId, id);
    await ageGate(ctx, req.userId, false, a);
    await assertCanPostIn(ctx, a, req.userId, { slowmode: false });
    await checkReply(id, b.replyTo);
    const [n] = await ctx.db.query("SELECT count(*)::int AS n FROM scheduled_messages WHERE author_id = $1 AND status IN ('pending','sending')", [req.userId]);
    if (n.n >= LIM.maxPending) throw new ApiError(400, 'LIMIT_REACHED', `You can have at most ${LIM.maxPending} scheduled messages`);
    const attachments = await claimScheduledAttachments(ctx, a, req.userId, ids);
    let row: any;
    try {
      [row] = await ctx.db.query(
        'INSERT INTO scheduled_messages (id, author_id, channel_id, guild_id, content, attachments, reply_to, send_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *',
        [snowflake(), req.userId, id, a.channel.guild_id ?? null, b.content, JSON.stringify(attachments), b.replyTo ?? null, new Date(at)]);
    } catch (e) { if (attachments.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]); throw e; }
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

  /**
   * Edit a pending one: content, attachments (the full list of ids: kept ones stay, new uploads are claimed, dropped ones are deleted), reply target and/or time.
   * Author only (someone else's id is a 404) and only while pending. Everything is re-validated like a new schedule.
   */
  app.patch('/users/@me/scheduled-messages/:id', async (req) => {
    const { id } = parse(z.object({ id: idSchema }), req.params);
    const b = parse(patchBody, req.body);
    if (b.content === undefined && b.sendAt === undefined && b.replyTo === undefined && b.attachments === undefined) throw badRequest('Nothing to change');
    limitOrThrow(ctx.rl, `sched:${req.userId}`, 10, 60_000, ctx.config.rateLimit);
    const [row] = await ctx.db.query('SELECT * FROM scheduled_messages WHERE id = $1 AND author_id = $2', [id, req.userId]);
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Unknown scheduled message');
    if (row.status !== 'pending') throw new ApiError(409, 'CONFLICT', row.status === 'sending' ? 'This message is being sent right now' : 'Only a pending scheduled message can be edited');
    const old: Attachment[] = row.attachments ?? [];
    const content = b.content ?? row.content;
    const ids = b.attachments === undefined ? old.map((x) => x.id) : [...new Set(b.attachments)];
    validContent(content, ids.length);
    const at = b.sendAt === undefined ? Date.parse(new Date(row.send_at).toISOString()) : checkWindow(b.sendAt);
    const a = await channelAccess(ctx, req.userId, row.channel_id);
    await ageGate(ctx, req.userId, false, a);
    await assertCanPostIn(ctx, a, req.userId, { slowmode: false });
    const replyTo = b.replyTo === undefined ? row.reply_to : b.replyTo;
    if (b.replyTo !== undefined) await checkReply(row.channel_id, replyTo);
    const kept = old.filter((x) => ids.includes(x.id));
    const newIds = ids.filter((x) => !old.some((o) => o.id === x));
    const added = await claimScheduledAttachments(ctx, a, req.userId, newIds);
    const next = ids.map((x) => kept.find((k) => k.id === x) ?? added.find((k) => k.id === x)!);
    const dropped = old.filter((x) => !ids.includes(x.id));
    const [done] = await ctx.db.query(
      "UPDATE scheduled_messages SET content = $2, attachments = $3::jsonb, reply_to = $4, send_at = $5 WHERE id = $1 AND status = 'pending' RETURNING *",
      [id, content, JSON.stringify(next), replyTo ?? null, new Date(at)]);
    if (!done) { // sent or canceled in the meantime: give the fresh claims back
      if (added.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [added.map((x) => x.id)]);
      throw new ApiError(409, 'CONFLICT', 'This message was just sent');
    }
    if (dropped.length) await releaseScheduledAttachments(ctx, dropped);
    await notify(ctx, done);
    return scheduledDTO(done);
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
      if (row.attachments?.length) await releaseScheduledAttachments(ctx, row.attachments);
      await ctx.hub.toUser(req.userId, 'SCHEDULED_MESSAGE_UPDATE', scheduledDTO(c)).catch(() => {});
    } else await ctx.db.query('DELETE FROM scheduled_messages WHERE id = $1', [id]);
    return reply.code(204).send();
  });
}
