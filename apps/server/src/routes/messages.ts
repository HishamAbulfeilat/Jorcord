import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { E2EE_MAX_ENVELOPE_CHARS, LIMITS, MessageFlags, Perm, STANDARD_STICKER_ID_RE, has, snowflake, snowflakeTime, type ForwardSnapshot } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { checkVerification } from '../services/safety';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { idSchema, iso, limitParam, parse } from '../lib/ids';
import { limitOrThrow } from '../lib/ratelimit';
import { assertAttachmentRefs, parseComponents } from '../lib/components';
import { parseEmbeds } from '../lib/embeds';
import { buildPoll } from '../services/polls';
import { claimAttachments, deleteAttachmentFiles, saveUpload } from '../services/files';
import { audit, visibleChannelRows } from '../services/guilds';
import { createMessage, unfurlMessage, parseMentions, postSystemMessage, consumeBurstQuota, resolveBurstColor, settleLastMessage } from '../services/messages';
import { checkAutomod } from '../services/automod';
import { assertCanPostIn } from '../services/posting';
import { channelAccess, channelPermsLite, guildAccess, need } from '../services/perms';
import { canUseEmoji } from '../services/emojis';
import { joinThread } from '../services/threads';
import { hasSearchCriteria, searchMessages, searchQuerySchema } from '../services/search';
import { ageConfirmed, ageGate } from '../services/agegate';
import { messageDTO, messagesDTO, usersByIds } from '../services/serializers';
import { assertEncryptedPayload } from '../services/e2ee';
import { LANG_RE, translateConfigured, translateText } from '../services/translate';

const cm = z.object({ id: idSchema });
const mm = z.object({ id: idSchema, mid: idSchema });
const sendBody = z.object({
  content: z.string().max(E2EE_MAX_ENVELOPE_CHARS).optional(), replyTo: idSchema.nullable().optional(),
  attachments: z.array(idSchema).max(10).optional(), stickerIds: z.array(z.union([idSchema, z.string().regex(STANDARD_STICKER_ID_RE)])).max(3).optional(),
  /** Bots only: action rows of buttons / select menus (validated by lib/components). */
  components: z.unknown().optional(),
  /** Bots only: sender-sent rich embeds (validated by lib/embeds). */
  embeds: z.unknown().optional(),
  /** Needs SEND_POLLS. */
  poll: z.unknown().optional(),
  flags: z.number().int().optional(),
  /** Forward an existing message (instead of writing content). */
  forward: z.object({ channelId: idSchema, messageId: idSchema }).strict().optional(),
  /** Control which mentions trigger notifications (overrides default pings; see CONTRACT.md). */
  allowedMentions: z.object({
    parse: z.array(z.enum(['users', 'roles', 'everyone', 'replied_user'])).max(4).optional(),
    users: z.array(idSchema).max(100).optional(),
    roles: z.array(idSchema).max(100).optional(),
  }).strict().optional(),
}).strict();
/** Normalises alt text: trimmed, <= 1024 chars; empty clears it (null); a non-string is ignored (undefined). */
export function altText(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, 1024);
  return t || null;
}
const emojiParam = z.string().min(1).max(100);
/** Optional body for PUT …/reactions: `burst` sends a super reaction in `burstColor` (palette-checked). */
const reactBody = z.object({ burst: z.boolean().optional(), burstColor: z.string().max(9).nullable().optional() }).strict();
const burstQuery = z.object({ burst: z.enum(['true', 'false']).optional() });

function parseEmoji(raw: string): { emoji: string; emojiId: string | null } {
  let e: string; try { e = decodeURIComponent(raw); } catch { throw badRequest('Invalid emoji'); } // malformed %-escapes must be a 400, not a 500
  const custom = e.match(/^(\w{2,32}):(\d{1,20})$/);
  if (custom) return { emoji: custom[1]!, emojiId: custom[2]! };
  if (e.includes(':') || e.length > 32 || /[\u0000-\u001f<>]/.test(e)) throw badRequest('Invalid emoji');
  return { emoji: e, emojiId: null };
}

/** Loads the original for a forward: the caller must be able to read it; forwarding a forward keeps the first origin. */
async function snapshotForForward(ctx: Ctx, userId: string, channelId: string, messageId: string): Promise<ForwardSnapshot> {
  const src = await channelAccess(ctx, userId, channelId);
  need(src.perms, Perm.READ_MESSAGE_HISTORY);
  if (src.channel.encrypted) throw badRequest('Messages from a secret chat cannot be forwarded');
  const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [messageId, channelId]);
  if (!m || !['default', 'reply'].includes(m.type)) throw notFound('Message');
  if (m.forward) return m.forward as ForwardSnapshot;
  const snap: ForwardSnapshot = {
    content: m.content, attachments: m.attachments ?? [], embeds: m.embeds ?? [], createdAt: new Date(snowflakeTime(m.id)).toISOString(), editedAt: m.edited_at ? new Date(m.edited_at).toISOString() : null,
    sourceGuildId: m.guild_id ?? null, sourceChannelId: m.channel_id, sourceMessageId: m.id,
  };
  if (!snap.content.trim() && !snap.attachments.length && !snap.embeds.length) throw badRequest('Nothing to forward');
  return snap;
}

export function messageRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get('/channels/:id/messages', async (req) => {
    const { id } = parse(cm, req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), before: idSchema.optional(), after: idSchema.optional(), around: idSchema.optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, id);
    await ageGate(ctx, req.userId, req.isBot, a);
    if (!has(a.perms, Perm.READ_MESSAGE_HISTORY)) return [];
    const limit = limitParam(q.limit);
    let rows: any[];
    if (q.around) {
      const half = Math.max(1, Math.floor(limit / 2));
      const older = await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND id <= $2 ORDER BY id DESC LIMIT $3', [id, q.around, half]);
      const newer = await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [id, q.around, half]);
      rows = [...newer.reverse(), ...older];
    } else if (q.after) {
      rows = (await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3', [id, q.after, limit])).reverse();
    } else {
      rows = await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND ($2::text IS NULL OR id < $2) ORDER BY id DESC LIMIT $3', [id, q.before ?? null, limit]);
    }
    return messagesDTO(ctx, rows, req.userId);
  });

  app.post('/channels/:id/messages', async (req, reply) => {
    const { id } = parse(cm, req.params);
    limitOrThrow(ctx.rl, `msg:${req.userId}`, 10, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, id);
    await ageGate(ctx, req.userId, req.isBot, a);
    await assertCanPostIn(ctx, a, req.userId);
    let body: z.infer<typeof sendBody>;
    const uploaded: string[] = [];
    let descriptions: unknown = null;
    if (req.isMultipart()) {
      const fields: Record<string, unknown> = {};
      try {
        for await (const part of req.parts()) {
          if (part.type === 'file') {
            if (uploaded.length >= 10) throw badRequest('At most 10 files per message');
            need(a.perms, Perm.ATTACH_FILES);
            uploaded.push((await saveUpload(ctx, req.userId, part)).id);
          } else if (typeof part.value === 'string') {
            if (part.fieldname === 'payload_json') Object.assign(fields, JSON.parse(part.value));
            else if (part.fieldname === 'stickerIds') fields.stickerIds = JSON.parse(part.value);
            else if (part.fieldname === 'content' || part.fieldname === 'replyTo') fields[part.fieldname] = part.value;
            else if (part.fieldname === 'flags') fields.flags = Number(part.value);
            else if (part.fieldname === 'descriptions') descriptions = JSON.parse(part.value); // alt text per uploaded file, in file order
          }
        }
      } catch (e: any) { if (e instanceof SyntaxError) throw badRequest('Invalid JSON field'); throw e; }
      body = parse(sendBody, { ...fields, attachments: [...((fields.attachments as string[]) ?? []), ...uploaded] });
      if (Array.isArray(descriptions)) { // alt text for the files uploaded in this request (own, still unattached rows only)
        for (let i = 0; i < Math.min(uploaded.length, descriptions.length); i++) {
          const d = altText(descriptions[i]);
          if (d !== undefined) await ctx.db.query('UPDATE files SET description = $3 WHERE id = $1 AND uploader_id = $2 AND NOT attached', [uploaded[i], req.userId, d]);
        }
      }
    } else body = parse(sendBody, req.body);
    if (a.channel.encrypted) { // secret chat: ciphertext only (docs/E2EE_DMS.md)
      if (uploaded.length || body.attachments?.length || body.stickerIds?.length || body.embeds !== undefined || body.components !== undefined || body.poll !== undefined || body.forward || body.flags) throw badRequest('Secret chats carry encrypted text only: no attachments, stickers, embeds, polls or forwards');
      await assertEncryptedPayload(ctx, a.channel, req.userId, body.content ?? '');
    } else if ((body.content?.length ?? 0) > LIMITS.maxMessageLength * 2) throw badRequest('Message is too long');
    if (body.attachments?.length) need(a.perms, Perm.ATTACH_FILES);
    if (body.replyTo) need(a.perms, Perm.READ_MESSAGE_HISTORY);
    // SUPPRESS_EMBEDS | SUPPRESS_NOTIFICATIONS (@silent); bots may also set IS_COMPONENTS_V2
    if ((body.flags ?? 0) & ~(MessageFlags.SUPPRESS_EMBEDS | MessageFlags.SUPPRESS_NOTIFICATIONS | MessageFlags.TTS | (req.isBot ? MessageFlags.IS_COMPONENTS_V2 : 0))) throw badRequest('Unsupported message flags');
    if ((body.flags ?? 0) & MessageFlags.TTS) need(a.perms, Perm.SEND_TTS); // /tts: text-to-speech is its own permission
    const v2 = ((body.flags ?? 0) & MessageFlags.IS_COMPONENTS_V2) !== 0;
    if (v2 && (body.content?.trim() || body.embeds !== undefined || body.poll !== undefined || body.stickerIds?.length || body.forward || body.components === undefined)) throw badRequest('A Components V2 message is made of components only: no content, embeds, stickers, poll or forward');
    let components;
    if (body.components !== undefined) {
      if (!req.isBot) throw new ApiError(403, 'USER_FORBIDDEN', 'Only bots can send components').num(20002);
      components = parseComponents(body.components, { v2 });
    }
    let embeds;
    if (body.embeds !== undefined) embeds = parseEmbeds(body.embeds, req.isBot); // enforces the bots-only rule itself
    let pollInput: ReturnType<typeof buildPoll> | undefined;
    if (body.poll !== undefined) {
      if (a.channel.guild_id) need(a.perms, Perm.SEND_POLLS);
      pollInput = buildPoll(body.poll);
    }
    let forward: ForwardSnapshot | undefined;
    if (body.forward) {
      if (req.isBot) throw new ApiError(403, 'USER_FORBIDDEN', 'Bots cannot forward messages').num(20002);
      if (body.content?.trim() || body.attachments?.length || body.stickerIds?.length || body.replyTo || body.components !== undefined || body.poll !== undefined || body.embeds !== undefined) throw badRequest('A forward cannot carry other content');
      limitOrThrow(ctx.rl, `msg-forward:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
      forward = await snapshotForForward(ctx, req.userId, body.forward.channelId, body.forward.messageId);
      if (forward.attachments.length) need(a.perms, Perm.ATTACH_FILES);
    }
    const attachments = await claimAttachments(ctx, req.userId, body.attachments ?? []);
    try {
      // Voice messages are audio attachments: the sender needs SEND_VOICE_MESSAGES (like Discord does).
      if (attachments.some((at) => at.contentType.startsWith('audio/'))) need(a.perms, Perm.SEND_VOICE_MESSAGES);
      if (v2 && components) assertAttachmentRefs(components, attachments.map((at) => at.filename));
      const msg = await createMessage(ctx, { channel: a.channel, authorId: req.userId, content: body.content ?? '', replyTo: body.replyTo, attachments, stickerIds: body.stickerIds, senderPerms: a.perms, memberRoleIds: a.gp?.memberRoleIds,
        components, embeds, flags: body.flags, applicationId: req.applicationId, poll: pollInput?.poll, pollExpiry: pollInput?.expiry, forward, allowedMentions: body.allowedMentions });
      if (a.channel.type === 'thread') await joinThread(ctx, a.channel, req.userId).catch(() => {}); // posting in a thread follows it
      return reply.code(201).send(msg);
    } catch (e) {
      if (attachments.length) await ctx.db.query('UPDATE files SET attached = false WHERE id = ANY($1::text[])', [attachments.map((x) => x.id)]);
      throw e;
    }
  });

  app.patch('/channels/:id/messages/:mid', async (req) => {
    const p = parse(mm, req.params);
    const b = parse(z.object({ content: z.string().min(1).max(LIMITS.maxMessageLength).optional(), components: z.unknown().optional(), flags: z.number().int().optional() }).strict(), req.body);
    if (b.content === undefined && b.components === undefined && b.flags === undefined) throw badRequest('Provide content, components and/or flags');
    limitOrThrow(ctx.rl, `msg-edit:${req.userId}`, 15, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.encrypted) throw badRequest('Messages in a secret chat cannot be edited; delete and resend');
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    // Only SUPPRESS_EMBEDS can be toggled: by the author, or by a moderator (MANAGE_MESSAGES) on someone else's message.
    const flagsOnly = b.flags !== undefined && b.content === undefined && b.components === undefined;
    if (b.flags !== undefined) {
      if (b.flags & ~MessageFlags.SUPPRESS_EMBEDS) throw badRequest('Only the SUPPRESS_EMBEDS flag can be edited');
      if (!['default', 'reply'].includes(m.type)) throw forbidden('This message cannot be edited');
      if (m.author_id !== req.userId) { if (!a.channel.guild_id) throw forbidden(); need(a.perms, Perm.MANAGE_MESSAGES); }
    }
    if (!flagsOnly) {
      if (m.author_id !== req.userId || m.webhook_id || !['default', 'reply'].includes(m.type)) throw forbidden('You can only edit your own messages');
      if (m.forward) throw badRequest('Forwarded messages cannot be edited');
    }
    if (a.gp?.timedOut) throw forbidden('You cannot edit messages while timed out or before accepting the server rules');
    if (b.flags !== undefined) {
      const next = (((m.flags ?? 0) as number) & ~MessageFlags.SUPPRESS_EMBEDS) | (b.flags & MessageFlags.SUPPRESS_EMBEDS);
      if (next !== (m.flags ?? 0)) await ctx.db.query('UPDATE messages SET flags = $2 WHERE id = $1', [p.mid, next]); // not an "edit": no edited_at, no history row
      // restoring embeds on a message that was sent with them suppressed: fetch the previews now
      if (next !== (m.flags ?? 0) && !(next & MessageFlags.SUPPRESS_EMBEDS) && !(m.embeds ?? []).length && m.author_id === req.userId && !a.channel.encrypted && ctx.config.unfurlOnSend && has(a.perms, Perm.EMBED_LINKS)) void unfurlMessage(ctx, { ...m, flags: next }, a.channel).catch(() => {});
    }
    const isV2 = ((m.flags ?? 0) & MessageFlags.IS_COMPONENTS_V2) !== 0;
    if (isV2 && b.content !== undefined) throw badRequest('A Components V2 message has no content to edit');
    if (b.components !== undefined) {
      if (!req.isBot || m.application_id !== req.applicationId) throw new ApiError(403, 'USER_FORBIDDEN', 'Only the owning bot can edit components').num(20002);
      const next = parseComponents(b.components, { v2: isV2 });
      if (isV2) assertAttachmentRefs(next, ((m.attachments ?? []) as { filename: string }[]).map((x) => x.filename));
      await ctx.db.query('UPDATE messages SET components = $2::jsonb, edited_at = now() WHERE id = $1', [p.mid, JSON.stringify(next)]);
    }
    if (b.content !== undefined) {
      const ment = await parseMentions(ctx, a.channel, b.content, a.perms);
      // edits are held to the same AutoMod rules as new messages (otherwise post something harmless, then edit it)
      if (a.channel.guild_id) await checkAutomod(ctx, a.channel.guild_id, req.userId, a.gp?.memberRoleIds ?? [], a.perms, b.content, ment.mentions.length + ment.mentionRoles.length, [a.channel.id, ...(a.channel.parent_id ? [a.channel.parent_id] : [])]);
      // R19: the content being replaced is kept as a prior version before the update runs.
      await ctx.db.query('INSERT INTO message_edits (id, message_id, content) VALUES ($1, $2, $3)', [snowflake(), p.mid, m.content]);
      await ctx.db.query('UPDATE messages SET content = $2, edited_at = now(), mentions = $3::jsonb, mention_roles = $4::jsonb, mention_everyone = $5, has_link = $6 WHERE id = $1',
        [p.mid, b.content, JSON.stringify(ment.mentions), JSON.stringify(ment.mentionRoles), ment.mentionEveryone, /https?:\/\//i.test(b.content)]);
    }
    const [row] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [p.mid]);
    const dto = await messageDTO(ctx, row, req.userId);
    await ctx.hub.toChannel(p.id, 'MESSAGE_UPDATE', { ...dto, reactions: dto.reactions.map((r) => ({ ...r, me: false })) });
    return dto;
  });

  // ---------- attachment alt text ----------
  /** Sets/clears the alt text of one of my still-unsent uploads (POST /uploads result id). */
  app.patch('/uploads/:id', async (req) => {
    const { id } = parse(cm, req.params);
    const b = parse(z.object({ description: z.string().max(1024).nullable() }).strict(), req.body);
    const d = altText(b.description) ?? null;
    const rows = await ctx.db.query('UPDATE files SET description = $3 WHERE id = $1 AND uploader_id = $2 AND NOT attached RETURNING id', [id, req.userId, d]);
    if (!rows.length) throw notFound('Upload');
    return { id, description: d };
  });

  // ---------- translation ----------
  /** Lets the client tell whether the server-side fallback exists (the browser Translator API is tried first). */
  app.get('/translate/config', async () => ({ available: translateConfigured(ctx) }));
  app.post('/channels/:id/messages/:mid/translate', async (req) => {
    const p = parse(mm, req.params);
    const { to } = parse(z.object({ to: z.string().regex(LANG_RE) }).strict(), req.body);
    if (!translateConfigured(ctx)) throw new ApiError(501, 'NOT_CONFIGURED', 'Translation is not configured on this server');
    limitOrThrow(ctx.rl, `translate:${req.userId}`, 20, 60_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.encrypted) throw badRequest('Messages in a secret chat cannot be translated by the server');
    await ageGate(ctx, req.userId, req.isBot, a);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const [m] = await ctx.db.query('SELECT content FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (!m.content?.trim()) throw badRequest('Nothing to translate');
    const r = await translateText(ctx, `${p.mid}:${to.toLowerCase()}`, m.content, to);
    return { messageId: p.mid, to, text: r.text, detectedLanguage: r.detected, cached: r.cached };
  });

  // R19: edit history — prior contents of an edited message, newest first. Only the author and moderators (MANAGE_MESSAGES) may read it;
  // a moderator reading someone else's history leaves an audit entry. The oldest entry is the original text.
  app.get('/channels/:id/messages/:mid/edits', async (req) => {
    const p = parse(mm, req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, p.id);
    await ageGate(ctx, req.userId, req.isBot, a);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const [m] = await ctx.db.query('SELECT id, author_id FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    const own = m.author_id === req.userId;
    if (!own && !(a.channel.guild_id && has(a.perms, Perm.MANAGE_MESSAGES))) throw forbidden('Only the author and moderators can see the edit history');
    const rows = await ctx.db.query('SELECT id, message_id, content, edited_at FROM message_edits WHERE message_id = $1 ORDER BY id DESC LIMIT $2', [p.mid, limitParam(q.limit, 25, 100)]);
    if (!own && rows.length && a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_EDIT_HISTORY_VIEW', p.mid, { channelId: p.id, authorId: m.author_id, versions: rows.length });
    return rows.map((r) => ({ id: r.id as string, messageId: r.message_id as string, content: r.content as string, editedAt: iso(r.edited_at) ?? new Date().toISOString() }));
  });

  const removeMessages = async (channel: any, ids: string[]) => {
    const rows = await ctx.db.query('DELETE FROM messages WHERE channel_id = $1 AND id = ANY($2::text[]) RETURNING id, attachments', [channel.id, ids]);
    await deleteAttachmentFiles(ctx, rows.map((r) => r.attachments)).catch((e) => ctx.log.warn({ err: e }, 'attachment cleanup failed'));
    await settleLastMessage(ctx, [channel.id]);
    for (const r of rows) await ctx.hub.toChannel(channel.id, 'MESSAGE_DELETE', { id: r.id, channelId: channel.id, guildId: channel.guild_id ?? null });
    return rows.length;
  };
  app.delete('/channels/:id/messages/:mid', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    const [m] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    const byMod = m.author_id !== req.userId;
    if (byMod) { if (!a.channel.guild_id) throw forbidden(); need(a.perms, Perm.MANAGE_MESSAGES); }
    await removeMessages(a.channel, [p.mid]);
    if (byMod) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_DELETE', p.mid, { channelId: p.id, authorId: m.author_id });
    return reply.code(204).send();
  });
  app.post('/channels/:id/messages/bulk-delete', async (req, reply) => {
    const { id } = parse(cm, req.params);
    const { messageIds } = parse(z.object({ messageIds: z.array(idSchema).min(2).max(100) }).strict(), req.body);
    const a = await channelAccess(ctx, req.userId, id);
    if (!a.channel.guild_id) throw badRequest('Bulk delete is for guild channels');
    need(a.perms, Perm.MANAGE_MESSAGES);
    const n = await removeMessages(a.channel, [...new Set(messageIds)]);
    await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_BULK_DELETE', id, { count: n });
    return reply.code(204).send();
  });

  // ---------- reactions ----------
  const reactionEvent = async (name: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', channelId: string, messageId: string, userId: string, e: { emoji: string; emojiId: string | null }, burst: boolean, burstColor: string | null) =>
    ctx.hub.toChannel(channelId, name, { messageId, channelId, userId, emoji: e.emoji, emojiId: e.emojiId, burst, ...(burst && burstColor ? { burstColor } : {}) });
  app.put('/channels/:id/messages/:mid/reactions/:emoji/@me', async (req, reply) => {
    const p = parse(mm.extend({ emoji: emojiParam }), req.params);
    const b = parse(reactBody, req.body);
    const burst = b.burst ?? false;
    limitOrThrow(ctx.rl, `react:${req.userId}`, 30, 10_000, ctx.config.rateLimit);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.ADD_REACTIONS, Perm.READ_MESSAGE_HISTORY);
    if (a.channel.guild_id) await checkVerification(ctx, a.channel.guild_id, req.userId, a.perms);
    const e = parseEmoji(p.emoji);
    const [m] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
    if (!m) throw notFound('Message');
    if (e.emojiId) {
      const [em] = await ctx.db.query('SELECT guild_id, role_ids FROM emojis WHERE id = $1 AND name = $2', [e.emojiId, e.emoji]);
      if (!em) throw badRequest('Unknown custom emoji');
      if (em.guild_id !== a.channel.guild_id) need(a.perms, Perm.USE_EXTERNAL_EMOJIS);
      else if (!canUseEmoji(em.role_ids, a.gp?.memberRoleIds, a.perms)) throw forbidden('That emoji is restricted to certain roles', 'EMOJI_RESTRICTED');
    }
    const [c] = await ctx.db.query('SELECT count(DISTINCT emoji)::int AS n, bool_or(emoji = $2) AS has FROM reactions WHERE message_id = $1', [p.mid, e.emoji]);
    if (!c.has && c.n >= 20) throw new ApiError(400, 'MAX_REACTIONS', 'Too many different reactions');
    const burstColor = burst ? resolveBurstColor(b.burstColor) : null;
    // Only a genuinely new burst charges the daily allowance; re-sending the same one is a no-op.
    const [exists] = await ctx.db.query('SELECT 1 AS x FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3 AND burst = $4', [p.mid, req.userId, e.emoji, burst]);
    if (!exists && burst) await consumeBurstQuota(ctx, req.userId);
    const ins = await ctx.db.query('INSERT INTO reactions (message_id, user_id, emoji, emoji_id, burst, burst_color) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING user_id', [p.mid, req.userId, e.emoji, e.emojiId, burst, burstColor]);
    if (ins.length) await reactionEvent('MESSAGE_REACTION_ADD', p.id, p.mid, req.userId, e, burst, burstColor);
    return reply.code(204).send();
  });
  app.delete('/channels/:id/messages/:mid/reactions/:emoji/:target', async (req, reply) => {
    const p = parse(mm.extend({ emoji: emojiParam, target: z.union([z.literal('@me'), idSchema]) }), req.params);
    const q = parse(burstQuery, req.query);
    const burst = q.burst === 'true';
    const a = await channelAccess(ctx, req.userId, p.id);
    const userId = p.target === '@me' ? req.userId : p.target;
    if (userId !== req.userId) need(a.perms, Perm.MANAGE_MESSAGES);
    const e = parseEmoji(p.emoji);
    const del = await ctx.db.query('DELETE FROM reactions USING messages m WHERE reactions.message_id = $1 AND m.id = reactions.message_id AND m.channel_id = $2 AND reactions.user_id = $3 AND reactions.emoji = $4 AND reactions.burst = $5 RETURNING reactions.user_id, reactions.burst_color', [p.mid, p.id, userId, e.emoji, burst]);
    if (del.length) await reactionEvent('MESSAGE_REACTION_REMOVE', p.id, p.mid, userId, e, burst, burst ? (del[0]!.burst_color as string | null) : null);
    return reply.code(204).send();
  });
  app.get('/channels/:id/messages/:mid/reactions/:emoji', async (req) => {
    const p = parse(mm.extend({ emoji: emojiParam }), req.params);
    const q = parse(z.object({ limit: z.coerce.number().optional(), after: idSchema.optional(), burst: z.enum(['true', 'false']).optional() }), req.query);
    const a = await channelAccess(ctx, req.userId, p.id);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    const e = parseEmoji(p.emoji);
    const rows = await ctx.db.query(
      `SELECT r.user_id FROM reactions r JOIN messages m ON m.id = r.message_id WHERE r.message_id = $1 AND m.channel_id = $2 AND r.emoji = $3 AND r.burst = $4 AND ($5::text IS NULL OR r.user_id > $5) ORDER BY r.user_id LIMIT $6`,
      [p.mid, p.id, e.emoji, q.burst === 'true', q.after ?? null, limitParam(q.limit)]);
    const users = await usersByIds(ctx, rows.map((r) => r.user_id));
    return rows.map((r) => users.get(r.user_id)).filter(Boolean);
  });

  // ---------- pins ----------
  app.get('/channels/:id/pins', async (req) => {
    const { id } = parse(cm, req.params);
    const a = await channelAccess(ctx, req.userId, id);
    await ageGate(ctx, req.userId, req.isBot, a);
    need(a.perms, Perm.READ_MESSAGE_HISTORY);
    return messagesDTO(ctx, await ctx.db.query('SELECT * FROM messages WHERE channel_id = $1 AND pinned ORDER BY id DESC LIMIT $2', [id, LIMITS.maxPins]), req.userId);
  });
  app.put('/channels/:id/pins/:mid', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.guild_id) need(a.perms, Perm.PIN_MESSAGES);
    const [c] = await ctx.db.query('SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND pinned', [p.id]);
    if (c.n >= LIMITS.maxPins) throw new ApiError(400, 'MAX_PINS', `At most ${LIMITS.maxPins} pinned messages`);
    const rows = await ctx.db.query('UPDATE messages SET pinned = true WHERE id = $1 AND channel_id = $2 AND NOT pinned AND type IN (\'default\',\'reply\') RETURNING id', [p.mid, p.id]);
    if (rows.length) {
      await ctx.hub.toChannel(p.id, 'CHANNEL_PINS_UPDATE', { channelId: p.id });
      if (a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_PIN', p.mid, { channelId: p.id });
      await postSystemMessage(ctx, p.id, req.userId, 'pin', '').catch(() => {});
    } else {
      const [m] = await ctx.db.query('SELECT 1 AS x FROM messages WHERE id = $1 AND channel_id = $2', [p.mid, p.id]);
      if (!m) throw notFound('Message');
    }
    return reply.code(204).send();
  });
  app.delete('/channels/:id/pins/:mid', async (req, reply) => {
    const p = parse(mm, req.params);
    const a = await channelAccess(ctx, req.userId, p.id);
    if (a.channel.guild_id) need(a.perms, Perm.PIN_MESSAGES);
    const rows = await ctx.db.query('UPDATE messages SET pinned = false WHERE id = $1 AND channel_id = $2 AND pinned RETURNING id', [p.mid, p.id]);
    if (rows.length) { await ctx.hub.toChannel(p.id, 'CHANNEL_PINS_UPDATE', { channelId: p.id }); if (a.channel.guild_id) await audit(ctx, a.channel.guild_id, req.userId, 'MESSAGE_UNPIN', p.mid, { channelId: p.id }); }
    return reply.code(204).send();
  });

  // ---------- typing ----------
  app.post('/channels/:id/typing', async (req, reply) => {
    const { id } = parse(cm, req.params);
    limitOrThrow(ctx.rl, `typing:${req.userId}`, 15, 10_000, ctx.config.rateLimit);
    const a = await channelPermsLite(ctx, req.userId, id); // cached: no DB queries
    if (!a) throw notFound('Channel');
    need(a.perms, a.channel.type === 'thread' ? Perm.SEND_IN_THREADS : Perm.SEND_MESSAGES);
    await ctx.hub.toChannel(id, 'TYPING_START', { channelId: id, userId: req.userId, timestamp: Date.now() }, { exclude: req.userId });
    return reply.code(204).send();
  });

  // ---------- search ----------
  app.get('/guilds/:id/messages/search', async (req) => {
    const { id } = parse(cm, req.params);
    const q = parse(searchQuerySchema, req.query);
    limitOrThrow(ctx.rl, `search:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // full-scan queries are expensive
    if (!hasSearchCriteria(q)) throw badRequest('Provide q, author_id, mentions or has');
    await guildAccess(ctx, req.userId, id);
    let channels = (await visibleChannelRows(ctx, id, req.userId, Perm.READ_MESSAGE_HISTORY)).map((c) => c.id as string);
    if (q.channelId) channels = channels.filter((c) => c === q.channelId);
    if (channels.length && !req.isBot && !(await ageConfirmed(ctx, req.userId))) { // age-restricted channels stay out of search until 18+ is confirmed
      const nsfw = new Set((await ctx.db.query('SELECT id FROM channels WHERE id = ANY($1::text[]) AND nsfw', [channels])).map((r) => r.id as string));
      channels = channels.filter((c) => !nsfw.has(c));
    }
    if (!channels.length) return [];
    return searchMessages(ctx, { viewerId: req.userId, guildId: id, channelIds: channels, q: q.q, authorId: q.authorId, authorType: q.authorType, has: q.has, mentions: q.mentions, from: q.from, mentionsUser: q.mentionsUser, link: q.link, offset: q.offset, before: q.before, after: q.after, pinned: q.pinned, during: q.during, sortBy: q.sortBy, sortOrder: q.sortOrder, limit: limitParam(q.limit, 25) });
  });

  /** Search inside one channel the caller can read (this is how DMs and group DMs are searched). */
  app.get('/channels/:id/messages/search', async (req) => {
    const { id } = parse(cm, req.params);
    const q = parse(searchQuerySchema, req.query);
    limitOrThrow(ctx.rl, `search:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // full-scan queries are expensive
    if (!hasSearchCriteria(q)) throw badRequest('Provide q, author_id, mentions or has');
    const a = await channelAccess(ctx, req.userId, id);
    await ageGate(ctx, req.userId, req.isBot, a);
    if (!has(a.perms, Perm.READ_MESSAGE_HISTORY)) return [];
    return searchMessages(ctx, { viewerId: req.userId, channelIds: [id], q: q.q, authorId: q.authorId, authorType: q.authorType, has: q.has, mentions: q.mentions, from: q.from, mentionsUser: q.mentionsUser, link: q.link, offset: q.offset, before: q.before, after: q.after, pinned: q.pinned, during: q.during, sortBy: q.sortBy, sortOrder: q.sortOrder, limit: limitParam(q.limit, 25) });
  });
  /** Search across all of the caller's DMs and group DMs. */
  app.get('/users/@me/messages/search', async (req) => {
    const q = parse(searchQuerySchema, req.query);
    limitOrThrow(ctx.rl, `search:${req.userId}`, 30, 60_000, ctx.config.rateLimit); // full-scan queries are expensive
    if (!hasSearchCriteria(q)) throw badRequest('Provide q, author_id, mentions or has');
    const ids = (await ctx.db.query('SELECT channel_id FROM dm_participants WHERE user_id = $1', [req.userId])).map((r) => r.channel_id as string);
    return searchMessages(ctx, { viewerId: req.userId, channelIds: q.channelId ? ids.filter((c) => c === q.channelId) : ids, q: q.q, authorId: q.authorId, authorType: q.authorType, has: q.has, mentions: q.mentions, from: q.from, mentionsUser: q.mentionsUser, link: q.link, offset: q.offset, before: q.before, after: q.after, pinned: q.pinned, during: q.during, sortBy: q.sortBy, sortOrder: q.sortOrder, limit: limitParam(q.limit, 25) });
  });
}
