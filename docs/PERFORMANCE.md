# Performance and memory

Goal: a Jorcord tab that stays open for days must not grow without bound (the "Discord uses 4 GB" problem).

## What was leaking or growing (web client)

| Source | Problem | Fix |
|---|---|---|
| `stores/messages` | Every channel ever opened stayed in memory; every gateway `MESSAGE_CREATE`/reaction/update for a channel nobody opened *allocated a new channel list*; a channel's list only grew while paging or receiving live messages. | LRU of loaded channels (cap 12, viewed channels and channels with unsent messages are never evicted); events for unopened channels allocate nothing; per-channel window cap (400 messages + 25% slack) that drops the end far from the reader and flips `hasMoreOlder`/`hasMoreNewer` so it re-fetches on demand. `MessageList` keeps the scroll anchor across a far-end trim. |
| `stores/data` | `users` gained every author ever seen, `presences`/`activities` never shrank, `typing` kept expired entries. | `lib/memoryManager` pass every 30 s: unreferenced users beyond 4000 are dropped (members, DM peers, friends, voice participants and authors of cached messages are always kept), orphan presences/activities removed, expired typing pruned. |
| Composer | `URL.createObjectURL` previews for staged images were never revoked. | Revoked when a file leaves the tray, on send, channel switch and unmount. |
| Guild settings sticker upload | blob preview never revoked. | revoked on change/unmount. |
| `Avatar` first-frame cache | unbounded map of data URLs. | LRU of 150. |
| Animated images | `autoplayGifs` pref was not used anywhere; every GIF animated at once. | `AnimatedImg`: honours Autoplay GIFs / Reduce motion, animates only while on screen, max 12 concurrently (3 in low-memory mode), others show frame one (hover/tap plays). Images decode async and lazily. |
| Service worker | image cache 300 entries / 30 days. | 150 entries / 14 days, `purgeOnQuotaError`. |

Already fine: message list and member list are virtualised (`@tanstack/react-virtual`); timers/listeners in the audited components are cleaned up.

## Settings > Advanced > Memory & performance

Shows the JS heap (Chromium only), storage used, channels/messages/users/requests held, and offers:

* **Low-memory mode** (per device): 4 channels, 150 messages per channel, 1000 users, 3 animated images.
* **Reduce animations and stop auto-playing GIFs**.
* **Clear caches**: evicts unviewed channels, prunes users, drops inactive queries and the runtime image cache. Nothing is deleted from the account.

## Soak test

`e2e/tests/perf-soak.spec.ts` (runs in the normal e2e suite; also `pnpm exec playwright test -c e2e/playwright.perf.config.ts` for API + web only, no LiveKit). It seeds a 1500-message channel plus 13 more, then per round: scrolls back through history, switches through all 14 channels while a second user floods 80 messages into open and never-opened channels, optionally joins/leaves voice (`PERF_VOICE=1`). Heap is measured through CDP after forced GC. Asserts (generous): heap growth below `PERF_HEAP_CEILING_MB` (120), channels in memory <= 12, messages in memory <= 6000. Writes `test-results/perf-soak.json`. Knobs: `PERF_SOAK_ROUNDS`, `PERF_SEED`, `PERF_REPORT`.

Unit tests: `apps/web/src/lib/memory.test.ts` (eviction, caps, trimming, user pruning, animation slots).

## Numbers

Measured soak (Chromium headless, 1500-message busy channel + 13 channels of 60, 3 rounds of history scrolling, 14-channel switching and an 80-message gateway flood; heap after forced GC):

| Checkpoint | JS heap | DOM nodes | JS listeners |
|---|---|---|---|
| baseline, busy channel open | 24.8 MB | 11838 | 742 |
| after round 1 | 26.2 MB | 13501 | 974 |
| after round 2 | 25.4 MB | 12774 | 927 |
| after round 3 | 25.5 MB | 12599 | 912 |

Heap growth over the soak: +0.7 MB (flat after round 1); channels in memory 12 (cap), messages in memory 612. CI ceiling: 120 MB growth.

A full before/after of the soak was not run (shared machine, ~9 minutes under load). The store-level before/after is deterministic and covered by `memory.test.ts`:

| Scenario | Before | After |
|---|---|---|
| 2000 live messages into one open channel | all kept | at most 188 (low-memory) / 500 (normal) |
| 500 gateway messages for a channel nobody opened | 500 messages allocated in a new list | 0 |
| open 8 channels in a row (low-memory cap 4) | 8 lists kept | 4 |
| 1500 unreferenced users seen via messages | all kept | pruned to the cap, referenced users kept |

## Search and mobile (not memory, same pass)

* Search: `from:`/`mentions:` accept ids, `name`, `@name`, `name#0` and are resolved on the server, so accounts that left the server still match and their messages render with the author sent by the server. Embed title/description/url and attachment filename/alt text are searchable (`messages.search_extra`, trigger-maintained, migration 140; GIN index 141). New `link:` token, stable paging (`before` cursor for newest-first, `offset` otherwise), highlighted matches, recent searches, filter chips and a full-screen mobile layout.
* Mobile: configurable swipe actions (Settings > Appearance; right = reply, left = react by default; swipes starting at the screen edge still open the drawers), long-press sheet with six quick tiles, persistent "jump to present", quick switcher button in the header, and a hold-to-talk button in the voice dock / mobile voice bar when Push to Talk is the input mode.
