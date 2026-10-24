import { MessageFlags } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { notFound } from '../errors';
import { audit } from './guilds';
import { messageDTO } from './serializers';

/**
 * Marks a message sensitive (clients blur it behind a click-through) or clears the mark. The text and attachments stay as they are, so a moderator
 * can hide something without deleting the evidence. Audited (MESSAGE_SENSITIVE_SET / _CLEAR). Returns whether the flag changed.
 */
export async function setSensitive(ctx: Ctx, channel: { id: string; guild_id: string | null }, messageId: string, actorId: string, on: boolean, reason: string | null = null): Promise<boolean> {
  const [cur] = await ctx.db.query('SELECT flags, author_id FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channel.id]);
  if (!cur) throw notFound('Message');
  const was = ((cur.flags ?? 0) & MessageFlags.SENSITIVE) !== 0;
  if (was === on) return false;
  const next = on ? (cur.flags ?? 0) | MessageFlags.SENSITIVE : (cur.flags ?? 0) & ~MessageFlags.SENSITIVE;
  await ctx.db.query('UPDATE messages SET flags = $2 WHERE id = $1', [messageId, next]); // not an edit: no edited_at, no history row
  if (channel.guild_id) await audit(ctx, channel.guild_id, actorId, on ? 'MESSAGE_SENSITIVE_SET' : 'MESSAGE_SENSITIVE_CLEAR', messageId, { channelId: channel.id, authorId: cur.author_id }, reason, { before: { sensitive: was }, after: { sensitive: on } });
  const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [messageId]);
  const dto = await messageDTO(ctx, row, actorId);
  await ctx.hub.toChannel(channel.id, 'MESSAGE_UPDATE', { ...dto, reactions: dto.reactions.map((r) => ({ ...r, me: false })) });
  return true;
}
