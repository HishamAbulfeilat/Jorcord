import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Perm, has } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, forbidden, notFound } from '../errors';
import { idSchema, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { audit } from '../services/guilds';
import { channelAccess, need } from '../services/perms';
import { finalizePoll, pollBlocked, pollTally } from '../services/polls';
import { messageDTO, usersByIds } from '../services/serializers';

const pm = z.object({ id: idSchema, mid: idSchema });

export function pollRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Replace my votes: `answerIds` is the complete new selection ([] removes my votes). */
  app.put('/channels/:id/polls/:mid/votes', async (req) => {
    const p = parse(pm, req.params);
    const b = parse(z.object({ answerIds: z.array(z.number().int().min(1).max(10)).max(10) }).strict(), req.body);
    limitOrThrow(ctx.rl, `poll-vote:${req.userId}`, 30, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    if (a.gp?.timedOut) throw forbidden('You cannot vote while timed out or before accepting the server rules');
    const want = [...new Set(b.answerIds)];
    const events = await ctx.db.tx(async (q) => {
      const [m] = await q.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2 AND poll IS NOT NULL FOR UPDATE', [p.mid, p.id]); // serialises concurrent votes of one poll
      if (!m) throw notFound('Message');
      if (m.poll_finalized || new Date(m.poll_expiry).getTime() <= Date.now()) throw pollBlocked();
      const ids = new Set((m.poll.answers as { id: number }[]).map((x) => x.id));
      if (want.some((w) => !ids.has(w))) throw badRequest('Unknown answer id');
      if (!m.poll.allowMultiselect && want.length > 1) throw badRequest('This poll allows a single choice');
      const cur = (await q.query('SELECT answer_id FROM poll_votes WHERE message_id = $1 AND user_id = $2', [p.mid, req.userId])).map((r) => r.answer_id as number);
      const add = want.filter((w) => !cur.includes(w)), del = cur.filter((c) => !want.includes(c));
      for (const x of del) await q.query('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2 AND answer_id = $3', [p.mid, req.userId, x]);
      for (const x of add) await q.query('INSERT INTO poll_votes (message_id, user_id, answer_id) VALUES ($1,$2,$3)', [p.mid, req.userId, x]);
      return [...del.map((x) => ['MESSAGE_POLL_VOTE_REMOVE', x] as const), ...add.map((x) => ['MESSAGE_POLL_VOTE_ADD', x] as const)];
    });
    if (events.length) {
      const tally = await pollTally(ctx, p.mid);
      for (const [t, answerId] of events) await ctx.hub.toChannel(p.id, t, { userId: req.userId, channelId: p.id, messageId: p.mid, answerId, count: tally.counts.get(answerId) ?? 0, totalVotes: tally.totalVotes });
    }
    const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    return messageDTO(ctx, row, req.userId);
  });

  app.delete('/channels/:id/polls/:mid/votes/@me', async (req) => {
    const p = parse(pm, req.params);
    limitOrThrow(ctx.rl, `poll-vote:${req.userId}`, 30, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    if (a.gp?.timedOut) throw forbidden('You cannot vote while timed out or before accepting the server rules');
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2 AND poll IS NOT NULL', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.poll_finalized || new Date(m.poll_expiry).getTime() <= Date.now()) throw pollBlocked();
    const del = await ctx.db.query('DELETE FROM poll_votes WHERE message_id = $1 AND user_id = $2 RETURNING answer_id', [p.mid, req.userId]);
    if (del.length) {
      const tally = await pollTally(ctx, p.mid);
      for (const d of del) await ctx.hub.toChannel(p.id, 'MESSAGE_POLL_VOTE_REMOVE', { userId: req.userId, channelId: p.id, messageId: p.mid, answerId: d.answer_id, count: tally.counts.get(d.answer_id) ?? 0, totalVotes: tally.totalVotes });
    }
    return messageDTO(ctx, m, req.userId);
  });

  /** Voters of one answer (votes are public, like Discord's non-anonymous polls). Ascending by user id. `?type=` filters by voter kind: `members` = humans, `bots` = bot accounts. */
  app.get('/channels/:id/polls/:mid/answers/:answerId', async (req) => {
    const p = parse(pm.extend({ answerId: z.coerce.number().int().min(1).max(10) }), req.params);
    const q = parse(z.object({ after: idSchema.optional(), limit: z.coerce.number().optional(), type: z.enum(['members', 'bots']).optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const [m] = await ctx.db.query('SELECT poll FROM messages WHERE id = $1 AND channel_id = $2 AND poll IS NOT NULL', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (!(m.poll.answers as { id: number }[]).some((x) => x.id === p.answerId)) throw notFound('Message');
    const rows = await ctx.db.query(
      `SELECT v.user_id FROM poll_votes v JOIN users u ON u.id = v.user_id
       WHERE v.message_id = $1 AND v.answer_id = $2 AND ($3::text IS NULL OR v.user_id > $3) AND ($4::bool IS NULL OR u.bot = $4)
       ORDER BY v.user_id LIMIT $5`,
      [p.mid, p.answerId, q.after ?? null, q.type === undefined ? null : q.type === 'bots', limitParam(q.limit, 25)]);
    const users = await usersByIds(ctx, rows.map((r) => r.user_id));
    return { users: rows.map((r) => users.get(r.user_id)).filter(Boolean) };
  });

  /** End a poll early: the author, or anyone with MANAGE_MESSAGES. */
  app.post('/channels/:id/polls/:mid/expire', async (req) => {
    const p = parse(pm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    const [m] = await ctx.db.query('SELECT author_id, poll_finalized FROM messages WHERE id = $1 AND channel_id = $2 AND poll IS NOT NULL', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (m.author_id !== req.userId && !(a.channel.guild_id && has(a.perms, Perm.MANAGE_MESSAGES))) throw forbidden('Only the poll author or a moderator can end it');
    if (m.poll_finalized) throw pollBlocked();
    const dto = await finalizePoll(ctx, p.mid);
    if (a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'POLL_END', p.mid);
    if (!dto) throw pollBlocked();
    return messageDTO(ctx, (await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]))[0], req.userId);
  });
}
