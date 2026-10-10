import { LIMITS, Perm, has, snowflake, type Attachment, type Component, type Embed, type CrosspostOrigin, type ForwardSnapshot, type Message } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden } from '../errors';
import { checkAutomod } from './automod';
import { applyMediaFilter, checkVerification } from './safety';
import { loadGuildPerms, viewersAmong, permsFor, loadOverwrites } from './perms';
import { channelDTO, messageDTO } from './serializers';
import { unfurl } from './unfurl';

const URL_RE = /https?:\/\/[^\s<>()]+/gi;

export interface MentionResult { mentions: string[]; mentionRoles: string[]; mentionEveryone: boolean }
export async function parseMentions(ctx: Ctx, channel: any, content: string, senderPerms: bigint): Promise<MentionResult> {
  const userIds = [...new Set([...content.matchAll(/<@!?(\d{1,20})>/g)].map((m) => m[1]!))].slice(0, 100);
  const roleIds = [...new Set([...content.matchAll(/<@&(\d{1,20})>/g)].map((m) => m[1]!))].slice(0, 100);
  const canEveryone = has(senderPerms, Perm.MENTION_EVERYONE);
  const mentionEveryone = canEveryone && /(^|\s)@(everyone|here)\b/.test(content);
  let mentions: string[] = [], mentionRoles: string[] = [];
  if (userIds.length) {
    mentions = channel.guild_id
      ? (await ctx.db.query('SELECT user_id AS id FROM members WHERE guild_id = $1 AND user_id = ANY($2::text[])', [channel.guild_id, userIds])).map((r) => r.id)
      : (await ctx.db.query('SELECT user_id AS id FROM dm_participants WHERE channel_id = $1 AND user_id = ANY($2::text[])', [channel.id, userIds])).map((r) => r.id);
  }
  if (roleIds.length && channel.guild_id) {
    mentionRoles = (await ctx.db.query('SELECT id FROM roles WHERE guild_id = $1 AND id = ANY($2::text[]) AND ($3 OR mentionable)', [channel.guild_id, roleIds, canEveryone])).map((r) => r.id);
  }
  return { mentions, mentionRoles, mentionEveryone };
}

export interface NewMessage {
  channel: any; authorId: string; content: string; type?: Message['type']; replyTo?: string | null;
  attachments?: Attachment[]; stickerIds?: string[]; webhookId?: string | null; senderPerms: bigint;
  memberRoleIds?: string[]; skipChecks?: boolean; threadId?: string | null;
  /** Per-message webhook identity override. */
  webhookUsername?: string | null; webhookAvatar?: string | null;
  /** Platform pass: bot/interaction/poll extras. Validation happens in the caller (routes) via lib/components and services/polls. */
  components?: Component[]; flags?: number; applicationId?: string | null; interaction?: { id: string; type: number; name: string | null; userId: string } | null;
  poll?: { question: string; answers: { id: number; text: string; emoji: string | null }[]; allowMultiselect: boolean; layoutType: 1 } | null; pollExpiry?: Date | null;
  /** Allow a message without content (deferred-response placeholder). */
  allowEmpty?: boolean;
  /** Forwarded message: snapshot of the original (see routes/messages forward handling). */
  forward?: ForwardSnapshot | null;
  /** Crossposted copy: where it came from. */
  crosspost?: CrosspostOrigin | null;
  /** Server-generated embeds (AutoMod alerts, boost announcements). Never taken from user input. */
  embeds?: Embed[];
}

export async function createMessage(ctx: Ctx, m: NewMessage): Promise<Message> {
  const { channel } = m;
  const content = m.content;
  if (content.length > LIMITS.maxMessageLength) throw badRequest(`Message exceeds ${LIMITS.maxMessageLength} characters`);
  const attachments = !m.skipChecks && !m.webhookId ? await applyMediaFilter(ctx, channel, m.authorId, m.attachments ?? []) : m.attachments ?? [];
  if (!content.trim() && !attachments.length && !(m.stickerIds?.length) && !m.components?.length && !m.poll && !m.allowEmpty && !m.embeds?.length && !m.forward && m.type !== 'join' && m.type !== 'thread_created' && m.type !== 'poll_result') throw badRequest('Cannot send an empty message');
  if (channel.guild_id && !m.skipChecks && !m.webhookId) await checkVerification(ctx, channel.guild_id, m.authorId, m.senderPerms);
  const ment = await parseMentions(ctx, channel, content, m.senderPerms);
  if (channel.guild_id && !m.skipChecks) await checkAutomod(ctx, channel.guild_id, m.authorId, m.memberRoleIds ?? [], m.senderPerms, m.forward ? `${content}\n${m.forward.content}` : content, ment.mentions.length + ment.mentionRoles.length, [channel.id, ...(channel.parent_id ? [channel.parent_id] : [])]);
  if (m.replyTo) {
    const [ref] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [m.replyTo, channel.id]);
    if (!ref) throw badRequest('Replied-to message not found in this channel');
  }
  let stickerIds = m.stickerIds ?? [];
  if (stickerIds.length) {
    const ok = channel.guild_id ? await ctx.db.query('SELECT id FROM stickers WHERE guild_id = $1 AND id = ANY($2::text[])', [channel.guild_id, stickerIds]) : [];
    stickerIds = ok.map((r) => r.id);
  }
  const id = snowflake();
  const type = m.type ?? (m.replyTo ? 'reply' : 'default');
  await ctx.db.query(
    `INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, reply_to, mention_everyone, mentions, mention_roles, attachments, sticker_ids, webhook_id, thread_id, has_link, has_image, has_file, webhook_username, webhook_avatar, components, flags, application_id, interaction, poll, poll_expiry)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23::jsonb,$24::jsonb,$25)`,
    [id, channel.id, channel.guild_id ?? null, m.authorId, content, type, m.replyTo ?? null, ment.mentionEveryone, JSON.stringify(ment.mentions),
      JSON.stringify(ment.mentionRoles), JSON.stringify(attachments), JSON.stringify(stickerIds), m.webhookId ?? null, m.threadId ?? null,
      /https?:\/\//i.test(content), attachments.some((a) => a.contentType.startsWith('image/')), attachments.length > 0, m.webhookUsername ?? null, m.webhookAvatar ?? null,
      JSON.stringify(m.components ?? []), m.flags ?? 0, m.applicationId ?? null, m.interaction ? JSON.stringify(m.interaction) : null, m.poll ? JSON.stringify(m.poll) : null, m.pollExpiry ?? null]);
  if (m.forward) await ctx.db.query('UPDATE messages SET forward = $2::jsonb WHERE id = $1', [id, JSON.stringify(m.forward)]);
  if (m.embeds?.length) await ctx.db.query('UPDATE messages SET embeds = $2::jsonb WHERE id = $1', [id, JSON.stringify(m.embeds.slice(0, LIMITS.maxEmbedsPerMessage))]);
  if (m.crosspost) await ctx.db.query('UPDATE messages SET crosspost = $2::jsonb WHERE id = $1', [id, JSON.stringify(m.crosspost)]);
  await ctx.db.query('UPDATE channels SET last_message_id = $2, archived = false, activity_at = now() WHERE id = $1', [channel.id, id]);
  // author has read their own message
  await ctx.db.query(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1,$2,$3,0)
    ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, mention_count = 0`, [m.authorId, channel.id, id]);

  const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [id]);
  const dto = await messageDTO(ctx, row, null);
  if (channel.type === 'dm') await settleMessageRequest(ctx, channel, m.authorId, !channel.last_message_id);
  await ctx.hub.toChannel(channel.id, 'MESSAGE_CREATE', dto);
  await bumpMentionCounts(ctx, channel, m.authorId, ment, !channel.guild_id).catch((e) => ctx.log.warn({ err: e }, 'mention count failed'));
  ctx.push.notifyMessage(channel, dto); // async + best effort; honours presence, DND, mute and block rules
  if (ctx.config.unfurlOnSend && has(m.senderPerms, Perm.EMBED_LINKS)) void unfurlMessage(ctx, row, channel).catch(() => {});
  return dto;
}

/**
 * Message-request bookkeeping for a 1:1 DM: the first message reveals the channel to a recipient whose copy is a request
 * (CHANNEL_CREATE + MESSAGE_REQUEST_UPDATE), and a reply from a recipient accepts the request.
 */
async function settleMessageRequest(ctx: Ctx, channel: any, authorId: string, first: boolean) {
  const reqs = await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND request', [channel.id]);
  if (!reqs.length) return;
  if (reqs.some((r) => r.user_id === authorId)) { // the recipient answered: it is a normal DM now
    await ctx.db.query('UPDATE dm_participants SET request = false WHERE channel_id = $1 AND user_id = $2', [channel.id, authorId]);
    await ctx.hub.toUser(authorId, 'MESSAGE_REQUEST_UPDATE', { channelId: channel.id, request: false });
    return;
  }
  if (first) {
    const [fresh] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [channel.id]);
    const dto = await channelDTO(ctx, fresh);
    for (const r of reqs) { await ctx.hub.toUser(r.user_id, 'CHANNEL_CREATE', dto); await ctx.hub.toUser(r.user_id, 'MESSAGE_REQUEST_UPDATE', { channelId: channel.id, request: true }); }
  }
}

async function bumpMentionCounts(ctx: Ctx, channel: any, authorId: string, ment: MentionResult, isDm: boolean) {
  let targets = new Set<string>(ment.mentions);
  if (isDm) {
    for (const r of await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND NOT request', [channel.id])) targets.add(r.user_id); // message requests collect no badges
  } else {
    if (ment.mentionEveryone) for (const r of await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [channel.guild_id])) targets.add(r.user_id);
    if (ment.mentionRoles.length) for (const r of await ctx.db.query('SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[])', [channel.guild_id, ment.mentionRoles])) targets.add(r.user_id);
  }
  targets.delete(authorId);
  if (!targets.size) return;
  const viewers = await viewersAmong(ctx, channel, [...targets]);
  if (!viewers.length) return;
  const rows = await ctx.db.query(
    `INSERT INTO read_states (user_id, channel_id, mention_count) SELECT u, $2, 1 FROM unnest($1::text[]) AS u
     ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1 RETURNING user_id, channel_id, last_read_id, mention_count`, [viewers, channel.id]);
  for (const r of rows) await ctx.hub.toUser(r.user_id, 'READ_STATE_UPDATE', { channelId: r.channel_id, lastReadId: r.last_read_id ?? null, mentionCount: r.mention_count });
}

async function unfurlMessage(ctx: Ctx, row: any, channel: any) {
  const urls = [...new Set((row.content as string).match(URL_RE) ?? [])].slice(0, 3);
  if (!urls.length) return;
  const embeds = (await Promise.all(urls.map((u) => unfurl(ctx, u)))).filter(Boolean);
  if (!embeds.length) return;
  await ctx.db.query('UPDATE messages SET embeds = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(embeds.slice(0, LIMITS.maxEmbedsPerMessage))]);
  const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [row.id]);
  if (fresh) await ctx.hub.toChannel(channel.id, 'MESSAGE_UPDATE', await messageDTO(ctx, fresh, null));
}

/** System message (join, pin, thread_created). */
export async function postSystemMessage(ctx: Ctx, channelId: string, authorId: string, type: Message['type'], content = '', threadId: string | null = null) {
  const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [channelId]);
  if (!channel) return null;
  return createMessage(ctx, { channel, authorId, content, type, senderPerms: 0n, skipChecks: true, threadId });
}
export { permsFor, loadOverwrites, loadGuildPerms, forbidden };
