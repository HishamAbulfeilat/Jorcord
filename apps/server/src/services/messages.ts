import { LIMITS, Perm, has, snowflake, type Attachment, type Message } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden } from '../errors';
import { audit } from './guilds';
import { loadGuildPerms, viewersAmong, permsFor, loadOverwrites } from './perms';
import { messageDTO } from './serializers';
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

export async function checkAutomod(ctx: Ctx, guildId: string, userId: string, memberRoleIds: string[], perms: bigint, content: string, mentionCount: number) {
  if (has(perms, Perm.MANAGE_GUILD)) return; // administrators/managers are exempt
  const rules = await ctx.db.query('SELECT * FROM automod_rules WHERE guild_id = $1 AND enabled', [guildId]);
  const lower = content.toLowerCase();
  for (const r of rules) {
    if ((r.exempt_roles as string[]).some((x) => memberRoleIds.includes(x))) continue;
    let hit = false;
    if (r.trigger === 'keyword') hit = (r.keywords as string[]).some((k) => k && lower.includes(k.toLowerCase()));
    else if (r.trigger === 'link') hit = /https?:\/\//i.test(content);
    else if (r.trigger === 'mention_spam') hit = mentionCount >= 5;
    else if (r.trigger === 'spam') {
      const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE guild_id = $1 AND author_id = $2 AND id > $3', [guildId, userId, snowflake(Date.now() - 5000)]);
      hit = c.n >= 5;
    }
    if (!hit) continue;
    if (r.action === 'alert') { await audit(ctx, guildId, userId, 'AUTOMOD_ALERT', r.id, { content: content.slice(0, 200) }, r.name); continue; }
    if (r.action === 'timeout') {
      await ctx.db.query(`UPDATE members SET timeout_until = now() + interval '60 seconds' WHERE guild_id = $1 AND user_id = $2`, [guildId, userId]);
      await ctx.pcache.invalidate({ k: 'member', guildId, userId });
    }
    await audit(ctx, guildId, userId, 'AUTOMOD_BLOCK', r.id, null, r.name);
    throw new ApiError(400, 'AUTOMOD_BLOCKED', 'Your message was blocked by AutoMod', { rule: r.name });
  }
}

export interface NewMessage {
  channel: any; authorId: string; content: string; type?: Message['type']; replyTo?: string | null;
  attachments?: Attachment[]; stickerIds?: string[]; webhookId?: string | null; senderPerms: bigint;
  memberRoleIds?: string[]; skipChecks?: boolean; threadId?: string | null;
  /** Per-message webhook identity override. */
  webhookUsername?: string | null; webhookAvatar?: string | null;
}

export async function createMessage(ctx: Ctx, m: NewMessage): Promise<Message> {
  const { channel } = m;
  const content = m.content;
  if (content.length > LIMITS.maxMessageLength) throw badRequest(`Message exceeds ${LIMITS.maxMessageLength} characters`);
  const attachments = m.attachments ?? [];
  if (!content.trim() && !attachments.length && !(m.stickerIds?.length) && m.type !== 'join' && m.type !== 'thread_created') throw badRequest('Cannot send an empty message');
  const ment = await parseMentions(ctx, channel, content, m.senderPerms);
  if (channel.guild_id && !m.skipChecks) await checkAutomod(ctx, channel.guild_id, m.authorId, m.memberRoleIds ?? [], m.senderPerms, content, ment.mentions.length + ment.mentionRoles.length);
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
    `INSERT INTO messages (id, channel_id, guild_id, author_id, content, type, reply_to, mention_everyone, mentions, mention_roles, attachments, sticker_ids, webhook_id, thread_id, has_link, has_image, has_file, webhook_username, webhook_avatar)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19)`,
    [id, channel.id, channel.guild_id ?? null, m.authorId, content, type, m.replyTo ?? null, ment.mentionEveryone, JSON.stringify(ment.mentions),
      JSON.stringify(ment.mentionRoles), JSON.stringify(attachments), JSON.stringify(stickerIds), m.webhookId ?? null, m.threadId ?? null,
      /https?:\/\//i.test(content), attachments.some((a) => a.contentType.startsWith('image/')), attachments.length > 0, m.webhookUsername ?? null, m.webhookAvatar ?? null]);
  await ctx.db.query('UPDATE channels SET last_message_id = $2, archived = false WHERE id = $1', [channel.id, id]);
  // author has read their own message
  await ctx.db.query(`INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1,$2,$3,0)
    ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, mention_count = 0`, [m.authorId, channel.id, id]);

  const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [id]);
  const dto = await messageDTO(ctx, row, null);
  await ctx.hub.toChannel(channel.id, 'MESSAGE_CREATE', dto);
  await bumpMentionCounts(ctx, channel, m.authorId, ment, !channel.guild_id).catch((e) => ctx.log.warn({ err: e }, 'mention count failed'));
  ctx.push.notifyMessage(channel, dto); // async + best effort; honours presence, DND, mute and block rules
  if (ctx.config.unfurlOnSend && has(m.senderPerms, Perm.EMBED_LINKS)) void unfurlMessage(ctx, row, channel).catch(() => {});
  return dto;
}

async function bumpMentionCounts(ctx: Ctx, channel: any, authorId: string, ment: MentionResult, isDm: boolean) {
  let targets = new Set<string>(ment.mentions);
  if (isDm) {
    for (const r of await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [channel.id])) targets.add(r.user_id);
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
