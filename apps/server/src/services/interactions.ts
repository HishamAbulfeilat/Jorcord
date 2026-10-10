import { z } from 'zod';
import {
  ComponentType, INTERACTION_ACK_DEADLINE_MS, INTERACTION_TOKEN_TTL_MS, InteractionCallbackType as CB, InteractionType as IT, MessageFlags, CommandType,
  snowflake, type Component, type Interaction, type Message,
} from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { ApiError, badRequest, forbidden, notFound } from '../errors';
import { findComponent, parseComponents, parseModal } from '../lib/components';
import { randomToken, safeEqual, sha256 } from '../lib/crypto';
import { limitOrThrow } from '../lib/ratelimit';
import { signInteraction } from '../lib/interactionSig';
import { safePost } from '../lib/safepost';
import { canUseCommand, validateInvocation } from './commands';
import { createMessage } from './messages';
import { DM_PERMS, loadGuildPerm, loadOverwrites, permsFor, type Access } from './perms';
import { isInstalled } from './apps';
import { memberDTO, messageDTO, userDTO } from './serializers';

const MAX_FOLLOWUPS = 10;
const ALLOWED_RESPONSE_FLAGS = MessageFlags.EPHEMERAL | MessageFlags.SUPPRESS_EMBEDS;

// ------------------------------------------------------------------ endpoint verification & delivery
async function signedPost(ctx: Ctx, app: any, url: string, payload: object) {
  const body = JSON.stringify(payload), ts = String(Math.floor(Date.now() / 1000));
  return safePost(url, body, { 'x-signature-ed25519': signInteraction(app.private_key_enc, ctx.config.jwtSecret, ts, body), 'x-signature-timestamp': ts }, { allowPrivate: ctx.config.allowPrivateUnfurl });
}
/** Setting an interactions endpoint URL requires it to answer a signed PING with {"type":1} (like Discord's endpoint verification). */
export async function pingInteractionsEndpoint(ctx: Ctx, app: any, url: string) {
  let u: URL; try { u = new URL(url); } catch { throw badRequest('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol) || (ctx.config.isProd && u.protocol !== 'https:')) throw badRequest('The interactions endpoint must be an https URL');
  const fail = (why: string) => new ApiError(400, 'INVALID_INTERACTIONS_ENDPOINT', `The interactions endpoint could not be verified: ${why}`);
  try {
    const r = await signedPost(ctx, app, url, { type: IT.PING, id: snowflake(), applicationId: app.id, version: 1 });
    if (r.status !== 200) throw fail(`HTTP ${r.status}`);
    let j: any; try { j = JSON.parse(r.body); } catch { throw fail('response is not JSON'); }
    if (j?.type !== CB.PONG) throw fail('expected {"type":1}');
  } catch (e) { if (e instanceof ApiError) throw e; throw fail('unreachable or blocked'); }
}

async function botChannelPerms(ctx: Ctx, botId: string, channel: any): Promise<bigint> {
  if (!channel.guild_id) return DM_PERMS;
  const gp = await loadGuildPerm(ctx, channel.guild_id, botId);
  if (!gp) return 0n;
  return permsFor(gp, await loadOverwrites(ctx, channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id));
}

async function payloadFor(ctx: Ctx, row: any, token: string, app: any, channel: any, userRow: any, extra: { data?: Interaction['data']; message?: unknown }): Promise<Interaction> {
  return {
    id: row.id, applicationId: app.id, type: row.type, token, version: 1, guildId: row.guild_id ?? null, channelId: row.channel_id ?? null, user: userDTO(ctx, userRow),
    ...(row.guild_id ? { member: await memberDTO(ctx, row.guild_id, row.user_id) } : {}), appPermissions: (await botChannelPerms(ctx, app.bot_user_id, channel)).toString(), locale: 'en-US',
    ...(extra.data ? { data: extra.data } : {}), ...(extra.message ? { message: extra.message } : {}),
  };
}

export async function failInteraction(ctx: Ctx, id: string) {
  const [r] = await ctx.db.query('UPDATE interactions SET expires_at = now() WHERE id = $1 AND NOT acked AND expires_at > now() RETURNING *', [id]);
  if (r) await ctx.hub.toUser(r.user_id, 'INTERACTION_FAILED', { id: r.id, applicationId: r.application_id, channelId: r.channel_id ?? null });
}

function deliver(ctx: Ctx, app: any, row: any, payload: Interaction) {
  const timer = setTimeout(() => void failInteraction(ctx, row.id).catch(() => {}), INTERACTION_ACK_DEADLINE_MS + 200);
  timer.unref();
  if (app.interactions_endpoint_url) {
    void (async () => {
      try {
        const r = await signedPost(ctx, app, app.interactions_endpoint_url, payload);
        if (r.status !== 200) return failInteraction(ctx, row.id);
        const j = JSON.parse(r.body);
        const [fresh] = await ctx.db.query('SELECT * FROM interactions WHERE id = $1', [row.id]);
        if (fresh) await applyCallback(ctx, fresh, j);
      } catch (e) { ctx.log.debug({ err: e }, 'interaction delivery failed'); await failInteraction(ctx, row.id).catch(() => {}); }
    })();
  } else if (!ctx.hub.isOnline(app.bot_user_id)) void failInteraction(ctx, row.id).catch(() => {});
  else void ctx.hub.toUser(app.bot_user_id, 'INTERACTION_CREATE', payload);
}

// ------------------------------------------------------------------ user -> interaction
const optionValue: z.ZodType<any> = z.lazy(() => z.object({ name: z.string().max(32), type: z.number().int(), value: z.union([z.string().max(6000), z.number(), z.boolean()]).optional(), options: z.array(optionValue).max(25).optional(), focused: z.boolean().optional() }).strict());
const modalRows = z.array(z.object({ type: z.literal(1), components: z.array(z.object({ type: z.literal(4), customId: z.string().max(100), value: z.string().max(4000) }).strict()).min(1).max(1) }).strict()).max(5);
const invokeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal(IT.APPLICATION_COMMAND), channelId: z.string().regex(/^\d{1,20}$/), data: z.object({ id: z.string().regex(/^\d{1,20}$/), options: z.array(optionValue).max(25).optional(), targetId: z.string().regex(/^\d{1,20}$/).optional() }).strict() }).strict(),
  z.object({ type: z.literal(IT.APPLICATION_COMMAND_AUTOCOMPLETE), channelId: z.string().regex(/^\d{1,20}$/), data: z.object({ id: z.string().regex(/^\d{1,20}$/), options: z.array(optionValue).max(25).optional(), targetId: z.string().regex(/^\d{1,20}$/).optional() }).strict() }).strict(),
  z.object({ type: z.literal(IT.MESSAGE_COMPONENT), channelId: z.string().regex(/^\d{1,20}$/), messageId: z.string().regex(/^\d{1,20}$/), data: z.object({ customId: z.string().max(100), values: z.array(z.string().max(100)).max(25).optional() }).strict() }).strict(),
  z.object({ type: z.literal(IT.MODAL_SUBMIT), channelId: z.string().regex(/^\d{1,20}$/), interactionId: z.string().regex(/^\d{1,20}$/), data: z.object({ customId: z.string().max(100), components: modalRows }).strict() }).strict(),
]);

async function newRow(ctx: Ctx, o: { app: any; type: number; userId: string; channel: any; messageId?: string | null; data: unknown }) {
  const id = snowflake(), token = randomToken(32);
  const [row] = await ctx.db.query(
    `INSERT INTO interactions (id, application_id, type, token_hash, user_id, guild_id, channel_id, message_id, data, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
    [id, o.app.id, o.type, sha256(token), o.userId, o.channel.guild_id ?? null, o.channel.id, o.messageId ?? null, JSON.stringify(o.data), new Date(Date.now() + INTERACTION_TOKEN_TTL_MS)]);
  return { row, token };
}

/** A user invokes a command / presses a component / submits a modal. Authorisation happens here; delivery to the bot is fire-and-forget. */
export async function invoke(ctx: Ctx, userId: string, raw: unknown, access: (channelId: string) => Promise<Access>): Promise<{ id: string }> {
  const b = invokeSchema.parse(raw);
  const a = await access(b.channelId);
  const channel = a.channel;
  if (['category', 'forum'].includes(channel.type)) throw badRequest('Interactions cannot be used in this channel');
  const [userRow] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [userId]);
  const mustReach = async (app: any) => { // bot must be able to act where the interaction happens
    if (channel.guild_id) { if (!(await isInstalled(ctx, app.id, channel.guild_id))) throw forbidden('The application is not installed in this server', 'MISSING_ACCESS').num(50001); }
    else if (!(await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channel.id, app.bot_user_id]))[0]) throw forbidden('This application is not part of the conversation', 'MISSING_ACCESS').num(50001);
  };

  if (b.type === IT.APPLICATION_COMMAND || b.type === IT.APPLICATION_COMMAND_AUTOCOMPLETE) {
    const [cmd] = await ctx.db.query('SELECT * FROM application_commands WHERE id = $1', [b.data.id]);
    if (!cmd) throw notFound('Command');
    const [app] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [cmd.application_id]);
    if (!app) throw notFound('Command');
    await mustReach(app);
    limitOrThrowUser(ctx, userId, app.id);
    const allowed = await canUseCommand(ctx, cmd, { guildId: channel.guild_id ?? null, userId, channelId: channel.id, perms: a.perms, memberRoleIds: a.gp?.memberRoleIds ?? [], channelParentId: channel.parent_id });
    if (!allowed) throw forbidden('You cannot use this command here').num(50013);
    if (cmd.nsfw && !channel.nsfw && channel.guild_id) throw forbidden('This command is age-restricted');
    const ac = b.type === IT.APPLICATION_COMMAND_AUTOCOMPLETE;
    if (ac && cmd.type !== CommandType.CHAT_INPUT) throw badRequest('Only slash commands autocomplete');
    const data: NonNullable<Interaction['data']> = { id: cmd.id, name: cmd.name, type: cmd.type, options: await validateInvocation(ctx, cmd.options ?? [], b.data.options, channel.guild_id ?? null, channel.id, ac) };
    let resolved: Record<string, unknown> | undefined;
    if (cmd.type === CommandType.USER) {
      if (!b.data.targetId) throw badRequest('targetId is required');
      const [t] = channel.guild_id ? await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1 AND user_id = $2', [channel.guild_id, b.data.targetId]) : await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channel.id, b.data.targetId]);
      if (!t) throw notFound('User');
      const [u] = await ctx.db.query('SELECT * FROM users WHERE id = $1', [b.data.targetId]);
      data.targetId = b.data.targetId; resolved = { users: { [b.data.targetId]: userDTO(ctx, u) } };
    } else if (cmd.type === CommandType.MESSAGE) {
      if (!b.data.targetId) throw badRequest('targetId is required');
      const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [b.data.targetId, channel.id]);
      if (!m) throw notFound('Message');
      data.targetId = b.data.targetId; resolved = { messages: { [m.id]: await messageDTO(ctx, m, userId) } };
    } else if (b.data.targetId) throw badRequest('targetId only applies to user and message commands');
    const { row, token } = await newRow(ctx, { app, type: b.type, userId, channel, data });
    const payload = await payloadFor(ctx, row, token, app, channel, userRow, { data: { ...data, ...(resolved ? { resolved } : {}) } as any });
    deliver(ctx, app, row, payload);
    return { id: row.id };
  }

  if (b.type === IT.MESSAGE_COMPONENT) {
    const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2', [b.messageId, channel.id]);
    let msgDto: Message | null = null, appId: string | null = null, comps: Component[] = [];
    if (m) { msgDto = await messageDTO(ctx, m, userId); appId = m.application_id; comps = m.components ?? []; }
    else {
      const [e] = await ctx.db.query('SELECT * FROM ephemeral_messages WHERE id = $1 AND channel_id = $2 AND recipient_id = $3', [b.messageId, channel.id, userId]); // only the recipient may see/use it
      if (!e) throw notFound('Message');
      msgDto = e.payload as Message; appId = e.application_id; comps = msgDto.components ?? [];
    }
    if (!appId) throw badRequest('This message has no interactive components');
    const [app] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [appId]);
    if (!app) throw notFound('Application');
    await mustReach(app);
    limitOrThrowUser(ctx, userId, app.id);
    const comp = findComponent(comps, b.data.customId);
    if (!comp) throw notFound('Message');
    if (comp.disabled) throw badRequest('This component is disabled');
    const values = b.data.values ?? [];
    if (comp.type === ComponentType.BUTTON) { if (values.length) throw badRequest('Buttons take no values'); }
    else {
      const min = comp.minValues ?? 1, max = comp.maxValues ?? 1;
      if (values.length < min || values.length > max) throw badRequest(`Choose between ${min} and ${max} values`);
      if (new Set(values).size !== values.length) throw badRequest('Duplicate values');
      if (comp.type === ComponentType.STRING_SELECT) { const ok = new Set((comp.options ?? []).map((o) => o.value)); if (values.some((v) => !ok.has(v))) throw badRequest('Unknown option value'); }
      else for (const v of values) {
        if (!/^\d{1,20}$/.test(v)) throw badRequest('Values must be ids');
        const gid = channel.guild_id ?? null;
        const found = comp.type === ComponentType.USER_SELECT ? await entityExists(ctx, 'user', v, gid, channel.id)
          : comp.type === ComponentType.ROLE_SELECT ? await entityExists(ctx, 'role', v, gid, channel.id)
          : comp.type === ComponentType.CHANNEL_SELECT ? await entityExists(ctx, 'channel', v, gid, channel.id)
          : (await entityExists(ctx, 'user', v, gid, channel.id)) || (await entityExists(ctx, 'role', v, gid, channel.id));
        if (!found) throw badRequest('Selected entity not found here');
      }
    }
    const data = { customId: comp.customId!, componentType: comp.type, ...(comp.type === ComponentType.BUTTON ? {} : { values }) };
    const { row, token } = await newRow(ctx, { app, type: IT.MESSAGE_COMPONENT, userId, channel, messageId: b.messageId, data });
    const eph = !m;
    if (eph) await ctx.db.query('UPDATE interactions SET ephemeral = true WHERE id = $1', [row.id]);
    deliver(ctx, app, row, await payloadFor(ctx, row, token, app, channel, userRow, { data, message: msgDto }));
    return { id: row.id };
  }

  if (b.type === IT.MODAL_SUBMIT) {
    const [orig] = await ctx.db.query('SELECT * FROM interactions WHERE id = $1 AND user_id = $2 AND channel_id = $3 AND expires_at > now()', [b.interactionId, userId, channel.id]);
    const modal = orig?.modal as { customId: string; components: { components: Component[] }[] } | null;
    if (!orig || !modal || modal.customId !== b.data.customId) throw notFound('Interaction');
    const defs = modal.components.map((r) => r.components[0]!);
    const given = new Map(b.data.components.map((r) => [r.components[0]!.customId, r.components[0]!.value]));
    if (given.size !== b.data.components.length || [...given.keys()].some((k) => !defs.find((d) => d.customId === k))) throw badRequest('Unknown or duplicate text input');
    for (const d of defs) {
      const v = given.get(d.customId!) ?? '';
      if ((d.required ?? true) && !v.length) throw badRequest(`${d.label ?? d.customId} is required`);
      if (v.length && (v.length < (d.minLength ?? 0) || v.length > (d.maxLength ?? 4000))) throw badRequest(`${d.label ?? d.customId} has an invalid length`);
      if (d.textStyle !== 2 && /[\r\n]/.test(v)) throw badRequest(`${d.label ?? d.customId} must be a single line`);
    }
    const [claim] = await ctx.db.query('UPDATE interactions SET modal = NULL WHERE id = $1 AND modal IS NOT NULL RETURNING id', [orig.id]); // a modal is submitted once
    if (!claim) throw notFound('Interaction');
    const [app] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [orig.application_id]);
    await mustReach(app);
    limitOrThrowUser(ctx, userId, app.id);
    const data = { customId: b.data.customId, components: b.data.components as any };
    const { row, token } = await newRow(ctx, { app, type: IT.MODAL_SUBMIT, userId, channel, messageId: orig.message_id, data });
    if (orig.ephemeral) await ctx.db.query('UPDATE interactions SET ephemeral = true WHERE id = $1', [row.id]);
    let message: Message | undefined;
    if (orig.message_id) { const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [orig.message_id]); if (m) message = await messageDTO(ctx, m, userId); }
    deliver(ctx, app, row, await payloadFor(ctx, row, token, app, channel, userRow, { data, message }));
    return { id: row.id };
  }
  throw badRequest('Unsupported interaction type');
}

const limitOrThrowUser = (ctx: Ctx, userId: string, appId: string) => limitOrThrow(ctx.rl, `ix:${userId}:${appId}`, 30, 60_000, ctx.config.rateLimit);

async function entityExists(ctx: Ctx, kind: 'user' | 'role' | 'channel', id: string, guildId: string | null, channelId: string): Promise<boolean> {
  if (kind === 'user') return !!(guildId ? (await ctx.db.query('SELECT 1 AS x FROM members WHERE guild_id = $1 AND user_id = $2', [guildId, id]))[0] : (await ctx.db.query('SELECT 1 AS x FROM dm_participants WHERE channel_id = $1 AND user_id = $2', [channelId, id]))[0]);
  if (!guildId) return false;
  return !!(await ctx.db.query(kind === 'role' ? 'SELECT 1 AS x FROM roles WHERE guild_id = $1 AND id = $2' : 'SELECT 1 AS x FROM channels WHERE guild_id = $1 AND id = $2', [guildId, id]))[0];
}

// ------------------------------------------------------------------ app -> response (callback + followups)
export async function loadInteraction(ctx: Ctx, id: string, token: string): Promise<any> {
  const [row] = await ctx.db.query('SELECT * FROM interactions WHERE id = $1', [id]);
  if (!row || !safeEqual(row.token_hash, sha256(token)) || new Date(row.expires_at).getTime() <= Date.now()) throw notFound('Interaction'); // 10062 for any mismatch (no oracle)
  return row;
}

const messageData = z.object({
  content: z.string().max(4000).optional(), components: z.unknown().optional(), flags: z.number().int().min(0).optional(),
}).strict();
const callbackSchema = z.object({ type: z.number().int(), data: z.unknown().optional() }).strict();

function parseMessageData(raw: unknown, needsBody: boolean) {
  const d = messageData.parse(raw ?? {});
  if ((d.flags ?? 0) & ~ALLOWED_RESPONSE_FLAGS) throw badRequest('Unsupported message flags');
  const components = d.components !== undefined ? parseComponents(d.components) : undefined;
  if (needsBody && !d.content?.length && !components?.length) throw badRequest('A response needs content or components');
  return { content: d.content, components, flags: d.flags ?? 0 };
}

const metaFor = (row: any, name: string | null) => ({ id: row.id, type: row.type, name, userId: row.user_id });
const nameOf = (row: any): string | null => (row.type === IT.APPLICATION_COMMAND ? (row.data?.name ?? null) : null);

async function ephemeralCreate(ctx: Ctx, row: any, app: any, d: { content?: string; components?: Component[]; flags: number }, replaceId?: string): Promise<Message> {
  const id = replaceId ?? snowflake();
  const fake = {
    id, channel_id: row.channel_id, guild_id: row.guild_id, author_id: app.bot_user_id, content: d.content ?? '', edited_at: null, type: 'default', reply_to: null, mention_everyone: false,
    mentions: [], mention_roles: [], attachments: [], embeds: [], sticker_ids: [], pinned: false, thread_id: null, webhook_id: null, flags: d.flags | MessageFlags.EPHEMERAL,
    components: d.components ?? [], application_id: app.id, interaction: metaFor(row, nameOf(row)),
  };
  const dto = await messageDTO(ctx, fake, null);
  await ctx.db.query('INSERT INTO ephemeral_messages (id, interaction_id, application_id, recipient_id, channel_id, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [id, row.id, app.id, row.user_id, row.channel_id, JSON.stringify(dto)]);
  await ctx.hub.toUser(row.user_id, 'MESSAGE_CREATE', dto);
  return dto;
}

async function publicCreate(ctx: Ctx, row: any, app: any, d: { content?: string; components?: Component[]; flags: number }, loading = false): Promise<Message> {
  const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1', [row.channel_id]);
  if (!channel) throw notFound('Channel');
  return createMessage(ctx, {
    channel, authorId: app.bot_user_id, content: d.content ?? '', components: d.components, flags: d.flags | (loading ? MessageFlags.LOADING : 0), applicationId: app.id,
    interaction: metaFor(row, nameOf(row)), senderPerms: 0n, skipChecks: true, allowEmpty: loading,
  });
}

/** Applies an app's initial response. Used by the callback route and by HTTP-endpoint deliveries. */
export async function applyCallback(ctx: Ctx, row: any, raw: unknown): Promise<{ message?: Message } | void> {
  const cb = callbackSchema.parse(raw);
  const [app] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [row.application_id]);
  if (!app) throw notFound('Application');
  if (row.acked) throw new ApiError(400, 'INTERACTION_ACKNOWLEDGED', 'Interaction has already been acknowledged').num(40060);
  if (Date.now() - new Date(row.created_at).getTime() > INTERACTION_ACK_DEADLINE_MS + 200) { await failInteraction(ctx, row.id); throw notFound('Interaction'); }
  const isComponentLike = row.type === IT.MESSAGE_COMPONENT || (row.type === IT.MODAL_SUBMIT && row.message_id);
  const claim = async (set = '') => {
    const [r] = await ctx.db.query(`UPDATE interactions SET acked = true${set} WHERE id = $1 AND NOT acked AND expires_at > now() RETURNING *`, [row.id]);
    if (!r) throw new ApiError(400, 'INTERACTION_ACKNOWLEDGED', 'Interaction has already been acknowledged').num(40060);
    return r;
  };

  switch (cb.type) {
    case CB.CHANNEL_MESSAGE_WITH_SOURCE: {
      if (row.type === IT.APPLICATION_COMMAND_AUTOCOMPLETE) throw badRequest('Autocomplete interactions take type 8');
      const d = parseMessageData(cb.data, true);
      const eph = !!(d.flags & MessageFlags.EPHEMERAL);
      await claim(eph ? ', ephemeral = true' : '');
      const message = eph ? await ephemeralCreate(ctx, row, app, d) : await publicCreate(ctx, row, app, d);
      await ctx.db.query('UPDATE interactions SET response_message_id = $2 WHERE id = $1', [row.id, message.id]);
      return { message };
    }
    case CB.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: {
      if (row.type === IT.APPLICATION_COMMAND_AUTOCOMPLETE) throw badRequest('Autocomplete interactions take type 8');
      const d = parseMessageData(cb.data, false);
      const eph = !!(d.flags & MessageFlags.EPHEMERAL);
      await claim(`, deferred = true${eph ? ', ephemeral = true' : ''}`);
      if (!eph) { const message = await publicCreate(ctx, row, app, { flags: d.flags }, true); await ctx.db.query('UPDATE interactions SET response_message_id = $2 WHERE id = $1', [row.id, message.id]); return { message }; }
      return;
    }
    case CB.DEFERRED_UPDATE_MESSAGE: {
      if (!isComponentLike) throw badRequest('Only component and modal interactions can be deferred-updated');
      await claim(', deferred_update = true');
      return;
    }
    case CB.UPDATE_MESSAGE: {
      if (!isComponentLike || !row.message_id) throw badRequest('Only component interactions can update a message');
      const d = parseMessageData(cb.data, false);
      await claim();
      const message = await editMessage(ctx, row, app, row.message_id, d, true);
      await ctx.db.query('UPDATE interactions SET response_message_id = $2 WHERE id = $1', [row.id, row.message_id]);
      return { message };
    }
    case CB.APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: {
      if (row.type !== IT.APPLICATION_COMMAND_AUTOCOMPLETE) throw badRequest('Only autocomplete interactions take type 8');
      const d = z.object({ choices: z.array(z.object({ name: z.string().min(1).max(100), value: z.union([z.string().max(100), z.number().finite()]) }).strict()).max(25) }).strict().parse(cb.data);
      await claim();
      await ctx.hub.toUser(row.user_id, 'INTERACTION_AUTOCOMPLETE_RESULT', { interactionId: row.id, applicationId: app.id, choices: d.choices });
      return;
    }
    case CB.MODAL: {
      if (row.type !== IT.APPLICATION_COMMAND && row.type !== IT.MESSAGE_COMPONENT) throw badRequest('This interaction cannot open a modal');
      const modal = parseModal(cb.data);
      await claim();
      await ctx.db.query('UPDATE interactions SET modal = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(modal)]);
      await ctx.hub.toUser(row.user_id, 'INTERACTION_MODAL', { interactionId: row.id, applicationId: app.id, modal });
      return;
    }
    default: throw badRequest('Unsupported callback type');
  }
}

/** Edits a message this interaction may touch: its original/followups (interaction id matches) or, for component updates, the component's own message. */
async function editMessage(ctx: Ctx, row: any, app: any, messageId: string, d: { content?: string; components?: Component[]; flags: number }, componentSource = false): Promise<Message> {
  const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2 AND application_id = $3', [messageId, row.channel_id, app.id]);
  if (m && (componentSource || m.interaction?.id === row.id)) {
    const sets = ['edited_at = now()'], vals: unknown[] = [m.id];
    if (d.content !== undefined) { vals.push(d.content); sets.push(`content = $${vals.length}`); }
    if (d.components !== undefined) { vals.push(JSON.stringify(d.components)); sets.push(`components = $${vals.length}::jsonb`); }
    if (m.flags & MessageFlags.LOADING) sets.push(`flags = flags & ~${MessageFlags.LOADING}`);
    if (componentSource) sets.splice(0, 1); // component updates are not "edited"
    await ctx.db.query(`UPDATE messages SET ${sets.join(', ')} WHERE id = $1`, vals);
    const [fresh] = await ctx.db.query('SELECT * FROM messages WHERE id = $1', [m.id]);
    const dto = await messageDTO(ctx, fresh, null);
    await ctx.hub.toChannel(row.channel_id, 'MESSAGE_UPDATE', { ...dto, reactions: dto.reactions.map((r) => ({ ...r, me: false })) });
    return dto;
  }
  const [e] = await ctx.db.query('SELECT * FROM ephemeral_messages WHERE id = $1 AND application_id = $2 AND channel_id = $3 AND recipient_id = $4', [messageId, app.id, row.channel_id, row.user_id]);
  if (!e || (!componentSource && e.interaction_id !== row.id)) throw notFound('Message');
  const dto = { ...(e.payload as Message), ...(d.content !== undefined ? { content: d.content } : {}), ...(d.components !== undefined ? { components: d.components } : {}), editedAt: componentSource ? (e.payload as Message).editedAt : new Date().toISOString() };
  await ctx.db.query('UPDATE ephemeral_messages SET payload = $2::jsonb WHERE id = $1', [e.id, JSON.stringify(dto)]);
  await ctx.hub.toUser(row.user_id, 'MESSAGE_UPDATE', dto);
  return dto;
}

export async function createFollowup(ctx: Ctx, row: any, raw: unknown): Promise<Message> {
  const [app] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [row.application_id]);
  if (!row.acked) throw badRequest('Respond to the interaction before sending followups');
  const d = parseMessageData(raw, true);
  const eph = !!(d.flags & MessageFlags.EPHEMERAL);
  // First followup after a deferred response fills the "thinking" placeholder.
  if (row.deferred && !row.response_message_id && !eph === !row.ephemeral) {
    const [claim] = await ctx.db.query('UPDATE interactions SET response_message_id = $2 WHERE id = $1 AND response_message_id IS NULL RETURNING id', [row.id, 'pending']);
    if (claim) {
      try {
        const message = row.ephemeral ? await ephemeralCreate(ctx, row, app, d) : await publicCreate(ctx, row, app, d);
        await ctx.db.query('UPDATE interactions SET response_message_id = $2 WHERE id = $1', [row.id, message.id]);
        return message;
      } catch (e) { await ctx.db.query('UPDATE interactions SET response_message_id = NULL WHERE id = $1', [row.id]); throw e; }
    }
  }
  if (row.deferred && row.response_message_id && row.response_message_id !== 'pending') {
    const [m] = await ctx.db.query('SELECT flags FROM messages WHERE id = $1', [row.response_message_id]);
    if (m && (m.flags & MessageFlags.LOADING) && !eph) return editMessage(ctx, row, app, row.response_message_id, d);
  }
  const [c] = await ctx.db.query('UPDATE interactions SET followups = followups + 1 WHERE id = $1 AND followups < $2 RETURNING followups', [row.id, MAX_FOLLOWUPS]);
  if (!c) throw new ApiError(400, 'TOO_MANY_FOLLOWUPS', `At most ${MAX_FOLLOWUPS} followup messages per interaction`);
  return eph ? ephemeralCreate(ctx, row, app, d) : publicCreate(ctx, row, app, d);
}

const originalId = (row: any): string | null => (row.response_message_id && row.response_message_id !== 'pending' ? row.response_message_id : row.deferred_update ? row.message_id : null);
export async function editFollowup(ctx: Ctx, row: any, mid: string, raw: unknown): Promise<Message> {
  const [app] = await ctx.db.query('SELECT * FROM applications WHERE id = $1', [row.application_id]);
  const target = mid === '@original' ? originalId(row) : mid;
  if (!target) throw notFound('Message');
  const d = parseMessageData(raw, false);
  if (d.flags) throw badRequest('Flags cannot be changed');
  const componentSource = target === row.message_id && !!row.deferred_update;
  return editMessage(ctx, row, app, target, d, componentSource);
}
export async function getFollowup(ctx: Ctx, row: any, mid: string): Promise<Message> {
  const target = mid === '@original' ? originalId(row) : mid;
  if (!target) throw notFound('Message');
  const [m] = await ctx.db.query('SELECT * FROM messages WHERE id = $1 AND channel_id = $2 AND application_id = $3 AND (interaction->>\'id\' = $4 OR id = $5)', [target, row.channel_id, row.application_id, row.id, row.message_id ?? '']);
  if (m) return messageDTO(ctx, m, null);
  const [e] = await ctx.db.query('SELECT payload FROM ephemeral_messages WHERE id = $1 AND interaction_id = $2', [target, row.id]);
  if (!e) throw notFound('Message');
  return e.payload as Message;
}
export async function deleteFollowup(ctx: Ctx, row: any, mid: string): Promise<void> {
  const target = mid === '@original' ? originalId(row) : mid;
  if (!target) throw notFound('Message');
  const [m] = await ctx.db.query('SELECT id FROM messages WHERE id = $1 AND channel_id = $2 AND application_id = $3 AND interaction->>\'id\' = $4', [target, row.channel_id, row.application_id, row.id]);
  if (m) { await ctx.db.query('DELETE FROM messages WHERE id = $1', [m.id]); await ctx.hub.toChannel(row.channel_id, 'MESSAGE_DELETE', { id: m.id, channelId: row.channel_id, guildId: row.guild_id ?? null }); return; }
  const [e] = await ctx.db.query('DELETE FROM ephemeral_messages WHERE id = $1 AND interaction_id = $2 RETURNING id', [target, row.id]);
  if (!e) throw notFound('Message');
  await ctx.hub.toUser(row.user_id, 'MESSAGE_DELETE', { id: target, channelId: row.channel_id, guildId: row.guild_id ?? null });
}
