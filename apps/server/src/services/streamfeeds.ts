import { MAX_STREAM_FEED_TEMPLATE, Perm, has, type StreamFeed, type StreamFeedProvider } from '@jorcord/shared';
import type { Ctx } from '../ctx';
import { badRequest, ApiError } from '../errors';
import { iso } from '../lib/ids';
import { http, ProviderError } from '../lib/providerHttp';
import { createMessage } from './messages';
import { loadGuildPerm, permsFor } from './perms';

/** Bot user that authors the announcements (same idea as the AutoMod user). */
export const STREAMFEED_USER_ID = '1000000000000000002';
const readyUsers = new WeakSet<object>();
async function feedUserId(ctx: Ctx): Promise<string> {
  if (!readyUsers.has(ctx.db)) {
    await ctx.db.query(`INSERT INTO users (id, username, display_name, bot, verified, presence) VALUES ($1,'StreamFeeds','Stream Feeds',true,true,'online') ON CONFLICT (id) DO NOTHING`, [STREAMFEED_USER_ID]);
    readyUsers.add(ctx.db);
  }
  return STREAMFEED_USER_ID;
}

export const TICK_CAP = 40;            // feeds handled per sweep
const LEASE_SEC = 300;                 // a claimed feed is not picked up again by another node for this long
const BASE_SEC: Record<StreamFeedProvider, number> = { twitch: 60, youtube: 300 };
const MAX_BACKOFF_SEC = 3600;
const MAX_ANNOUNCE_PER_FEED = 3;       // a burst of uploads is announced newest three; the rest are skipped, not queued
const YT_CONCURRENCY = 5;
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const TWITCH_LOGIN_RE = /^[A-Za-z0-9_]{3,25}$/;
const VIDEO_ID_RE = /^[\w-]{11}$/;

export const twitchCreds = (ctx: Ctx) => ctx.config.integrations.twitch;
export const providerEnabled = (ctx: Ctx): Record<StreamFeedProvider, boolean> => ({ twitch: !!twitchCreds(ctx), youtube: true });

export const feedUrl = (provider: StreamFeedProvider, externalId: string) => provider === 'twitch' ? `https://www.twitch.tv/${externalId}` : `https://www.youtube.com/channel/${externalId}`;
export const feedDTO = (r: any): StreamFeed => ({
  id: r.id, guildId: r.guild_id, provider: r.provider, externalId: r.external_id, name: r.name, url: feedUrl(r.provider, r.external_id), channelId: r.channel_id, template: r.template,
  roleId: r.role_id ?? null, enabled: r.enabled, lastAnnouncedAt: iso(r.last_announced_at), lastError: r.last_error ?? null, createdBy: r.created_by ?? '', createdAt: iso(r.created_at)!,
});

// ---------- text safety ----------

/** Provider-supplied text (titles, channel names) must never be able to ping anybody or break out of the message. */
export const defang = (s: unknown, max = 200): string => String(s ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e]/g, ' ').replace(/[<>]/g, '').replace(/@/g, '@\u200b').replace(/\s+/g, ' ').trim().slice(0, max);

/** Template an admin writes: only {channel} {title} {url}; no explicit mentions (the role mention is its own setting). */
export function validateTemplate(raw: string): string {
  const t = raw.replace(/\r\n/g, '\n').trim();
  if (!t) throw badRequest('The message template cannot be empty');
  if (t.length > MAX_STREAM_FEED_TEMPLATE) throw badRequest(`The template can be at most ${MAX_STREAM_FEED_TEMPLATE} characters`);
  if (/<@|@everyone|@here/i.test(t)) throw badRequest('Use the role setting to mention someone; mentions inside the template are not allowed');
  return t;
}
export const renderTemplate = (tpl: string, v: { channel: string; title: string; url: string }) => tpl.replace(/\{(channel|title|url)\}/g, (_m, k: 'channel' | 'title' | 'url') => v[k]);

// ---------- YouTube ----------

export interface YtEntry { id: string; title: string; publishedMs: number; author: string }
const decodeXml = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
  const l = e.toLowerCase();
  if (l === 'amp') return '&'; if (l === 'lt') return '<'; if (l === 'gt') return '>'; if (l === 'quot') return '"'; if (l === 'apos') return "'";
  const n = l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
});
const tag = (xml: string, name: string) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml); return m ? decodeXml(m[1]!.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')).trim() : ''; };

/** Parses the public uploads feed (Atom). Newest first. Anything malformed is skipped. */
export function parseYoutubeFeed(xml: string): { title: string; entries: YtEntry[] } {
  const entries: YtEntry[] = [];
  const head = xml.split(/<entry[\s>]/i)[0] ?? '';
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const e = m[0]; const id = tag(e, 'yt:videoId'); const published = Date.parse(tag(e, 'published'));
    if (!VIDEO_ID_RE.test(id) || !Number.isFinite(published)) continue;
    entries.push({ id, title: tag(e, 'title'), publishedMs: published, author: tag(tag(e, 'author'), 'name') });
    if (entries.length >= 25) break;
  }
  entries.sort((a, b) => b.publishedMs - a.publishedMs);
  return { title: tag(head, 'title'), entries };
}

async function fetchYoutubeFeed(channelId: string) {
  const r = await http.page(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { accept: 'application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5', maxBytes: 600_000 });
  if (r.status === 404) throw new ProviderError('YouTube channel not found', 404);
  if (r.status < 200 || r.status >= 300) throw new ProviderError(`YouTube answered ${r.status}`, r.status);
  if (!/<feed[\s>]/i.test(r.body)) throw new ProviderError('YouTube sent an unexpected response');
  return parseYoutubeFeed(r.body);
}

/** @handle -> channel id by reading the public channel page. */
export async function resolveYoutubeHandle(handle: string): Promise<string> {
  const r = await http.page(`https://www.youtube.com/${encodeURIComponent(handle).replace('%40', '@')}`);
  if (r.status === 404) throw badRequest('That YouTube channel was not found');
  if (r.status < 200 || r.status >= 300) throw new ApiError(502, 'PROVIDER_ERROR', 'YouTube could not be reached, try the channel id (UC...) instead');
  const m = /<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/i.exec(r.body)
    ?? /<meta[^>]+itemprop="(?:channelId|identifier)"[^>]+content="(UC[\w-]{22})"/i.exec(r.body)
    ?? /"externalId":"(UC[\w-]{22})"/.exec(r.body);
  if (!m) throw new ApiError(502, 'PROVIDER_ERROR', 'Could not find the channel id on that page, paste the channel id (UC...) instead');
  return m[1]!;
}

/** Channel id, /channel/ URL or @handle (also as a youtube.com/@handle URL). Anything else is refused before any request is made. */
export function parseYoutubeInput(raw: string): { channelId: string } | { handle: string } {
  const s = raw.trim();
  if (CHANNEL_ID_RE.test(s)) return { channelId: s };
  if (/^@[A-Za-z0-9._-]{3,30}$/.test(s)) return { handle: s };
  let u: URL; try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { throw badRequest('Enter a YouTube channel id (UC...), channel URL or @handle'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname.toLowerCase())) throw badRequest('Only youtube.com channel links are supported');
  const seg = u.pathname.split('/').filter(Boolean);
  if (seg[0] === 'channel' && seg[1] && CHANNEL_ID_RE.test(seg[1])) return { channelId: seg[1] };
  if (seg[0] && /^@[A-Za-z0-9._-]{3,30}$/.test(decodeURIComponent(seg[0]))) return { handle: decodeURIComponent(seg[0]) };
  throw badRequest('Enter a YouTube channel id (UC...), channel URL or @handle');
}

// ---------- Twitch ----------

const tokenCache = new Map<string, { token: string; exp: number }>();
async function twitchToken(ctx: Ctx, force = false): Promise<{ token: string; clientId: string }> {
  const c = twitchCreds(ctx); if (!c) throw new ProviderError('Twitch is not configured on this server');
  const hit = tokenCache.get(c.clientId);
  if (!force && hit && hit.exp > Date.now() + 60_000) return { token: hit.token, clientId: c.clientId };
  const r = await http.json('https://id.twitch.tv/oauth2/token', { form: { client_id: c.clientId, client_secret: c.clientSecret, grant_type: 'client_credentials' } });
  if (r.status !== 200 || typeof r.body?.access_token !== 'string') throw new ProviderError('Twitch rejected the server credentials', r.status);
  tokenCache.set(c.clientId, { token: r.body.access_token, exp: Date.now() + Math.max(60, Number(r.body.expires_in) || 3600) * 1000 });
  return { token: r.body.access_token, clientId: c.clientId };
}
export const clearTwitchTokenCache = () => tokenCache.clear();

async function helix(ctx: Ctx, path: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { token, clientId } = await twitchToken(ctx, attempt > 0);
    const r = await http.json(`https://api.twitch.tv/helix/${path}`, { headers: { authorization: `Bearer ${token}`, 'client-id': clientId } });
    if (r.status === 401 && attempt === 0) { tokenCache.delete(clientId); continue; }
    if (r.status !== 200) throw new ProviderError(r.status === 429 ? 'Twitch rate limit, retrying later' : `Twitch answered ${r.status}`, r.status);
    return r.body;
  }
  throw new ProviderError('Twitch rejected the server credentials', 401);
}

export function parseTwitchInput(raw: string): string {
  const s = raw.trim().replace(/^@/, '');
  if (TWITCH_LOGIN_RE.test(s)) return s.toLowerCase();
  let u: URL; try { u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`); } catch { throw badRequest('Enter a Twitch username or channel URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !['www.twitch.tv', 'twitch.tv', 'm.twitch.tv'].includes(u.hostname.toLowerCase())) throw badRequest('Only twitch.tv channel links are supported');
  const login = u.pathname.split('/').filter(Boolean)[0] ?? '';
  if (!TWITCH_LOGIN_RE.test(login)) throw badRequest('Enter a Twitch username or channel URL');
  return login.toLowerCase();
}

// ---------- resolving a target when a feed is created ----------

export async function resolveTarget(ctx: Ctx, provider: StreamFeedProvider, input: string): Promise<{ externalId: string; name: string }> {
  try {
    if (provider === 'twitch') {
      const login = parseTwitchInput(input);
      const body = await helix(ctx, `users?login=${encodeURIComponent(login)}`);
      const u = body?.data?.[0];
      if (!u || String(u.login).toLowerCase() !== login) throw badRequest('That Twitch channel was not found');
      return { externalId: login, name: defang(u.display_name || u.login, 100) };
    }
    const p = parseYoutubeInput(input);
    const channelId = 'channelId' in p ? p.channelId : await resolveYoutubeHandle(p.handle);
    const feed = await fetchYoutubeFeed(channelId);
    return { externalId: channelId, name: defang(feed.entries[0]?.author || feed.title || channelId, 100) };
  } catch (e) {
    if (e instanceof ProviderError) {
      if (e.status === 404) throw badRequest('That channel was not found');
      throw new ApiError(502, 'PROVIDER_ERROR', `${provider === 'twitch' ? 'Twitch' : 'YouTube'} could not be reached right now: ${e.message}`);
    }
    throw e;
  }
}

// ---------- posting ----------

/** The role to ping, if still allowed: mentionable, or the feed's creator still holds MENTION_EVERYONE. */
async function mentionPlan(ctx: Ctx, f: any): Promise<{ prefix: string; senderPerms: bigint; roles: string[] }> {
  const none = { prefix: '', senderPerms: 0n, roles: [] as string[] };
  if (!f.role_id) return none;
  const [role] = await ctx.db.query('SELECT id, mentionable FROM roles WHERE id = $1 AND guild_id = $2', [f.role_id, f.guild_id]);
  if (!role) return none;
  const plan = { prefix: `<@&${role.id}> `, roles: [role.id as string] };
  if (role.mentionable) return { ...plan, senderPerms: 0n };
  if (f.mention_privileged && f.mention_by) {
    const gp = await loadGuildPerm(ctx, f.guild_id, f.mention_by);
    if (gp && has(permsFor(gp), Perm.MENTION_EVERYONE)) return { ...plan, senderPerms: Perm.MENTION_EVERYONE };
  }
  return none;
}

async function announce(ctx: Ctx, f: any, v: { channel: string; title: string; url: string }) {
  const [channel] = await ctx.db.query('SELECT * FROM channels WHERE id = $1 AND guild_id = $2', [f.channel_id, f.guild_id]);
  if (!channel || !['text', 'announcement'].includes(channel.type)) throw new Error('The announcement channel is gone');
  const plan = await mentionPlan(ctx, f);
  const content = (plan.prefix + renderTemplate(f.template, { channel: defang(v.channel, 100), title: defang(v.title, 150), url: v.url })).slice(0, 2000);
  await createMessage(ctx, { channel, authorId: await feedUserId(ctx), content, senderPerms: plan.senderPerms, skipChecks: true, allowedMentions: { parse: [], roles: plan.roles } });
}

/** Moves the dedupe marker only if nobody else did (several nodes may poll): the winner posts, everybody else sees 0 rows. */
async function claimItem(ctx: Ctx, f: any, expectedPrev: string | null, id: string, at: Date): Promise<boolean> {
  const rows = await ctx.db.query('UPDATE stream_feeds SET last_item_id = $3, last_item_at = $4, last_announced_at = now() WHERE id = $1 AND last_item_id IS NOT DISTINCT FROM $2 RETURNING id', [f.id, expectedPrev, id, at]);
  return rows.length > 0;
}

async function recordPostFailure(ctx: Ctx, f: any, e: unknown) {
  ctx.log.warn({ feed: f.id, guild: f.guild_id, err: String((e as any)?.message ?? e).slice(0, 200) }, 'stream feed announcement failed');
  await ctx.db.query('UPDATE stream_feeds SET last_error = $2 WHERE id = $1', [f.id, `Could not post: ${String((e as any)?.message ?? e).slice(0, 150)}`]).catch(() => {});
}

// ---------- the poller ----------

async function settle(ctx: Ctx, f: any, error: string | null) {
  const base = BASE_SEC[f.provider as StreamFeedProvider];
  if (!error) { await ctx.db.query(`UPDATE stream_feeds SET next_check_at = now() + $2 * interval '1 second', fail_count = 0, last_error = CASE WHEN last_error LIKE 'Could not post:%' THEN last_error ELSE NULL END WHERE id = $1`, [f.id, base]); return; }
  const fails = Math.min((f.fail_count ?? 0) + 1, 20);
  const delay = Math.min(base * 2 ** fails, MAX_BACKOFF_SEC);
  await ctx.db.query(`UPDATE stream_feeds SET next_check_at = now() + $2 * interval '1 second', fail_count = $3, last_error = $4 WHERE id = $1`, [f.id, delay, fails, error.slice(0, 200)]);
}

async function checkYoutube(ctx: Ctx, f: any): Promise<number> {
  const feed = await fetchYoutubeFeed(f.external_id);
  const lastAt = new Date(f.last_item_at).getTime();
  const fresh = feed.entries.filter((e) => e.publishedMs > lastAt && e.id !== f.last_item_id).sort((a, b) => a.publishedMs - b.publishedMs).slice(-MAX_ANNOUNCE_PER_FEED);
  let prev: string | null = f.last_item_id ?? null, posted = 0;
  for (const e of fresh) {
    if (!(await claimItem(ctx, f, prev, e.id, new Date(e.publishedMs)))) break; // another node announced it
    prev = e.id;
    try { await announce(ctx, f, { channel: e.author || f.name, title: e.title, url: `https://www.youtube.com/watch?v=${e.id}` }); posted++; } catch (err) { await recordPostFailure(ctx, f, err); }
  }
  return posted;
}

async function checkTwitch(ctx: Ctx, feeds: any[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const logins = [...new Set(feeds.map((f) => f.external_id as string))];
  for (let i = 0; i < logins.length; i += 100) {
    const chunk = logins.slice(i, i + 100);
    let body: any;
    try { body = await helix(ctx, `streams?first=100&${chunk.map((l) => `user_login=${encodeURIComponent(l)}`).join('&')}`); }
    catch (e) { const msg = e instanceof ProviderError ? e.message : 'Twitch error'; for (const f of feeds) if (chunk.includes(f.external_id)) out.set(f.id, msg); continue; }
    const live = new Map<string, any>();
    for (const s of Array.isArray(body?.data) ? body.data : []) if (s?.type === 'live' && typeof s.id === 'string' && typeof s.user_login === 'string') live.set(s.user_login.toLowerCase(), s);
    for (const f of feeds.filter((x) => chunk.includes(x.external_id))) {
      try {
        const s = live.get(f.external_id);
        if (s && s.id !== f.last_item_id && await claimItem(ctx, f, f.last_item_id ?? null, s.id, new Date(Date.parse(s.started_at) || Date.now()))) {
          try { await announce(ctx, f, { channel: s.user_name || f.name, title: s.title || '', url: feedUrl('twitch', f.external_id) }); } catch (err) { await recordPostFailure(ctx, f, err); }
        }
        out.set(f.id, null);
      } catch (e) { out.set(f.id, `Check failed: ${String((e as any)?.message ?? e).slice(0, 100)}`); }
    }
  }
  return out;
}

/** Sweeper step. Claims a bounded batch of due feeds (a lease, so other nodes skip them), polls them, and reschedules each with backoff on failure. */
export async function pollStreamFeeds(ctx: Ctx, cap = TICK_CAP): Promise<number> {
  const due = await ctx.db.query(
    `UPDATE stream_feeds SET next_check_at = now() + $2 * interval '1 second'
     WHERE id IN (SELECT id FROM stream_feeds WHERE enabled AND next_check_at <= now() ORDER BY next_check_at LIMIT $1) AND enabled AND next_check_at <= now() RETURNING *`, [cap, LEASE_SEC]);
  if (!due.length) return 0;
  const guard = async (f: any, fn: () => Promise<unknown>) => {
    try { await fn(); await settle(ctx, f, null); }
    catch (e) { await settle(ctx, f, e instanceof ProviderError ? e.message : 'Check failed').catch(() => {}); }
  };
  const tw = due.filter((f) => f.provider === 'twitch'), yt = due.filter((f) => f.provider === 'youtube');
  if (tw.length) {
    const res = !twitchCreds(ctx) ? new Map(tw.map((f) => [f.id, 'Twitch is not configured on this server'])) : await checkTwitch(ctx, tw).catch((e) => new Map(tw.map((f) => [f.id, e instanceof ProviderError ? e.message : 'Twitch error'])));
    for (const f of tw) await settle(ctx, f, res.get(f.id) ?? null).catch(() => {});
  }
  for (let i = 0; i < yt.length; i += YT_CONCURRENCY) await Promise.all(yt.slice(i, i + YT_CONCURRENCY).map((f) => guard(f, () => checkYoutube(ctx, f))));
  return due.length;
}
