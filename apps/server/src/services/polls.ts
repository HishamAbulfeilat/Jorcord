import { z } from 'zod';
import type { Message } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError } from '../errors';
import { createMessage } from './messages';
import { messageDTO } from './serializers';

export const POLL_MAX_HOURS = 32 * 24; // 768h: Discord's documented maximum duration
const emoji = z.string().min(1).max(64).regex(/^[^\u0000-\u001f<>]+$/);
export const createPollSchema = z.object({
  question: z.string().trim().min(1).max(300),
  answers: z.array(z.object({ text: z.string().trim().min(1).max(55), emoji: emoji.nullable().optional() }).strict()).min(1).max(10),
  durationHours: z.number().int().min(1).max(POLL_MAX_HOURS).optional(), allowMultiselect: z.boolean().optional(),
}).strict();

export function buildPoll(raw: unknown) {
  const p = createPollSchema.parse(raw);
  return {
    poll: { question: p.question, answers: p.answers.map((a, i) => ({ id: i + 1, text: a.text, emoji: a.emoji ?? null })), allowMultiselect: p.allowMultiselect ?? false, layoutType: 1 as const },
    expiry: new Date(Date.now() + (p.durationHours ?? 24) * 3600_000),
  };
}

/** Marks the poll finalized exactly once (atomic), posts the POLL_RESULT system message and tells the channel. Returns the updated poll message, or null if already final. */
export async function finalizePoll(ctx: Ctx, messageId: string): Promise<Message | null> {
  const [m] = await ctx.db.query('UPDATE messages SET poll_finalized = true WHERE id = $1 AND poll IS NOT NULL AND NOT poll_finalized RETURNING *', [messageId]);
  if (!m) return null;
  const votes = await ctx.db.query('SELECT answer_id, count(*)::int AS n FROM poll_votes WHERE message_id = $1 GROUP BY answer_id', [m.id]);
  const best = Math.max(0, ...votes.map((v) => v.n as number));
  const winners = best > 0 ? m.poll.answers.filter((a: any) => votes.find((v) => v.answer_id === a.id)?.n === best) : [];
  const summary = best > 0 ? `${winners.map((w: any) => w.text).join(', ')} won with ${best} vote${best === 1 ? '' : 's'}` : 'No votes were cast';
  const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [m.channel_id]);
  if (channel) await createMessage(ctx, { channel, authorId: m.author_id, content: `${m.poll.question} - ${summary}`.slice(0, 4000), type: 'poll_result', replyTo: m.id, senderPerms: 0n, skipChecks: true }).catch((e) => ctx.log.warn({ err: e }, 'poll result message failed'));
  const dto = await messageDTO(ctx, m, null);
  await ctx.hub.toChannel(m.channel_id, 'MESSAGE_UPDATE', dto);
  return dto;
}

export async function finalizeDuePolls(ctx: Ctx, limit = 100) {
  const due = await ctx.db.query('SELECT id FROM messages WHERE poll IS NOT NULL AND NOT poll_finalized AND poll_expiry <= now() ORDER BY poll_expiry LIMIT $1', [limit]);
  for (const r of due) await finalizePoll(ctx, r.id).catch((e) => ctx.log.warn({ err: e }, 'poll finalize failed'));
  return due.length;
}
export const pollBlocked = () => new ApiError(400, 'POLL_VOTING_BLOCKED', 'This poll has ended').num(520000);
