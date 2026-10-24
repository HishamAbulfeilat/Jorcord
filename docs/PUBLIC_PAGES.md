# Public web pages (indexable forums)

Discord keeps community answers behind a login where search engines cannot see them. Jorcord lets a Community server publish selected **forum** and **announcement** channels as plain, server-rendered HTML that anyone can read and Google can index. Everything is opt-in and off by default.

## Turning it on

1. The server must be a **Community** server (needs a rules channel).
2. Owner or `MANAGE_GUILD`: Server Settings > Overview > **Public web view** (`PATCH /guilds/:id {publicWeb: true}`). Leaving Community switches it off again.
3. `MANAGE_CHANNELS` on each channel: switch on the channel in the same panel (`PATCH /channels/:id {publicWeb: true}`; forum and announcement channels only).
4. Optional: **Allow search engines** off (`PATCH /guilds/:id {publicNoindex: true}`) keeps pages readable by link but adds `noindex` and removes the server from sitemaps.

Migrations 160 (columns, all default false) and 161 (partial index, built concurrently).

## URLs

| URL | What |
|---|---|
| `/p/:guild` | Server page listing its public channels. `:guild` is the vanity URL or the guild id. |
| `/p/:guild/:channel?page=N` | Post list (forum) or announcements, 20 per page. |
| `/p/:guild/:channel/:thread` | A forum post (thread id) or one announcement (message id), 50 messages per page. |
| `/sitemap.xml`, `/sitemaps/:guild.xml` | Sitemap index and per-server sitemaps (public, indexable channels only). |
| `/robots.txt` | Allows `/p/` and the sitemaps, blocks `/api/`, `/gateway`, `/files/`. |

Each page has `<title>`, meta description, canonical URL, OpenGraph and Twitter cards, `robots` meta, `prev`/`next` links, and (for posts) schema.org `DiscussionForumPosting` JSON-LD with comments. Images are `loading="lazy"` with alt text and sizes. A **Join the conversation** button links to the vanity invite, or the channel in the app.

## What is never public

* Anything where the server, channel, or Community flag is off; age-restricted (NSFW) channels (setting `nsfw` unpublishes the channel; enabling is refused).
* A channel `@everyone` cannot view and read history in (checked at render time with the real overwrites, so a later permission change unpublishes it at once, modulo the cache below).
* DMs, group DMs, private threads, system messages, ephemeral messages.
* Mentions render as `@member`, `@role`, `#channel`: ids and names behind them are not revealed. Embeds, stickers, polls, and non-image attachments are not rendered.
* Members can set **Hide me on public pages** (Privacy & Safety; stored as `settings.prefs.hideOnPublicPages`). Their posts then show as **Member** with no avatar, also in JSON-LD. Deleted and deletion-pending accounts always show as Member.

## Safety of the rendering

Markdown is parsed with the shared parser (`@jorcord/shared/src/markdown`, the same one the web client uses) and rendered **from the AST**. Every text and attribute goes through HTML escaping, no user HTML is ever passed through, only `http(s)` links survive (`rel="nofollow ugc noopener noreferrer"`), JSON-LD escapes `<`, `>`, `&`, U+2028/9. Pages are served with `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: http:` (no scripts at all). Message text is capped at 4000 characters per render and nesting at 12 levels.

## Caching and abuse protection

* In-process render cache, 15 s TTL, 500 entries (LRU), cleared immediately when a guild or channel is patched.
* `ETag` + `If-None-Match` (304), `Cache-Control: public, max-age=60, stale-while-revalidate=300`. **Edits, deletions and un-publishing therefore show up within about a minute** (15 s on the origin; CDNs may hold up to 60 s).
* 90 requests/minute/IP on all public routes (429 with `retry-after`), on top of the global limiter. Page numbers are capped (500). Unknown or non-public ids all return the same cached 404 so existence is not leaked.
* Sitemaps list at most 40,000 URLs per server (newest first).

## Tests

`apps/server/test/public-web.test.ts`: rendering, XSS payloads, opt-in and permission gating, NSFW, overwrite deny, private threads, noindex and sitemaps, author opt-out, ETag, pagination, edit/delete freshness, rate limiting.
