# Twitch and YouTube integrations

Two optional features. Both are off until configured, and a server without credentials behaves exactly as before.

| Feature | Needs | Without it |
|---|---|---|
| "Connect with Twitch" (verified profile connection) | `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET` | `POST .../oauth/twitch/start` answers `501 FEATURE_DISABLED`; the code-in-page flow still works |
| "Connect with YouTube" (verified profile connection) | `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | same, `501` |
| Twitch live announcements in a server | the same Twitch credentials | creating a Twitch feed answers `501`; the web UI greys the option out |
| YouTube upload announcements in a server | nothing (public RSS) | always available |

## Operator setup

1. **Twitch**: register an application at <https://dev.twitch.tv/console> (type: Confidential). OAuth Redirect URL: `<PUBLIC_URL>/api/v1/connections/oauth/twitch/callback`. Put the client id and secret in `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`.
2. **Google**: in <https://console.cloud.google.com> enable *YouTube Data API v3*, create an OAuth client (type: Web application). Authorized redirect URI: `<PUBLIC_URL>/api/v1/connections/oauth/youtube/callback`. Put them in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. The only scope requested is `youtube.readonly`; Google may require the consent screen to be published (or the testers listed) before ordinary users can sign in.
3. `PUBLIC_URL` must be the exact public origin of the server (https in production): it is used for the redirect URI and for sending the browser back to the web client.
4. Restart. `GET /connections/providers` now marks the enabled providers with `oauth: true`, which is what the web client uses to show the buttons.

The secrets live only in the environment. They are never returned by any endpoint and never logged.

## Verified connections (OAuth)

```
POST /users/@me/connections/oauth/:provider/start   (provider: twitch | youtube; users only; 10 / min)
  -> 200 { url, expiresIn: 600 }  + HttpOnly cookie jc_oauth
GET  /connections/oauth/:provider/callback?code&state   (public; the provider sends the browser here)
  -> 302 <PUBLIC_URL>/channels/@me?connect=<provider>&result=<ok|denied|invalid_state|exchange_failed|account_failed|no_channel|already_linked|limit_reached|rate_limited|disabled>
```

Flow and guarantees:

- `state` is 256 random bits; only its SHA-256 is stored, together with the user id, the provider, the PKCE verifier (YouTube) and a hash of a browser-binding nonce. It lives 10 minutes, is deleted atomically on first use (a replayed callback finds nothing) and is for one provider only. At most 5 pending requests per user are kept.
- The nonce travels in an HttpOnly, SameSite=Lax cookie scoped to `/api/v1/connections/oauth`. The callback requires it, so a forwarded authorize link cannot attach somebody else's Twitch/YouTube account to the sender's profile (login CSRF). Consequence: start and finish must happen in the same browser. Native wrappers that open the system browser from a webview need to start the flow from that browser's session.
- PKCE (S256) is used for Google. Twitch does not support PKCE; the state + cookie binding cover it. Twitch is asked for no scopes (identity only).
- After the code exchange the server reads the account (Twitch Helix `users`, YouTube `channels?part=snippet&mine=true`), asks the provider to revoke the token, and keeps **only the provider's stable user id** (`connections.provider_user_id`, unique per provider). No access or refresh token is stored or logged.
- The connection is created (or the user's own self-declared link to that handle is upgraded in place, keeping its visibility) with `verified = true`, then `refreshUserEverywhere` re-evaluates linked roles. One provider account can be proven by one Jorcord account only (`already_linked` otherwise).
- All provider calls go through `lib/providerHttp.ts`: fixed host allow-list (`id.twitch.tv`, `api.twitch.tv`, `oauth2.googleapis.com`, `www.googleapis.com`), https only, no redirects, 8 s timeout, 256 KB cap.

## Stream and upload feeds

Server Settings > Integrations > "Stream & video feeds". Needs Manage Server on every route; bots are refused; every change is written to the audit log (`STREAM_FEED_CREATE`, `STREAM_FEED_UPDATE`, `STREAM_FEED_DELETE`).

```
GET    /guilds/:id/stream-feeds                -> { feeds: StreamFeed[], providers: { twitch, youtube }, max: 25 }
POST   /guilds/:id/stream-feeds  { provider: 'twitch'|'youtube', channel, channelId, template?, roleId? }  -> 201 StreamFeed
PATCH  /guilds/:id/stream-feeds/:feedId  { channelId?, template?, roleId?|null, enabled? }
DELETE /guilds/:id/stream-feeds/:feedId        -> 204
```

- `channel` for Twitch: a login or `twitch.tv/<login>` URL (verified through Helix). For YouTube: a channel id (`UC` + 22 chars), a `/channel/UC...` URL, or an `@handle` (also as a `youtube.com/@handle` URL). A handle is resolved by fetching the public channel page and reading its canonical channel id; if YouTube answers with a consent page, use the channel id. Any other host, scheme, port or credentials in the input is rejected before a request is made.
- `channelId`: a text or announcement channel of the same server that the caller can see and post in.
- `template`: up to 300 characters with `{channel}`, `{title}`, `{url}`. Default: `{channel} is live on Twitch: {title}\n{url}` / `{channel} has a new video: {title}\n{url}`. Explicit mentions (`<@...>`, `@everyone`, `@here`) are rejected; the ping is its own setting.
- `roleId`: a role to mention. Same rule as writing the mention by hand: the role must be mentionable, or the caller must hold Mention Everyone (checked against the target channel). A role that is not mentionable keeps working only while the person who configured it still holds that permission; otherwise the message is posted without the ping. Only that role can ping (`allowedMentions: { parse: [], roles: [roleId] }`).
- Provider text (titles, channel names) is stripped of `<` `>` and every `@` is broken with a zero-width space, so a title cannot ping anyone.
- Limit: 25 feeds per server (enforced inside the insert), one feed per provider channel per server (`409`).

### How polling works

`services/streamfeeds.ts#pollStreamFeeds` runs as the `stream-feeds` step of the existing sweeper (`SWEEP_INTERVAL_MS`, 10 s).

- **Claiming**: due feeds (`next_check_at <= now()`) are claimed with one atomic `UPDATE ... WHERE id IN (...)` that pushes `next_check_at` 5 minutes ahead (a lease), at most 40 per sweep. Several nodes can sweep at once; each feed is handled by exactly one.
- **Intervals**: Twitch every 60 s (one Helix `streams` request for up to 100 logins, using an app access token that is cached and renewed once on a 401), YouTube every 5 minutes (`https://www.youtube.com/feeds/videos.xml?channel_id=...`, at most 5 in parallel).
- **Dedupe**: `last_item_id` (Twitch stream id / YouTube video id) is moved with `UPDATE ... WHERE last_item_id IS NOT DISTINCT FROM <what we read>` before posting; only the node that wins posts. YouTube also compares publish time with `last_item_at` (set when the feed is created or re-enabled), so a new feed never announces the channel's back catalogue and a re-enabled feed does not replay what happened while it was off. At most 3 uploads are announced per check (oldest first); the rest are skipped, not queued. A Twitch stream is announced once per stream id.
- **Failures**: any provider error (timeout, 4xx/5xx, garbage instead of a feed, Twitch 429) sets `last_error` (a short message, shown in the UI) and backs off exponentially from the base interval up to 1 hour; the first success resets it. A failed post (channel deleted, ...) is recorded in `last_error` but does not stop the feed. Posting is at-most-once: the marker moves before the message is created.
- **Author**: messages are posted by a built-in bot user ("Stream Feeds", id `1000000000000000002`) through `createMessage`, like AutoMod alerts.
- **SSRF**: YouTube requests use `safeGet` (public addresses only, validated redirects, size and time caps) and are limited to `youtube.com` hosts, including after redirects. Twitch/Google calls use the fixed allow-list above.

## Tests and what is not verified

`apps/server/test/integrations-streams.test.ts` replaces the transport (`http` in `lib/providerHttp.ts`) and covers: OAuth success for both providers, PKCE, state mismatch, replay, expiry, wrong browser, other provider, failed exchange, cancelled consent, account already linked, upgrade of a declared link, no-credentials behaviour, rate limit; feed permissions, audit entries, the 25 cap, hostile inputs, template and role-mention rules, dedupe, burst cap, backoff and recovery, concurrent sweeps, lost marker race, pause/resume, Twitch batching and token renewal. Web: `StreamFeedsPanel.test.tsx`, `ConnectionsTab.test.tsx`, `connectReturn.test.ts`.

**Not verified against the real services** (no credentials were available): the exact authorize and token parameters Twitch and Google accept (notably Twitch with an empty `scope`), real response shapes beyond the documented fields, Google's consent-screen requirements, YouTube's channel page markup for `@handle` resolution and its consent redirect in some regions. Please do one real connect and one real feed per provider after configuring credentials.
