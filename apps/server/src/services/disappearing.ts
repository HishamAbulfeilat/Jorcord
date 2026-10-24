import { MESSAGE_TTL_OPTIONS } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, notFound } from '../errors';
import { deleteAttachmentFiles } from './files';
import { postSystemMessage } from './messages';
import { channelDTO } from './serializers';

/**
 * Sets the disappearing-message timer of a DM or group DM (any participant may). Only messages sent afterwards carry a deadline;
 * what is already there stays. In a secret chat the rows hold ciphertext envelopes, so the sweep erases the ciphertext itself.
 */
export async function setMessageTtl(ctx: Ctx, userId: string, channelId: string, seconds: number) {
  if (!(MESSAGE_TTL_OPTIONS as readonly number[]).includes(seconds)) throw badRequest(`seconds must be one of ${MESSAGE_TTL_OPTIONS.join(', ')}`);
  const [ch] = await ctx.db.query(`SELECT * FROM channels WHERE id = $1 AND type IN ('dm','group_dm')`, [channelId]);
  const [part] = ch ? await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channelId, userId]) : [];
  if (!ch || !part) throw notFound('Channel');
  if ((ch.message_ttl_seconds ?? 0) === seconds) return channelDTO(ctx, ch);
  await ctx.db.query('UPDATE channels SET message_ttl_seconds = $2 WHERE id = $1', [channelId, seconds]);
  await ctx.pcache.invalidate({ k: 'dm', channelId });
  const [fresh] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [channelId]);
  const dto = await channelDTO(ctx, fresh);
  const parts = (await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [channelId])).map((r) => r.user_id as string);
  await ctx.hub.toUsers(parts, 'CHANNEL_UPDATE', dto);
  await postSystemMessage(ctx, channelId, userId, 'ttl_update', String(seconds)).catch((e) => ctx.log.warn({ err: e }, 'ttl notice failed'));
  return dto;
}

/** Sweeper job: deletes messages past their deadline (attachments and reactions go with them) and tells the channel. Atomic DELETE, so safe on several nodes. */
export async function sweepExpiredMessages(ctx: Ctx, limit = 500): Promise<number> {
  const rows = await ctx.db.query(
    `DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= now() ORDER BY expires_at LIMIT $1) RETURNING id, channel_id, guild_id, attachments`, [limit]);
  if (!rows.length) return 0;
  await deleteAttachmentFiles(ctx, rows.map((r) => r.attachments)).catch((e) => ctx.log.warn({ err: e }, 'attachment cleanup failed'));
  for (const r of rows) await ctx.hub.toChannel(r.channel_id, 'MESSAGE_DELETE', { id: r.id, channelId: r.channel_id, guildId: r.guild_id ?? null });
  return rows.length;
}
