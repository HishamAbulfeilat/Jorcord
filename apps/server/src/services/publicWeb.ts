import { createHash } from 'node:crypto';
import { DEFAULT_EVERYONE, Perm, computePermissions, has, snowflakeTime } from '@jorcord/shared';
import { parseMarkdown, toPlain, type MdNode } from '@jorcord/shared/src/markdown';
import type { Ctx } from '../ctx';

/**
 * Public, server-rendered web view of opted-in community forum / announcement channels (docs/PUBLIC_PAGES.md).
 *
 * Safety model, in one place:
 *  - nothing is public unless (guild COMMUNITY + guild.public_web) AND channel.public_web AND the channel is a forum/announcement channel,
 *    not age-restricted, and @everyone can see it and read its history (a public page never shows more than a logged-out visitor of the server could);
 *  - private threads, DMs and non-default message types never render;
 *  - every byte of user text goes through `esc()`; markdown is rendered from the AST (never from raw HTML) and links only keep http(s) hrefs.
 */

export const PUBLIC_CHANNEL_TYPES = new Set(['forum', 'announcement']);
export const POSTS_PER_LIST_PAGE = 20, MESSAGES_PER_PAGE = 50, MAX_PAGE = 500, MAX_SITEMAP_URLS = 40_000, MAX_CONTENT = 4000;

// ---------------------------------------------------------------- escaping / URLs
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);
/** Only absolute http(s) URLs without whitespace/control characters survive; everything else (javascript:, data:, relative) is dropped. */
export function safeHref(u: string): string | null {
  if (typeof u !== 'string' || u.length > 2048 || /[\s\u0000-\u001f\u007f<>"'`\\]/.test(u)) return null;
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch { return null; }
}
/** JSON for an inline <script type="application/ld+json">: no sequence in the output can close the element or open a comment. */
export const jsonLd = (o: unknown): string => JSON.stringify(o).replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

// ---------------------------------------------------------------- markdown -> HTML
export function renderNodes(ns: MdNode[], depth = 0): string {
  if (depth > 12) return esc(toPlain(ns));
  return ns.map((n) => renderNode(n, depth)).join('');
}
function renderNode(n: MdNode, depth: number): string {
  const sub = (c: MdNode[]) => renderNodes(c, depth + 1);
  switch (n.t) {
    case 'text': return esc(n.v);
    case 'bold': return `<strong>${sub(n.c)}</strong>`;
    case 'italic': return `<em>${sub(n.c)}</em>`;
    case 'underline': return `<u>${sub(n.c)}</u>`;
    case 'strike': return `<s>${sub(n.c)}</s>`;
    case 'spoiler': return `<span class="spoiler" tabindex="0">${sub(n.c)}</span>`;
    case 'code': return `<code>${esc(n.v)}</code>`;
    case 'codeblock': return `<pre><code${/^[a-z0-9_+#.-]{1,24}$/.test(n.lang) ? ` class="language-${esc(n.lang)}"` : ''}>${esc(n.v)}</code></pre>`;
    case 'quote': return `<blockquote>${sub(n.c)}</blockquote>`;
    case 'heading': { const h = Math.min(5, 2 + n.level); return `<h${h}>${sub(n.c)}</h${h}>`; } // the page owns h1/h2
    case 'subtext': return `<small>${sub(n.c)}</small>`;
    case 'list': { const t = n.ordered ? 'ol' : 'ul'; return `<${t}>${n.items.map((it) => `<li>${sub(it)}</li>`).join('')}</${t}>`; }
    case 'link': { const h = safeHref(n.href); return h ? `<a href="${esc(h)}" rel="nofollow ugc noopener noreferrer" target="_blank">${sub(n.c)}</a>` : sub(n.c); }
    // mentions never reveal who/what they point at on a public page
    case 'user': return '<span class="mention">@member</span>';
    case 'role': return '<span class="mention">@role</span>';
    case 'channel': return '<span class="mention">#channel</span>';
    case 'everyone': return `<span class="mention">@${esc(n.v)}</span>`;
    case 'emoji': return esc(`:${n.name}:`);
    case 'time': return Number.isFinite(n.ts) && Math.abs(n.ts) < 8.64e12 ? `<time datetime="${new Date(n.ts * 1000).toISOString()}">${new Date(n.ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC</time>` : '';
    case 'br': return '<br>';
  }
  return '';
}
export const renderMarkdown = (src: string): string => renderNodes(parseMarkdown(src.slice(0, MAX_CONTENT)));
export const plainText = (src: string): string => toPlain(parseMarkdown(src.slice(0, MAX_CONTENT)), { user: () => 'member', channel: () => 'channel', role: () => 'role' }).replace(/\s+/g, ' ').trim();
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');

// ---------------------------------------------------------------- access checks
export interface PubGuild { id: string; name: string; description: string | null; icon: string | null; vanity: string | null; noindex: boolean; key: string }
export interface PubChannel { id: string; name: string; topic: string | null; type: string; tags: { id: string; name: string }[]; sortCreation: boolean }

const fileAbs = (ctx: Ctx, p: string | null | undefined): string | null => {
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) return safeHref(p);
  if (p.startsWith('/') && !p.startsWith('//')) return base(ctx) + encodeURI(p).replace(/[<>"']/g, '');
  return /^[A-Za-z0-9._-]+$/.test(p) ? `${base(ctx)}/api/v1/files/${p}` : null;
};
export const base = (ctx: Ctx) => ctx.config.publicUrl.replace(/\/+$/, '');

export async function findPublicGuild(ctx: Ctx, key: string): Promise<PubGuild | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) return null;
  const [g] = await ctx.db.query(`SELECT id, name, description, icon, vanity_url, public_noindex, features FROM guilds WHERE public_web AND (id = $1 OR lower(vanity_url) = lower($1)) LIMIT 1`, [key]);
  if (!g || !(g.features as string[]).includes('COMMUNITY')) return null;
  return { id: g.id, name: g.name, description: g.description ?? null, icon: g.icon ?? null, vanity: g.vanity_url ?? null, noindex: !!g.public_noindex, key: g.vanity_url ?? g.id };
}

/** What a logged-out visitor of the server could see: @everyone role permissions plus the channel's overwrites. */
async function everyoneCanRead(ctx: Ctx, guildId: string, channelId: string): Promise<boolean> {
  const [role] = await ctx.db.query('SELECT permissions FROM roles WHERE id = $1 AND guild_id = $1', [guildId]);
  const everyonePerms = role ? BigInt(role.permissions) : DEFAULT_EVERYONE;
  const p = computePermissions({ isOwner: false, everyoneRoleId: guildId, everyonePerms, memberRoleIds: [], rolePerms: {}, memberId: '', overwrites: await ctx.pcache.channelOverwrites(ctx, channelId) });
  return has(p, Perm.VIEW_CHANNEL) && has(p, Perm.READ_MESSAGE_HISTORY);
}

export async function findPublicChannel(ctx: Ctx, g: PubGuild, channelId: string): Promise<PubChannel | null> {
  if (!/^\d{1,24}$/.test(channelId)) return null;
  const [c] = await ctx.db.query(`SELECT id, name, topic, type, available_tags, default_sort_order FROM channels WHERE id = $1 AND guild_id = $2 AND public_web AND NOT nsfw AND type IN ('forum','announcement')`, [channelId, g.id]);
  if (!c || !(await everyoneCanRead(ctx, g.id, c.id))) return null;
  const tags = Array.isArray(c.available_tags) ? (c.available_tags as any[]).map((t) => ({ id: String(t.id), name: String(t.name ?? '') })) : [];
  return { id: c.id, name: c.name ?? 'channel', topic: c.topic ?? null, type: c.type, tags, sortCreation: c.default_sort_order === 'creation_date' };
}

// ---------------------------------------------------------------- authors
interface Who { name: string; avatar: string | null; bot: boolean; hidden: boolean }
async function authors(ctx: Ctx, ids: string[]): Promise<Map<string, Who>> {
  const out = new Map<string, Who>();
  const uniq = [...new Set(ids)];
  if (!uniq.length) return out;
  const rows = await ctx.db.query(`SELECT id, username, display_name, avatar, bot, deleted_at, deletion_due_at, (settings->>'hideOnPublicPages' = 'true') AS hide FROM users WHERE id = ANY($1::text[])`, [uniq]);
  for (const r of rows) {
    const hidden = !!r.hide || !!r.deleted_at || !!r.deletion_due_at;
    out.set(r.id, hidden ? { name: 'Member', avatar: null, bot: false, hidden: true } : { name: String(r.display_name || r.username), avatar: fileAbs(ctx, r.avatar), bot: !!r.bot, hidden: false });
  }
  return out;
}
const whoOf = (m: Map<string, Who>, id: string): Who => m.get(id) ?? { name: 'Member', avatar: null, bot: false, hidden: true };

// ---------------------------------------------------------------- page shell
export interface Page { status: number; body: string; type?: string; noindex?: boolean; lastModified?: Date }
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: http:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const CSS = `:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--mut:#59636e;--line:#d1d9e0;--card:#f6f8fa;--acc:#5865f2}@media(prefers-color-scheme:dark){:root{--bg:#1e1f22;--fg:#dbdee1;--mut:#9aa0a6;--line:#3a3c41;--card:#2b2d31;--acc:#8ea1ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}a{color:var(--acc)}
header.top,main,footer{max-width:820px;margin:0 auto;padding:12px 16px}header.top{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap;border-bottom:1px solid var(--line)}
.crumbs{font-size:14px;color:var(--mut)}.crumbs a{color:var(--mut)}h1{font-size:1.6rem;line-height:1.25;margin:.6em 0 .3em}h2{font-size:1.2rem}
.btn{display:inline-block;background:var(--acc);color:#fff!important;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600}.btn.alt{background:transparent;color:var(--acc)!important;border:1px solid var(--acc)}
article.msg{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}article.msg img.av{width:40px;height:40px;border-radius:50%;flex:none;background:var(--card)}.av.ph{width:40px;height:40px;border-radius:50%;flex:none;background:var(--card);display:grid;place-items:center;color:var(--mut)}
.body{min-width:0;flex:1;overflow-wrap:anywhere;white-space:pre-wrap}.meta{font-size:13px;color:var(--mut);white-space:normal}.meta b{color:var(--fg)}.body pre{background:var(--card);padding:10px;border-radius:6px;overflow:auto;white-space:pre}.body code{background:var(--card);padding:1px 4px;border-radius:4px}.body pre code{padding:0;background:none}
blockquote{margin:6px 0;padding:2px 12px;border-inline-start:3px solid var(--line);color:var(--mut)}.body img.att{max-width:100%;height:auto;border-radius:8px;margin-top:8px;display:block}.spoiler{background:var(--mut);color:transparent;border-radius:3px}.spoiler:hover,.spoiler:focus{background:var(--card);color:inherit}.mention{background:rgba(88,101,242,.18);border-radius:3px;padding:0 2px}
ul.list{list-style:none;padding:0;margin:0}ul.list li{padding:14px 0;border-bottom:1px solid var(--line)}ul.list a.t{font-weight:600;font-size:1.05rem}.tag{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:10px;padding:0 8px;margin-inline-end:4px;color:var(--mut)}
.cta{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:20px 0;display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}nav.pager{display:flex;justify-content:space-between;margin:18px 0}footer{color:var(--mut);font-size:13px}`;

interface Meta { title: string; description: string; canonical: string; image?: string | null; type?: 'website' | 'article'; noindex?: boolean; prev?: string; next?: string; ld?: unknown; published?: string; modified?: string }
function shell(ctx: Ctx, g: PubGuild, m: Meta, inner: string): string {
  const title = clip(m.title, 70), desc = clip(m.description || g.description || `${g.name} community`, 200);
  const img = m.image ? `<meta property="og:image" content="${esc(m.image)}"><meta name="twitter:image" content="${esc(m.image)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(m.canonical)}">${m.prev ? `<link rel="prev" href="${esc(m.prev)}">` : ''}${m.next ? `<link rel="next" href="${esc(m.next)}">` : ''}
<meta name="robots" content="${m.noindex ? 'noindex,nofollow' : 'index,follow,max-image-preview:large'}">
<meta property="og:site_name" content="${esc(g.name)}"><meta property="og:type" content="${m.type ?? 'website'}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(m.canonical)}">${m.published ? `<meta property="article:published_time" content="${esc(m.published)}">` : ''}${m.modified ? `<meta property="article:modified_time" content="${esc(m.modified)}">` : ''}${img}
<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
<style>${CSS}</style>${m.ld ? `<script type="application/ld+json">${jsonLd(m.ld)}</script>` : ''}</head><body>
<header class="top"><div class="crumbs"><a href="${esc(`${base(ctx)}/p/${g.key}`)}">${esc(g.name)}</a></div><a class="btn" href="${esc(joinUrl(ctx, g))}">Join the conversation</a></header>
<main>${inner}</main>
<footer><p>Read-only public view of the ${esc(g.name)} community. Members can opt out of being named here. <a href="${esc(base(ctx))}" rel="nofollow">Jorcord</a></p></footer></body></html>`;
}
const joinUrl = (ctx: Ctx, g: PubGuild, deep?: string) => g.vanity ? `${base(ctx)}/invite/${encodeURIComponent(g.vanity)}` : `${base(ctx)}/channels/${g.id}${deep ?? ''}`;
const canonicalOf = (ctx: Ctx, g: PubGuild, ...parts: string[]) => `${base(ctx)}/p/${[g.key, ...parts].map(encodeURIComponent).join('/')}`;
const withPage = (u: string, page: number) => (page > 1 ? `${u}?page=${page}` : u);
const iso = (d: unknown) => new Date(d as any).toISOString();

// ---------------------------------------------------------------- pages
export async function renderGuildIndex(ctx: Ctx, g: PubGuild): Promise<Page> {
  const chans = await ctx.db.query(`SELECT id, name, topic, type FROM channels WHERE guild_id = $1 AND public_web AND NOT nsfw AND type IN ('forum','announcement') ORDER BY position, id LIMIT 200`, [g.id]);
  const ok: any[] = [];
  for (const c of chans) if (await everyoneCanRead(ctx, g.id, c.id)) ok.push(c);
  if (!ok.length) return notFound();
  const inner = `<h1>${esc(g.name)}</h1>${g.description ? `<p>${esc(g.description)}</p>` : ''}<h2>Public channels</h2><ul class="list">${ok.map((c) => `<li><a class="t" href="${esc(canonicalOf(ctx, g, c.id))}">#${esc(c.name)}</a>${c.topic ? `<div class="meta">${esc(clip(String(c.topic), 160))}</div>` : ''}</li>`).join('')}</ul>${cta(ctx, g)}`;
  return { status: 200, noindex: g.noindex, body: shell(ctx, g, { title: `${g.name} community`, description: g.description ?? `Public discussions from the ${g.name} community`, canonical: canonicalOf(ctx, g), image: fileAbs(ctx, g.icon), noindex: g.noindex }, inner) };
}
const cta = (ctx: Ctx, g: PubGuild, deep?: string) => `<div class="cta"><div><b>Have something to add?</b><div class="meta">Join ${esc(g.name)} to reply and ask your own questions.</div></div><a class="btn" href="${esc(joinUrl(ctx, g, deep))}">Join the conversation</a></div>`;

export async function renderChannel(ctx: Ctx, g: PubGuild, c: PubChannel, page: number): Promise<Page> {
  const url = canonicalOf(ctx, g, c.id);
  const lim = POSTS_PER_LIST_PAGE, off = (page - 1) * lim;
  let items: { id: string; title: string; excerpt: string; when: Date; replies: number; authorId: string; tags: string[] }[];
  if (c.type === 'forum') {
    const rows = await ctx.db.query(`SELECT t.id, t.name, t.owner_id, t.applied_tags, t.created_at, t.activity_at,
        (SELECT count(*) FROM messages m WHERE m.channel_id = t.id)::int AS n,
        (SELECT content FROM messages m WHERE m.channel_id = t.id ORDER BY m.id LIMIT 1) AS first
      FROM channels t WHERE t.parent_id = $1 AND t.type = 'thread' AND NOT t.thread_private
      ORDER BY ${c.sortCreation ? 't.id' : 'COALESCE(t.last_message_id, t.id)'} DESC LIMIT $2 OFFSET $3`, [c.id, lim + 1, off]);
    items = rows.map((r) => ({ id: r.id, title: String(r.name ?? 'Post'), excerpt: plainText(String(r.first ?? '')), when: new Date(r.activity_at ?? r.created_at), replies: Math.max(0, (r.n ?? 1) - 1), authorId: r.owner_id ?? '', tags: ((r.applied_tags as string[]) ?? []).map((id) => c.tags.find((t) => t.id === id)?.name).filter(Boolean) as string[] }));
  } else {
    const rows = await ctx.db.query(`SELECT id, content, author_id, edited_at FROM messages WHERE channel_id = $1 AND type = 'default' AND content <> '' ORDER BY id DESC LIMIT $2 OFFSET $3`, [c.id, lim + 1, off]);
    items = rows.map((r) => { const txt = plainText(String(r.content)); return { id: r.id, title: clip(txt, 90) || 'Announcement', excerpt: txt, when: msgTime(r.id), replies: 0, authorId: r.author_id, tags: [] }; });
  }
  const more = items.length > lim; items = items.slice(0, lim);
  if (!items.length && page > 1) return notFound();
  const who = await authors(ctx, items.map((i) => i.authorId));
  const li = items.map((i) => `<li><a class="t" href="${esc(canonicalOf(ctx, g, c.id, i.id))}">${esc(i.title)}</a>${i.tags.length ? ` ${i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}` : ''}${c.type === 'forum' && i.excerpt ? `<div>${esc(clip(i.excerpt, 200))}</div>` : ''}<div class="meta">${esc(whoOf(who, i.authorId).name)} &middot; <time datetime="${iso(i.when)}">${esc(iso(i.when).slice(0, 10))}</time>${c.type === 'forum' ? ` &middot; ${i.replies} ${i.replies === 1 ? 'reply' : 'replies'}` : ''}</div></li>`).join('');
  const pager = (page > 1 || more) ? `<nav class="pager">${page > 1 ? `<a rel="prev" href="${esc(withPage(url, page - 1))}">&larr; Newer</a>` : '<span></span>'}${more ? `<a rel="next" href="${esc(withPage(url, page + 1))}">Older &rarr;</a>` : ''}</nav>` : '';
  const title = `#${c.name} - ${g.name}${page > 1 ? ` (page ${page})` : ''}`;
  const inner = `<div class="crumbs"><a href="${esc(canonicalOf(ctx, g))}">${esc(g.name)}</a> / #${esc(c.name)}</div><h1>#${esc(c.name)}</h1>${c.topic ? `<p>${esc(c.topic)}</p>` : ''}<ul class="list">${li || '<li>Nothing here yet.</li>'}</ul>${pager}${cta(ctx, g, `/${c.id}`)}`;
  return { status: 200, noindex: g.noindex, body: shell(ctx, g, { title, description: c.topic ?? `Public ${c.type === 'forum' ? 'discussions' : 'announcements'} in #${c.name} from ${g.name}`, canonical: withPage(url, page), image: fileAbs(ctx, g.icon), noindex: g.noindex, prev: page > 1 ? withPage(url, page - 1) : undefined, next: more ? withPage(url, page + 1) : undefined,
    ld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `#${c.name}`, url, isPartOf: { '@type': 'WebSite', name: g.name, url: canonicalOf(ctx, g) } } }, inner) };
}

/** Message ids are snowflakes: derive the creation time from the id so a list needs no extra column. */
function msgTime(id: string): Date { try { return new Date(snowflakeTime(id)); } catch { return new Date(0); } }

interface Post { id: string; authorId: string; content: string; created: Date; edited: Date | null; attachments: any[]; webhookName: string | null }
function toPost(r: any): Post { return { id: r.id, authorId: r.author_id, content: String(r.content ?? ''), created: msgTime(r.id), edited: r.edited_at ? new Date(r.edited_at) : null, attachments: Array.isArray(r.attachments) ? r.attachments : [], webhookName: r.webhook_id ? String(r.webhook_username ?? 'Webhook') : null }; }

export async function renderThread(ctx: Ctx, g: PubGuild, c: PubChannel, threadId: string, page: number): Promise<Page> {
  if (!/^\d{1,24}$/.test(threadId)) return notFound();
  let title: string, posts: Post[], more = false, tags: string[] = [], total = 0, pubAt: Date, lastAt: Date;
  const lim = MESSAGES_PER_PAGE, off = (page - 1) * lim;
  const typeOk = `type IN ('default','reply') AND (flags & 64) = 0`; // 64 = EPHEMERAL: never part of a public thread
  if (c.type === 'forum') {
    const [t] = await ctx.db.query(`SELECT id, name, applied_tags, created_at, activity_at FROM channels WHERE id = $1 AND parent_id = $2 AND type = 'thread' AND NOT thread_private`, [threadId, c.id]);
    if (!t) return notFound();
    const rows = await ctx.db.query(`SELECT id, author_id, content, edited_at, attachments, webhook_id, webhook_username FROM messages WHERE channel_id = $1 AND ${typeOk} ORDER BY id LIMIT $2 OFFSET $3`, [threadId, lim + 1, off]);
    if (!rows.length) return notFound();
    more = rows.length > lim; posts = rows.slice(0, lim).map(toPost);
    [{ n: total }] = await ctx.db.query(`SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND ${typeOk}`, [threadId]);
    title = String(t.name ?? 'Post'); pubAt = new Date(t.created_at); lastAt = new Date(t.activity_at ?? t.created_at);
    tags = ((t.applied_tags as string[]) ?? []).map((id) => c.tags.find((x) => x.id === id)?.name).filter(Boolean) as string[];
  } else {
    if (page > 1) return notFound();
    const [r] = await ctx.db.query(`SELECT id, author_id, content, edited_at, attachments, webhook_id, webhook_username FROM messages WHERE id = $1 AND channel_id = $2 AND ${typeOk}`, [threadId, c.id]);
    if (!r) return notFound();
    posts = [toPost(r)]; total = 1;
    title = clip(plainText(posts[0]!.content), 90) || 'Announcement'; pubAt = posts[0]!.created; lastAt = posts[0]!.edited ?? pubAt;
  }
  const who = await authors(ctx, posts.map((p) => p.authorId));
  const nameOf = (p: Post) => (p.webhookName && !whoOf(who, p.authorId).hidden ? p.webhookName : whoOf(who, p.authorId).name);
  const url = canonicalOf(ctx, g, c.id, threadId);
  const first = posts[0]!;
  const firstImage = posts.flatMap((p) => p.attachments).find((a) => /^image\/(png|jpe?g|gif|webp|avif)$/.test(a?.contentType) && !a.spoiler);
  const img = firstImage ? fileAbs(ctx, String(firstImage.url)) : fileAbs(ctx, g.icon);
  const html = posts.map((p) => {
    const w = whoOf(who, p.authorId);
    const imgs = p.attachments.filter((a) => /^image\/(png|jpe?g|gif|webp|avif)$/.test(a?.contentType)).slice(0, 6).map((a) => {
      const src = fileAbs(ctx, String(a.url ?? '')); if (!src) return '';
      const alt = a.description ? String(a.description) : a.spoiler ? 'Spoiler image' : String(a.filename ?? 'image');
      const dim = Number.isFinite(a.width) && Number.isFinite(a.height) && a.width > 0 && a.height > 0 ? ` width="${Math.round(a.width)}" height="${Math.round(a.height)}"` : '';
      return a.spoiler ? '' : `<img class="att" loading="lazy" decoding="async"${dim} src="${esc(src)}" alt="${esc(alt)}">`;
    }).join('');
    return `<article class="msg" id="m${esc(p.id)}">${w.avatar ? `<img class="av" loading="lazy" decoding="async" width="40" height="40" src="${esc(w.avatar)}" alt="">` : `<div class="av ph" aria-hidden="true">${esc(w.name.slice(0, 1).toUpperCase())}</div>`}<div style="min-width:0;flex:1"><div class="meta"><b>${esc(nameOf(p))}</b>${w.bot ? ' <span class="tag">BOT</span>' : ''} &middot; <time datetime="${iso(p.created)}">${esc(iso(p.created).slice(0, 16).replace('T', ' '))} UTC</time>${p.edited ? ' (edited)' : ''}</div><div class="body">${renderMarkdown(p.content)}${imgs}</div></div></article>`;
  }).join('');
  const desc = clip(plainText(first.content), 170) || `${title} - a discussion in ${g.name}`;
  const pager = (page > 1 || more) ? `<nav class="pager">${page > 1 ? `<a rel="prev" href="${esc(withPage(url, page - 1))}">&larr; Earlier replies</a>` : '<span></span>'}${more ? `<a rel="next" href="${esc(withPage(url, page + 1))}">More replies &rarr;</a>` : ''}</nav>` : '';
  const inner = `<div class="crumbs"><a href="${esc(canonicalOf(ctx, g))}">${esc(g.name)}</a> / <a href="${esc(canonicalOf(ctx, g, c.id))}">#${esc(c.name)}</a></div><h1>${esc(title)}</h1>${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${html}${pager}${cta(ctx, g, `/${threadId}`)}`;
  const person = (p: Post) => ({ '@type': 'Person', name: nameOf(p) });
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org', '@type': 'DiscussionForumPosting', '@id': url, mainEntityOfPage: url, url, headline: clip(title, 110),
    text: clip(plainText(first.content), 5000) || title, datePublished: iso(pubAt), dateModified: iso(lastAt), author: person(first),
    isPartOf: { '@type': 'WebSite', name: g.name, url: canonicalOf(ctx, g) }, interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: Math.max(0, total - 1) },
    ...(img ? { image: img } : {}),
    ...(posts.length > 1 || page > 1 ? { comment: posts.filter((p, i) => page > 1 || i > 0).slice(0, 50).map((p) => ({ '@type': 'Comment', text: clip(plainText(p.content), 2000), dateCreated: iso(p.created), author: person(p), url: `${url}#m${p.id}` })) } : {}),
  };
  return { status: 200, noindex: g.noindex, lastModified: lastAt, body: shell(ctx, g, { title: `${title}${page > 1 ? ` (page ${page})` : ''} - ${g.name}`, description: desc, canonical: withPage(url, page), image: img, type: 'article', noindex: g.noindex, prev: page > 1 ? withPage(url, page - 1) : undefined, next: more ? withPage(url, page + 1) : undefined, ld, published: iso(pubAt), modified: iso(lastAt) }, inner) };
}

export function notFound(): Page {
  return { status: 404, noindex: true, body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title><style>${CSS}</style></head><body><main><h1>Not found</h1><p>This page does not exist or is not public.</p></main></body></html>` };
}

// ---------------------------------------------------------------- sitemaps / robots
const xml = (s: string) => esc(s);
export function robotsTxt(ctx: Ctx): string {
  return ['User-agent: *', 'Allow: /p/', 'Allow: /sitemap.xml', 'Allow: /sitemaps/', 'Disallow: /api/', 'Disallow: /gateway', 'Disallow: /files/', '', `Sitemap: ${base(ctx)}/sitemap.xml`, ''].join('\n');
}
export async function sitemapIndex(ctx: Ctx): Promise<string> {
  const rows = await ctx.db.query(`SELECT g.id, g.vanity_url FROM guilds g WHERE g.public_web AND NOT g.public_noindex AND g.features @> '["COMMUNITY"]'::jsonb AND EXISTS (SELECT 1 FROM channels c WHERE c.guild_id = g.id AND c.public_web AND NOT c.nsfw AND c.type IN ('forum','announcement')) ORDER BY g.id LIMIT 5000`);
  const urls = rows.map((r) => `<sitemap><loc>${xml(`${base(ctx)}/sitemaps/${encodeURIComponent(r.vanity_url ?? r.id)}.xml`)}</loc></sitemap>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</sitemapindex>`;
}
/** Per-server sitemap; null when the server is not public or opted out of indexing. */
export async function guildSitemap(ctx: Ctx, key: string): Promise<string | null> {
  const g = await findPublicGuild(ctx, key);
  if (!g || g.noindex) return null;
  const chans = await ctx.db.query(`SELECT id, type FROM channels WHERE guild_id = $1 AND public_web AND NOT nsfw AND type IN ('forum','announcement') ORDER BY position, id LIMIT 200`, [g.id]);
  const out: string[] = [`<url><loc>${xml(canonicalOf(ctx, g))}</loc></url>`];
  for (const ch of chans) {
    if (out.length >= MAX_SITEMAP_URLS) break;
    if (!(await everyoneCanRead(ctx, g.id, ch.id))) continue;
    out.push(`<url><loc>${xml(canonicalOf(ctx, g, ch.id))}</loc></url>`);
    const left = MAX_SITEMAP_URLS - out.length;
    if (left <= 0) break;
    const rows = ch.type === 'forum'
      ? await ctx.db.query(`SELECT id, COALESCE(activity_at, created_at) AS at FROM channels WHERE parent_id = $1 AND type = 'thread' AND NOT thread_private ORDER BY id DESC LIMIT $2`, [ch.id, left])
      : await ctx.db.query(`SELECT id, edited_at AS at FROM messages WHERE channel_id = $1 AND type = 'default' AND content <> '' ORDER BY id DESC LIMIT $2`, [ch.id, left]);
    for (const r of rows) out.push(`<url><loc>${xml(canonicalOf(ctx, g, ch.id, r.id))}</loc><lastmod>${(r.at ? new Date(r.at) : msgTime(r.id)).toISOString()}</lastmod></url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${out.join('')}</urlset>`;
}

// ---------------------------------------------------------------- cache + conditional GET
interface Entry { at: number; page: Page; etag: string }
const CACHE_TTL_MS = 15_000, CACHE_MAX = 500;
const cache = new Map<string, Entry>();
export const clearPublicCache = () => cache.clear();
export async function cached(key: string, build: () => Promise<Page>): Promise<Entry> {
  const hit = cache.get(key), now = Date.now();
  if (hit && now - hit.at < CACHE_TTL_MS) { cache.delete(key); cache.set(key, hit); return hit; }
  const page = await build();
  const e: Entry = { at: now, page, etag: `W/"${createHash('sha1').update(page.body).digest('base64url').slice(0, 22)}"` };
  cache.set(key, e);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return e;
}
