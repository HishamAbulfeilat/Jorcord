# Building bots on Jorcord

Use `@jorcord/bot-sdk` (`Bot`, `Rest`) or any Discord-compatible library against `/api/v10` (an alias of `/api/v1`). See `CONTRACT.md` for the full API.

## Message content and privileged intents: no approval wall

Discord forces bots in 75+ servers through a verification process before they may read message content. **Jorcord has no verification, no review queue and no server-count gate.**

* `MESSAGE_CONTENT` (1<<15), `GUILD_MEMBERS` (1<<1) and `GUILD_PRESENCES` (1<<8) are "privileged" only in the sense that the bot owner must tick them once: `PATCH /applications/:id {privilegedIntents: <bitfield>}` (Developer Portal toggle). It takes effect immediately, for any number of servers, for free.
* The gateway checks only that flag at `IDENTIFY` (close code 4014 if the intent is requested but not enabled). Nothing counts guilds (`apps/server/src/gateway/ws.ts`).
* Without `MESSAGE_CONTENT`, guild messages arrive with empty content unless they mention the bot, are from the bot, or are DMs; with it you get everything the bot may already see by permission. Users are not asked for consent beyond installing the bot.

## Rate limits

Every API response carries per-route headers:

| Header | Meaning |
|---|---|
| `x-ratelimit-limit` / `-remaining` | Requests allowed in the window / left |
| `x-ratelimit-reset` / `-reset-after` | Unix time / seconds until the window resets |
| `x-ratelimit-bucket` | Opaque bucket id; routes sharing it share the budget |
| `retry-after`, `x-ratelimit-scope`, `x-ratelimit-global` | Only on `429` |

A `429` body is `{code:'RATE_LIMITED', retry_after: <seconds, fractional>, global: <bool>}`.

`GET /api/v1/rate-limits` (public, cacheable) lists the current limits: the global per-IP and per-user budgets, every special per-route limit (messages 10/10 s per channel, interactions, applications, commands, polls, default `GET` 120/10 s, other methods 40/10 s) and the public web page limit. Buckets are keyed per user and route (and per channel/guild id where the route has one).

### Handling 429 in code

`Rest` retries automatically (3 times, waiting exactly the server's `retry_after`, plus up to 100 ms jitter, never longer than 60 s):

```ts
import { Rest, fetchWithRetry } from '@jorcord/bot-sdk';
const rest = new Rest(base, token, { maxRetries: 5, onRateLimit: (i) => console.log('limited', i.waitMs, i.global) });
// or with any fetch call
const res = await fetchWithRetry(url, { headers }, { maxRetries: 3, maxWaitMs: 30_000 });
```

Options: `maxRetries`, `maxWaitMs` (return the 429 instead of waiting longer), `jitterMs`, `onRateLimit`, `fetchImpl`, `sleep`, `signal`.
