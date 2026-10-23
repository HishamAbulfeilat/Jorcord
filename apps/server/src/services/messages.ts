import { LIMITS, Perm, has, isStandardStickerId, snowflake, type AllowedMentions, type Attachment, type Component, type Embed, type CrosspostOrigin, type ForwardSnapshot, type Message } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { checkAutomod } from './automod';
import { guardFirstContact } from './massdm';
import { channelAccess } from './perms';
import { assertEmojiAllowed } from './emojis';
import { audit } from './guilds';
import { noteMessage } from './linkedroles';
import { applyMediaFilter, checkVerification } from './safety';
import { loadGuildPerms, viewersAmong, permsFor, loadOverwrites } from './perms';
import { channelDTO, messageDTO } from './serializers';
import { unfurl } from './unfurl';
import { assertEncryptedPayload } from './e2ee';
import { digestHolders, holdForDigest } from './digest';

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
  /** Controls which mentions trigger notifications (see CONTRACT.md). */
  allowedMentions?: AllowedMentions | null;
  /** Media channel posts must carry at least one image/video attachment (see isMediaAttachment). */
  requireMedia?: boolean;
}

/** True when the attachment is an image or video: the kind a media channel post must carry. */
export const isMediaAttachment = (a: Attachment): boolean => LIMITS.mediaPostTypes.some((p) => a.contentType.startsWith(p));

/** Palette entry for a burst reaction: the requested colour when it is one of ours, the default otherwise. */
export function resolveBurstColor(color?: string | null): string {
  if (color == null || color === '') return LIMITS.burstColors[0];
  if (!(LIMITS.burstColors as readonly string[]).includes(color)) throw badRequest('Invalid burst color');
  return color;
}

/**
 * Meters burst reactions per user per day: one ledger row per accepted burst, counted over the trailing 24 hours.
 * Rows are never deleted, so taking a burst back does not refund the allowance. Throws 429 when exhausted.
 */
export async function consumeBurstQuota(ctx: Ctx, userId: string): Promise<void> {
  // check-and-insert in one statement so concurrent requests cannot all pass a separate count
  const ok = await ctx.db.query(
    `INSERT INTO burst_reaction_usage (id, user_id)
     SELECT $1, $2 WHERE (SELECT count(*) FROM burst_reaction_usage WHERE user_id = $2 AND created_at > now() - interval '1 day') < $3 RETURNING id`,
    [snowflake(), userId, LIMITS.burstReactionsPerDay]);
  if (!ok.length) throw new ApiError(429, 'BURST_LIMIT', `You can send ${LIMITS.burstReactionsPerDay} burst reactions per day`, { limit: LIMITS.burstReactionsPerDay });
}

export async function createMessage(ctx: Ctx, m: NewMessage): Promise<Message> {
  const { channel } = m;
  const content = m.content;
  // Secret chats: the content is a ciphertext envelope. Whatever path got here (scheduled sends included) must have encrypted it already;
  // the server never unfurls, searches, mention-parses or content-scans it.
  const kind = m.type ?? (m.replyTo ? 'reply' : 'default');
  const secret = !!channel.encrypted && (kind === 'default' || kind === 'reply');
  if (secret) await assertEncryptedPayload(ctx, channel, m.authorId, content);
  else if (content.length > LIMITS.maxMessageLength) throw badRequest(`Message exceeds ${LIMITS.maxMessageLength} characters`);
  const attachments = !m.skipChecks && !m.webhookId ? await applyMediaFilter(ctx, channel, m.authorId, m.attachments ?? []) : m.attachments ?? [];
  if (m.requireMedia && !attachments.some(isMediaAttachment)) throw badRequest('Media channels only accept posts with an image or video');
  if (!content.trim() && !attachments.length && !(m.stickerIds?.length) && !m.components?.length && !m.poll && !m.allowEmpty && !m.embeds?.length && !m.forward && m.type !== 'join' && m.type !== 'boost' && m.type !== 'thread_created' && m.type !== 'poll_result') throw badRequest('Cannot send an empty message');
  if (channel.guild_id && !m.skipChecks && !m.webhookId) await checkVerification(ctx, channel.guild_id, m.authorId, m.senderPerms);
  if (channel.guild_id && !m.skipChecks && !m.webhookId) await assertEmojiAllowed(ctx, channel.guild_id, content, m.memberRoleIds, m.senderPerms);
  const ment: MentionResult = secret ? { mentions: [], mentionRoles: [], mentionEveryone: false } : await parseMentions(ctx, channel, content, m.senderPerms);
  if (channel.guild_id && !m.skipChecks) await checkAutomod(ctx, channel.guild_id, m.authorId, m.memberRoleIds ?? [], m.senderPerms, m.forward ? `${content}\n${m.forward.content}` : content, ment.mentions.length + ment.mentionRoles.length, [channel.id, ...(channel.parent_id ? [channel.parent_id] : [])]);
  if (channel.type === 'dm' && !m.skipChecks && !m.webhookId) await guardFirstContact(ctx, channel, m.authorId, content);
  if (m.replyTo) {
    const [ref] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [m.replyTo, channel.id]);
    if (!ref) throw badRequest('Replied-to message not found in this channel');
  }
  let stickerIds = m.stickerIds ?? [];
  if (stickerIds.length) {
    const standard = stickerIds.filter(isStandardStickerId); // built-in packs work in servers and DMs alike
    const own = stickerIds.filter((s) => !standard.includes(s));
    // The channel's own stickers are always usable. Stickers of another server need USE_EXTERNAL_STICKERS and membership of that server; anything else is dropped.
    const external = !!channel.guild_id && has(m.senderPerms, Perm.USE_EXTERNAL_STICKERS);
    const ok = channel.guild_id && own.length
      ? await ctx.db.query(`SELECT s.id FROM stickers s WHERE s.id = ANY($2::text[]) AND (s.guild_id = $1 OR ($3::boolean AND EXISTS (SELECT 1 FROM members mm WHERE mm.guild_id = s.guild_id AND mm.user_id = $4)))`, [channel.guild_id, own, external, m.authorId])
      : [];
    stickerIds = [...standard, ...ok.map((r) => r.id)];
  }
  const id = snowflake();
  const type = m.type ?? (m.replyTo ? 'reply' : 'default');
  await ctx.db.query(
    `INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, reply_to, mention_everyone, mentions, mention_roles, attachments, sticker_ids, webhook_id, thread_id, has_link, has_image, has_file, webhook_username, webhook_avatar, components, flags, application_id, interaction, poll, poll_expiry, allowed_mentions)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23::jsonb,$24::jsonb,$25,$26::jsonb)`,
    [id, channel.id, channel.guild_id ?? null, m.authorId, content, type, m.replyTo ?? null, ment.mentionEveryone, JSON.stringify(ment.mentions),
      JSON.stringify(ment.mentionRoles), JSON.stringify(attachments), JSON.stringify(stickerIds), m.webhookId ?? null, m.threadId ?? null,
      !secret && /https?:\/\//i.test(content), attachments.some((a) => a.contentType.startsWith('image/')), attachments.length > 0, m.webhookUsername ?? null, m.webhookAvatar ?? null,
      JSON.stringify(m.components ?? []), m.flags ?? 0, m.applicationId ?? null, m.interaction ? JSON.stringify(m.interaction) : null, m.poll ? JSON.stringify(m.poll) : null, m.pollExpiry ?? null,
      m.allowedMentions ? JSON.stringify(m.allowedMentions) : null]);
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
  await bumpMentionCounts(ctx, channel, m.authorId, ment, m.replyTo ?? null, !channel.guild_id, m.allowedMentions, id).catch((e) => ctx.log.warn({ err: e }, 'mention count failed'));
  if (channel.guild_id && !m.skipChecks && !m.webhookId) void noteMessage(ctx, channel.guild_id, m.authorId).catch((e) => ctx.log.warn({ err: e }, 'linked role check failed')); // message_count criteria
  ctx.push.notifyMessage(channel, dto); // async + best effort; honours presence, DND, mute and block rules
  if (!secret && ctx.config.unfurlOnSend && has(m.senderPerms, Perm.EMBED_LINKS)) void unfurlMessage(ctx, row, channel).catch(() => {});
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

/**
 * Which mentions trigger the in-app mention badge for a message.
 * When `allowedMentions` is omitted, every parsed mention pings (existing behaviour).
 * When it is present it overrides: only parse entries ping (`users` | `roles` | `everyone` | `replied_user`),
 * and the explicit `users` / `roles` id lists ping in addition to parse. DM participants are message
 * recipients, not parsed mentions, so they always collect a badge.
 */
async function bumpMentionCounts(ctx: Ctx, channel: any, authorId: string, ment: MentionResult, replyTo: string | null, isDm: boolean, allowedMentions: AllowedMentions | null | undefined, messageId: string) {
  const am = allowedMentions ? { parse: new Set(allowedMentions.parse ?? []), users: new Set(allowedMentions.users ?? []), roles: new Set(allowedMentions.roles ?? []) } : null;
  let targets = new Set<string>(am ? ment.mentions.filter((u) => am.parse.has('users') || am.users.has(u)) : ment.mentions);
  if (isDm) {
    for (const r of await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND NOT request', [channel.id])) targets.add(r.user_id); // message requests collect no badges
  } else {
    if (ment.mentionEveryone && (!am || am.parse.has('everyone'))) for (const r of await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1', [channel.guild_id])) targets.add(r.user_id);
    if (ment.mentionRoles.length) {
      if (!am || am.parse.has('roles')) {
        for (const r of await ctx.db.query('SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[])', [channel.guild_id, ment.mentionRoles])) targets.add(r.user_id);
      } else if (am.roles.size) { // per-role allow-list: only members of explicitly listed roles ping
        const rows = await ctx.db.query('SELECT DISTINCT mr.user_id AS uid, mr.role_id AS rid FROM member_roles mr WHERE mr.guild_id = $1 AND mr.role_id = ANY($2::text[])', [channel.guild_id, ment.mentionRoles]);
        for (const r of rows) if (am.roles.has(r.rid!)) targets.add(r.uid!);
      }
    }
    if (replyTo && am?.parse.has('replied_user')) { // a reply pings its author only when 'replied_user' is parsed
      const [ref] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [replyTo, channel.id]);
      if (ref) targets.add(ref.author_id);
    }
  }
  targets.delete(authorId);
  if (!targets.size) return;
  const seen = await viewersAmong(ctx, channel, [...targets]);
  // Quiet mode: people who put this server / channel in their digest get no badge and no push; it is held for their next digest (services/digest.ts)
  const held = await digestHolders(ctx, channel, seen);
  if (held.size) await holdForDigest(ctx, channel, messageId, [...held], new Set(isDm ? seen : ment.mentions));
  const viewers = seen.filter((u) => !held.has(u));
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
export async function reportMessage(ctx: Ctx, userId: string, channelId: string, messageId: string, { reason, description }: { reason: string; description?: string }) {
  const [msg] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
  if (!msg) throw notFound('Message');
  if (msg.author_id === userId) throw badRequest('You cannot report your own message');
  const a = await channelAccess(ctx, userId, channelId);
  if (!a.channel.guild_id) throw badRequest('Reports are for server messages'); // DMs have no moderator queue
  const dup = await ctx.db.query('SELECT 1 AS x FROM reports WHERE message_id = $1 AND reporter_id = $2 AND status = \'open\'', [messageId, userId]);
  if (dup.length) throw new ApiError(409, 'ALREADY_REPORTED', 'You already reported this message');
  const rid = snowflake();
  await ctx.db.query('INSERT INTO reports (id, guild_id, channel_id, message_id, reporter_id, target_user_id, reason, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [rid, a.channel.guild_id, channelId, messageId, userId, msg.author_id, reason, description ?? null]);
  await audit(ctx, a.channel.guild_id, userId, 'REPORT_CREATE', messageId, { reason, channelId, targetUserId: msg.author_id });
  await ctx.hub.toGuild(a.channel.guild_id, 'GUILD_REPORTS_UPDATE', { guildId: a.channel.guild_id });
  return { id: rid };
}
export { permsFor, loadOverwrites, loadGuildPerms, forbidden };
