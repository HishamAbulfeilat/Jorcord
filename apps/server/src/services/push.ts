import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import https from 'node:https';
import net from 'node:net';
import { join } from 'node:path';
import { SignJWT, importPKCS8 } from 'jose';
import webpush from 'web-push';
import type { Message } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { safeLookup } from '../lib/ssrf';
import { viewersAmong } from './perms';

export type PushKind = 'dm' | 'mention' | 'reply' | 'message' | 'friend_request' | 'friend_accept' | 'call';

export interface PushPayload {
  kind: PushKind; title: string; body: string; tag: string;
  channelId?: string; guildId?: string | null; messageId?: string; userId?: string;
}
export interface PushDevice { id: string; userId: string; platform: 'web' | 'android' | 'ios' | 'desktop'; token: string; keys: { p256dh: string; auth: string } | null }
/** 'gone' = the device token is permanently invalid and should be forgotten. */
export type PushResult = 'ok' | 'gone' | 'error';
export type PushSender = (dev: PushDevice, payload: PushPayload) => Promise<PushResult>;

export interface PushService {
  vapidPublicKey: string;
  /** Replaceable transports (tests swap these). fcm/apns are null when not configured. */
  senders: { web: PushSender; fcm: PushSender | null; apns: PushSender | null };
  /** Resolves when every notification started so far has been handed to a transport. */
  flush(): Promise<void>;
  notifyMessage(channel: any, msg: Message): void;
  notifyFriendRequest(toUserId: string, from: { id: string; username: string; displayName: string | null }, accepted?: boolean): void;
  notifyCall(channel: any, callerId: string): void;
  /** Deliver to the given users without any preference filtering (callers filter). */
  deliver(userIds: string[], payload: PushPayload): Promise<void>;
}

const PREVIEW_MAX = 140;
const TTL_SECONDS = { call: 30, default: 3600 };

/** Message text suitable for a lock screen: mention markup collapsed, whitespace flattened, truncated. */
export function previewText(content: string, attachments: number): string {
  const t = content.replace(/<@&\d+>/g, '@role').replace(/<@!?\d+>/g, '@user').replace(/<#\d+>/g, '#channel').replace(/<a?:(\w+):\d+>/g, ':$1:').replace(/\s+/g, ' ').trim();
  if (!t) return attachments ? (attachments === 1 ? 'Sent an attachment' : `Sent ${attachments} attachments`) : '';
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX - 1)}…` : t;
}

/**
 * A web push endpoint is a URL the *server* will POST to, so it is an SSRF vector: require https on 443, a real DNS name
 * (no IP literals / localhost / internal TLDs). The connection itself is additionally pinned with safeLookup.
 */
export function validatePushEndpoint(endpoint: string): boolean {
  let u: URL; try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return false;
  if (!host.includes('.') || host === 'localhost' || /\.(localhost|local|internal|lan|home|corp|intranet)$/.test(host)) return false;
  return true;
}

interface Settings { muted: boolean; mutedUntil: number | null; suppressEveryone: boolean; suppressRoles: boolean; level: string | null }
const mutedNow = (s: Settings | undefined) => !!s && s.muted && (s.mutedUntil === null || s.mutedUntil > Date.now());

type Reason = 'dm' | 'mention' | 'reply' | 'role' | 'everyone' | 'all';
const REASON_RANK: Record<Reason, number> = { dm: 0, mention: 1, reply: 2, role: 3, everyone: 4, all: 5 };

/**
 * Applies the delivery rules shared by every notification type: not the sender, not currently on a gateway session,
 * push enabled, not on Do Not Disturb, not blocked, and guild/channel mute + suppress settings.
 */
export async function filterRecipients(ctx: Ctx, cands: Map<string, Reason>, o: { authorId: string | null; guildId?: string | null; channelIds?: string[]; respectBlocks?: boolean }): Promise<string[]> {
  if (o.authorId) cands.delete(o.authorId);
  for (const id of [...cands.keys()]) if (ctx.hub.isOnline(id)) cands.delete(id); // they see it live in the app
  if (!cands.size) return [];
  const ids = [...cands.keys()];
  const users = await ctx.db.query('SELECT id, presence, push_enabled FROM users WHERE id = ANY($1::text[]) AND deleted_at IS NULL', [ids]);
  const ok = new Set(users.filter((u) => u.push_enabled && u.presence !== 'dnd').map((u) => u.id as string));
  for (const id of ids) if (!ok.has(id)) cands.delete(id);
  if (!cands.size) return [];
  if (o.respectBlocks && o.authorId) {
    const blocked = await ctx.db.query(`SELECT user_id FROM relationships WHERE other_id = $1 AND type = 'blocked' AND user_id = ANY($2::text[])`, [o.authorId, [...cands.keys()]]);
    for (const b of blocked) cands.delete(b.user_id);
  }
  const channelIds = o.channelIds ?? [];
  if (o.guildId || channelIds.length) {
    const rows = await ctx.db.query(
      `SELECT user_id, scope, target_id, muted, muted_until, suppress_everyone, suppress_roles, level FROM notification_settings
        WHERE user_id = ANY($1::text[]) AND ((scope = 'guild' AND target_id = $2) OR (scope = 'channel' AND target_id = ANY($3::text[])))`,
      [[...cands.keys()], o.guildId ?? '', channelIds]);
    const guild = new Map<string, Settings>(), chan = new Map<string, Settings[]>();
    for (const r of rows) {
      const s: Settings = { muted: r.muted, mutedUntil: r.muted_until ? new Date(r.muted_until).getTime() : null, suppressEveryone: r.suppress_everyone, suppressRoles: r.suppress_roles, level: r.level ?? null };
      if (r.scope === 'guild') guild.set(r.user_id, s); else chan.set(r.user_id, [...(chan.get(r.user_id) ?? []), s]);
    }
    for (const [id, reason] of [...cands]) {
      const g = guild.get(id);
      if (mutedNow(g) || g?.level === 'none' || (chan.get(id) ?? []).some(mutedNow)) { cands.delete(id); continue; }
      if (reason === 'everyone' && g?.suppressEveryone) cands.delete(id);
      else if (reason === 'role' && g?.suppressRoles) cands.delete(id);
    }
  }
  return [...cands.keys()];
}

function loadVapid(ctx: Pick<Ctx, 'config' | 'log'>): { publicKey: string; privateKey: string } {
  const v = ctx.config.push.vapid;
  if (v.publicKey && v.privateKey) return { publicKey: v.publicKey, privateKey: v.privateKey };
  const file = join(ctx.config.dataDir, 'vapid.json');
  try { if (existsSync(file)) { const j = JSON.parse(readFileSync(file, 'utf8')); if (j.publicKey && j.privateKey) return j; } } catch { /* regenerate */ }
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(ctx.config.dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
  ctx.log.info('generated VAPID keys into data dir');
  return keys;
}

// ---------------------------------------------------------------- transports

function webSender(ctx: Pick<Ctx, 'config' | 'log'>, vapid: { publicKey: string; privateKey: string }): PushSender {
  const agent = new https.Agent({ lookup: safeLookup(false), keepAlive: true, maxSockets: 32 }); // endpoint IPs are validated at connect time (DNS rebinding safe)
  return async (dev, payload) => {
    if (!dev.keys) return 'gone';
    try {
      await webpush.sendNotification({ endpoint: dev.token, keys: dev.keys }, JSON.stringify(payload), {
        vapidDetails: { subject: ctx.config.push.vapid.subject, ...vapid }, TTL: payload.kind === 'call' ? TTL_SECONDS.call : TTL_SECONDS.default,
        urgency: payload.kind === 'call' ? 'high' : 'normal', timeout: 10_000, agent, topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined,
      });
      return 'ok';
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) return 'gone';
      ctx.log.warn({ status: e?.statusCode, code: e?.code }, 'web push failed');
      return 'error';
    }
  };
}

function fcmSender(ctx: Pick<Ctx, 'log'>, raw: string): PushSender | null {
  let sa: { project_id: string; client_email: string; private_key: string };
  try { sa = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')); } catch { ctx.log.warn('FCM_SERVICE_ACCOUNT is not valid JSON; FCM disabled'); return null; }
  if (!sa.project_id || !sa.client_email || !sa.private_key) { ctx.log.warn('FCM service account incomplete; FCM disabled'); return null; }
  let cached: { token: string; exp: number } | null = null;
  const accessToken = async (): Promise<string> => {
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
    const key = await importPKCS8(sa.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(sa.client_email).setSubject(sa.client_email)
      .setAudience('https://oauth2.googleapis.com/token').setIssuedAt().setExpirationTime('55m').sign(key);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(10_000),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`fcm oauth ${r.status}`);
    cached = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 };
    return cached.token;
  };
  return async (dev, p) => {
    try {
      const data: Record<string, string> = { kind: p.kind, tag: p.tag };
      if (p.channelId) data.channelId = p.channelId; if (p.guildId) data.guildId = p.guildId; if (p.messageId) data.messageId = p.messageId; if (p.userId) data.userId = p.userId;
      const r = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(sa.project_id)}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ message: {
          token: dev.token, notification: { title: p.title, body: p.body }, data,
          android: { priority: 'HIGH', ttl: `${p.kind === 'call' ? TTL_SECONDS.call : TTL_SECONDS.default}s`, collapse_key: p.tag, notification: { channel_id: p.kind === 'call' ? 'calls' : 'messages', tag: p.tag } },
          apns: { headers: { 'apns-priority': '10', 'apns-collapse-id': p.tag.slice(0, 64) }, payload: { aps: { sound: 'default', 'thread-id': p.tag } } },
        } }),
      });
      if (r.ok) return 'ok';
      const j: any = await r.json().catch(() => ({}));
      const code = JSON.stringify(j?.error?.details ?? '') + (j?.error?.status ?? '');
      if (r.status === 404 || /UNREGISTERED/.test(code) || (/INVALID_ARGUMENT/.test(code) && /registration token/i.test(j?.error?.message ?? ''))) return 'gone';
      if (r.status === 401) cached = null;
      ctx.log.warn({ status: r.status }, 'fcm push failed');
      return 'error';
    } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'fcm push failed'); return 'error'; }
  };
}

function apnsSender(ctx: Pick<Ctx, 'log'>, cfg: NonNullable<Ctx['config']['push']['apns']>): PushSender {
  let jwt: { token: string; at: number } | null = null;
  const bearer = async () => {
    if (jwt && Date.now() - jwt.at < 40 * 60_000) return jwt.token;
    const key = await importPKCS8(cfg.key, 'ES256');
    jwt = { token: await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: cfg.keyId }).setIssuer(cfg.teamId).setIssuedAt().sign(key), at: Date.now() };
    return jwt.token;
  };
  const host = cfg.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com';
  return async (dev, p) => {
    if (!/^[0-9a-f]{64,200}$/i.test(dev.token)) return 'gone';
    try {
      const auth = await bearer();
      return await new Promise<PushResult>((resolve) => {
        const session = http2.connect(host);
        const done = (r: PushResult) => { resolve(r); session.close(); };
        const timer = setTimeout(() => done('error'), 10_000); timer.unref();
        session.on('error', () => { clearTimeout(timer); done('error'); });
        const req = session.request({
          ':method': 'POST', ':path': `/3/device/${dev.token}`, authorization: `bearer ${auth}`, 'apns-topic': cfg.topic, 'apns-push-type': 'alert',
          'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + (p.kind === 'call' ? TTL_SECONDS.call : TTL_SECONDS.default)), 'apns-collapse-id': p.tag.slice(0, 64),
        });
        let status = 0; let body = '';
        req.on('response', (h) => { status = Number(h[':status']); });
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          clearTimeout(timer);
          if (status === 200) return done('ok');
          if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body)) return done('gone');
          if (status === 403) jwt = null;
          ctx.log.warn({ status }, 'apns push failed'); done('error');
        });
        req.on('error', () => { clearTimeout(timer); done('error'); });
        req.end(JSON.stringify({ aps: { alert: { title: p.title, body: p.body }, sound: 'default', 'thread-id': p.tag }, kind: p.kind, channelId: p.channelId, guildId: p.guildId, messageId: p.messageId, userId: p.userId }));
      });
    } catch (e) { ctx.log.warn({ err: (e as Error).message }, 'apns push failed'); return 'error'; }
  };
}

// ---------------------------------------------------------------- service

export function createPush(ctx: Ctx): PushService {
  const vapid = loadVapid(ctx);
  const pending = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => { const w = p.catch((e) => ctx.log.warn({ err: (e as Error)?.message }, 'push notify failed')).finally(() => pending.delete(w)); pending.add(w); };
  const cfg = ctx.config.push;
  const svc: PushService = {
    vapidPublicKey: vapid.publicKey,
    senders: { web: webSender(ctx, vapid), fcm: cfg.fcmServiceAccount ? fcmSender(ctx, cfg.fcmServiceAccount) : null, apns: cfg.apns ? apnsSender(ctx, cfg.apns) : null },
    async flush() { while (pending.size) await Promise.all([...pending]); },

    async deliver(userIds, payload) {
      if (!userIds.length) return;
      const rows = await ctx.db.query('SELECT * FROM push_devices WHERE user_id = ANY($1::text[])', [userIds]);
      const gone: string[] = [];
      const route = (d: PushDevice): PushSender | null => {
        if (d.keys) return svc.senders.web;
        if (d.platform === 'android') return svc.senders.fcm;
        if (d.platform === 'ios') return svc.senders.apns && /^[0-9a-f]{64,200}$/i.test(d.token) ? svc.senders.apns : svc.senders.fcm; // raw APNs token vs Firebase-issued token
        return null;
      };
      for (let i = 0; i < rows.length; i += 25) {
        await Promise.all(rows.slice(i, i + 25).map(async (r) => {
          const dev: PushDevice = { id: r.id, userId: r.user_id, platform: r.platform, token: r.token, keys: r.keys ?? null };
          const send = route(dev); if (!send) return;
          if ((await send(dev, payload)) === 'gone') gone.push(dev.id);
        }));
      }
      if (gone.length) await ctx.db.query('DELETE FROM push_devices WHERE id = ANY($1::text[])', [gone]);
    },

    notifyMessage(channel, msg) {
      if (msg.type !== 'default' && msg.type !== 'reply') return;
      track(notifyMessage(ctx, svc, channel, msg));
    },
    notifyFriendRequest(toUserId, from, accepted = false) {
      const name = from.displayName || from.username;
      track((async () => {
        const to = await filterRecipients(ctx, new Map([[toUserId, 'dm' as Reason]]), { authorId: from.id });
        await svc.deliver(to, { kind: accepted ? 'friend_accept' : 'friend_request', title: name, body: accepted ? 'accepted your friend request' : 'sent you a friend request', tag: `friend-${from.id}`, userId: from.id });
      })());
    },
    notifyCall(channel, callerId) {
      if (ctx.config.rateLimit && ctx.rl.hit(`ring:${channel.id}:${callerId}`, 3, 60_000)) return; // redial spam
      track((async () => {
        const [caller] = await ctx.db.query('SELECT username, display_name FROM users WHERE id = $1', [callerId]);
        const parts = await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1', [channel.id]);
        const to = await filterRecipients(ctx, new Map(parts.map((p) => [p.user_id as string, 'dm' as Reason])), { authorId: callerId, respectBlocks: true });
        const name = caller?.display_name || caller?.username || 'Someone';
        await svc.deliver(to, { kind: 'call', title: channel.type === 'group_dm' && channel.name ? channel.name : name, body: channel.type === 'group_dm' ? `${name} started a call` : 'is calling you', tag: `call-${channel.id}`, channelId: channel.id, guildId: null, userId: callerId });
      })());
    },
  };
  return svc;
}

async function notifyMessage(ctx: Ctx, svc: PushService, channel: any, msg: Message) {
  const authorId = msg.author.id;
  const cands = new Map<string, Reason>();
  const add = (id: string, r: Reason) => { const cur = cands.get(id); if (cur === undefined || REASON_RANK[r] < REASON_RANK[cur]) cands.set(id, r); };
  if (!channel.guild_id) {
    for (const p of await ctx.db.query('SELECT user_id FROM dm_participants WHERE channel_id = $1 AND NOT request', [channel.id])) add(p.user_id, 'dm'); // message requests stay silent
  } else {
    for (const id of msg.mentions) add(id, 'mention');
    if (msg.replyTo) {
      const [ref] = await ctx.db.query('SELECT author_id FROM messages WHERE id = $1 AND channel_id = $2', [msg.replyTo, channel.id]);
      if (ref && !(await isWebhookAuthor(ctx, ref.author_id))) add(ref.author_id, 'reply');
    }
    if (msg.mentionRoles.length) for (const r of await ctx.db.query('SELECT DISTINCT user_id FROM member_roles WHERE guild_id = $1 AND role_id = ANY($2::text[])', [channel.guild_id, msg.mentionRoles])) add(r.user_id, 'role');
    if (msg.mentionEveryone) for (const r of await ctx.db.query('SELECT user_id FROM members WHERE guild_id = $1 LIMIT 5000', [channel.guild_id])) add(r.user_id, 'everyone');
    for (const r of await ctx.db.query(`SELECT user_id FROM notification_settings WHERE scope = 'guild' AND target_id = $1 AND level = 'all' LIMIT 5000`, [channel.guild_id])) add(r.user_id, 'all');
  }
  cands.delete(authorId);
  if (!cands.size) return;
  if (channel.guild_id) { // only people who can actually see the channel
    const viewers = new Set(await viewersAmong(ctx, channel, [...cands.keys()]));
    for (const id of [...cands.keys()]) if (!viewers.has(id)) cands.delete(id);
  }
  const channelIds = [channel.id, ...(channel.type === 'thread' && channel.parent_id ? [channel.parent_id] : [])];
  const to = await filterRecipients(ctx, cands, { authorId, guildId: channel.guild_id ?? null, channelIds, respectBlocks: true });
  if (!to.length) return;
  const reasonOf = (id: string) => cands.get(id) ?? 'mention';
  const author = msg.author.displayName || msg.author.username;
  const text = previewText(msg.content, msg.attachments.length) || (msg.stickerIds.length ? 'Sent a sticker' : 'Sent a message');
  let where = '';
  if (channel.guild_id) { const [g] = await ctx.db.query('SELECT name FROM guilds WHERE id = $1', [channel.guild_id]); where = ` (#${channel.name ?? 'channel'}${g ? `, ${g.name}` : ''})`; }
  // one payload per reason bucket keeps "mentioned you" wording accurate
  const buckets = new Map<PushKind, string[]>();
  for (const id of to) { const r = reasonOf(id); const k: PushKind = r === 'dm' ? 'dm' : r === 'reply' ? 'reply' : r === 'all' ? 'message' : 'mention'; buckets.set(k, [...(buckets.get(k) ?? []), id]); }
  for (const [kind, ids] of buckets) {
    await svc.deliver(ids, {
      kind, title: channel.guild_id ? `${author}${where}` : channel.type === 'group_dm' && channel.name ? `${author} in ${channel.name}` : author,
      body: kind === 'mention' ? `mentioned you: ${text}` : kind === 'reply' ? `replied to you: ${text}` : text,
      tag: `ch-${channel.id}`, channelId: channel.id, guildId: channel.guild_id ?? null, messageId: msg.id, userId: authorId,
    });
  }
}

async function isWebhookAuthor(ctx: Ctx, userId: string): Promise<boolean> {
  const [u] = await ctx.db.query('SELECT bot FROM users WHERE id = $1', [userId]);
  return !u || !!u.bot;
}
