# Discord gaps

A checklist of Discord features and whether Jorcord has them. Last verified against the repo on 2026-10-22 (server migrations 001-042 plus 049-051 and 060, `apps/server/src/routes/*.ts`, `apps/web/src`, `packages/shared`). A ticked item names the code and test that prove it; an unticked item was checked and is still missing. Items this file once called missing (voice-message recording, forum defaults, super reactions, activities, recurrence, clips, poll voter filters, Components V2, scheduled sends, profile effects, link safety, desktop clipboard/keychain/idle) have since landed.

Checklist items are grouped by feature. Each row lists the files involved and an S/M/L size.

## Voice messages

- [x] **Record a voice message from the composer.** `apps/web/src/lib/voiceRecord.ts` (MediaRecorder) and `lib/voiceMsg.ts` (waveform) feed the composer and `chat/Attachments.tsx` renders the voice-message player (`voiceRecord.test.ts`, `voiceMsg.test.ts`, `Attachments.test.tsx`). Server: audio attachments need `SEND_VOICE_MESSAGES` (`routes/messages.ts`, `parity-voice-messages.test.ts`).
  Files: apps/web/src/lib/voiceRecord.ts, apps/web/src/lib/voiceMsg.ts, apps/web/src/components/chat/Composer.tsx, apps/web/src/components/chat/Attachments.tsx. Size: M.

## Forum / media channels

- [x] **Media channel** (a forum whose posts are media-only, no text body). `ChannelType` has a `'media'` member (`packages/shared/src/types.ts`) and `services/messages` enforces the media-only guard via `isMediaAttachment` / `requireMedia`; posts carry attachments through `POST /channels/:id/forum/posts`.
  Files: packages/shared/src/types.ts, packages/shared/src/limits.ts, apps/server/src/routes/channels.ts, apps/server/src/services/messages.ts, apps/web/src/components/settings/ChannelSettings.tsx. Size: M.
- [x] **Forum channel default sort order / default layout (gallery or list).** Migration `034_forum_defaults.sql`; `PATCH /channels/:id` accepts `defaultSortOrder` / `defaultForumLayout` (`routes/channels.ts`, `parity-forum-defaults.test.ts`); `ForumView.tsx` and `ChannelSettings.tsx` use them.
  Files: packages/shared/src/types.ts, apps/server/src/routes/channels.ts, apps/web/src/components/settings/ChannelSettings.tsx, apps/web/src/components/chat/ForumView.tsx. Size: S.
- [x] **Forum channel default reaction emoji.** `defaultReactionEmoji` (migration 034) is added by the author to every new post in `POST /channels/:id/forum/posts`; a custom default must be an emoji of the same server (checked since the 2026-10 review; `sec-review-2026-10.test.ts`).
  Files: packages/shared/src/types.ts, apps/server/src/routes/channels.ts, apps/server/src/services/messages.ts, apps/web/src/components/settings/ChannelSettings.tsx. Size: S.

## Threads

- [x] **`THREAD_DELETE` gateway event.** `gateway/intents.ts` maps `THREAD_DELETE` ([I.GUILDS, 0]); `DELETE /channels/:id` broadcasts `THREAD_DELETE {id,guildId,parentId}` for the thread itself and for every child thread when its parent channel is deleted; `apps/web/src/stores/data.ts` drops the cached thread from the guild on the event.
  Files: apps/server/src/gateway/intents.ts, apps/server/src/routes/channels.ts. Size: S.

## Stage channels

- [x] **Blocked / anonymous speakers on stage and raised-hand queue ordering.** The queue is persisted (`stage_hand_queue`, migration 058; first come first served, kept for 120 s while the member is away, moderators read it with identities from `GET /channels/:id/stage/queue`), hands can be anonymous, and moderators can block a member from speaking (`stage_speaker_blocks`; a host/member block also refuses the hand). `STAGE_QUEUE_UPDATE` / `STAGE_HAND_UPDATE` events; web `voice/StageQueue.tsx`.
  Files: apps/server/src/services/stage.ts, apps/server/src/routes/voice.ts, apps/web/src/voice/StageQueue.tsx. Size: S.

## Super reactions

- [x] **Super reactions (burst reaction emoji with burst bar).** Migration `035_burst_reactions.sql` (`reactions.burst`, `burst_color`, `burst_reaction_usage`); `PUT .../reactions/:emoji/@me` with `{ burst: true }` and a daily allowance (`LIMITS.burstReactionsPerDay`, `consumeBurstQuota` in `services/messages.ts`); web `chat/Reactions.tsx` and `stores/messages.ts` (`burst-reactions.test.ts` on both sides).
  Files: apps/server/src/services/messages.ts, apps/server/src/routes/messages.ts, apps/web/src/components/chat/MessageItem.tsx, apps/web/src/components/chat/ChatView.tsx. Size: M.

## Embeds / atoms

- [x] **Poll answer-voters endpoint and remove-my-vote naming.** `GET /channels/:id/polls/:mid/answers/:id` (paginated with `after`/`limit`, wired into a paged `PollVotersModal`) plus `DELETE /votes/@me`; gateway emits `MESSAGE_POLL_VOTE_ADD`/`MESSAGE_POLL_VOTE_REMOVE` with the per-answer count and distinct-voter total, applied live in `stores/messages.pollVote` + the exact-total re-read in `session.ts`.
  Files: apps/server/src/routes/polls.ts, apps/server/src/services/polls.ts, apps/web/src/lib/polls.ts. Size: S.

## Go Live / streaming extras

- [x] **"Go Live" viewers overlay + viewer limit / kicked-viewer edge cases.** `GET /channels/:id/voice/streams`, per-stream viewer cap (`PUT /channels/:id/voice/stream`, bounded by `STREAM_MAX_VIEWERS`), watch / stop watching with `STREAM_FULL` and `STREAM_VIEWER_KICKED` refusals, and kicking viewers (streamer or MOVE_MEMBERS; migration 059), enforced in LiveKit by the streamer's subscription permissions. Web: "who is watching" overlay with the viewer list, limit picker and remove/allow-again buttons (`voice/StreamAudience.tsx`). There is still no "everyone can watch" invitation model.
  Files: apps/server/src/services/streams.ts, apps/server/src/routes/voice.ts, apps/web/src/voice/StreamAudience.tsx, apps/web/src/voice/tiles.tsx. Size: M.

## Activities / embedded apps

- [x] **Shared voice-channel activities (Watch Together, Tic-Tac-Toe).** Migration `042_channel_activities.sql`; `routes/activities.ts` (`/channels/:id/activities`, `/activities/:id`) with server-side authorization: you must be connected to the voice channel, Tic-Tac-Toe moves are validated by `services/tictactoe.ts`, and only the host or a `MANAGE_CHANNELS` holder can end a session (`parity-channel-activities.test.ts`); web `voice/WatchTogether.tsx`, `voice/TicTacToe.tsx`. Not built: third-party embedded apps (Poker, Chess) and an Embedded-App-SDK.
  Files: apps/server/src/routes/activities.ts, apps/server/src/services/tictactoe.ts, apps/web/src/voice/WatchTogether.tsx, apps/web/src/voice/TicTacToe.tsx. Size: L.

## Scheduled events

- [x] **Scheduled-event recurrence rules.** Migration `036_recurrence.sql`; `recurrenceRule` (daily/weekly/monthly, interval, until, count) in `routes/events.ts`; `nextOccurrences` computed in `services/scheduled.ts` (`platform.test.ts` "recurrence"); web `PlatformModals.tsx` and `lib/events.ts`.
  Files: apps/server/src/routes/events.ts, apps/server/src/services/scheduled.ts, packages/shared/src/types.ts, apps/web/src/components/modals/PlatformModals.tsx. Size: M.

## Message extras

- [x] **Message clips (in-app screen-recording clipping, clips channel).** Server: migration `040_clips.sql`, `isClipsChannel` on channels, `routes/clips.ts` (`POST/GET /channels/:id/clips`, `DELETE /channels/:id/clips/:clipId`; only in a clips channel, MP4/WebM sniffed by magic bytes, 30 s and 100 MB limits, 6 posts/min; `clips.test.ts`). Web: rolling MediaRecorder buffer (30 s / 1 min / 2 min) in `voice/clipBuffer.ts` + `voice/ClipRecorder.tsx`, preview/download/share in `voice/ClipModals.tsx`, clips viewer button in `ChatView.tsx` (`clipBuffer.test.ts`, `clipModals.test.tsx`). Not built: a 10 min buffer and a trim editor.
  Files: apps/server/src/routes/clips.ts, apps/web/src/voice/ClipRecorder.tsx, apps/web/src/voice/clipBuffer.ts, apps/web/src/voice/ClipModals.tsx. Size: L.

## Polls details

- [x] **Poll answer-voter list with member filters and multi-select vote events.** `GET /channels/:id/polls/:mid/answers/:answerId?type=members|bots` (`routes/polls.ts`); `POST .../polls/:mid/expire` ends a poll early; `finalizePoll` emits `MESSAGE_UPDATE` (`services/polls.ts`); vote events are covered in `hardening.test.ts`.
  Files: apps/server/src/routes/polls.ts, apps/server/src/services/polls.ts, apps/web/src/components/chat/MessageExtras.tsx. Size: S.

## Components V2

- [x] **Components V2 layout messages** (container, section, text display, thumbnail, media gallery, file, separator). Bots set the `IS_COMPONENTS_V2` flag (`1 << 15`) and send layout components only (no content, embeds, stickers, poll). `lib/components.ts` validates structure and limits (10 top-level, 40 total, 4000 text characters, `attachment://` references must match an attachment); buttons inside containers and sections are pressable (`findComponent` is recursive); web `chat/ComponentsV2.tsx`; bot-sdk builders `v2()`, `container()`, `section()` ... (`components-v2.test.ts`, `ComponentsV2.test.tsx`, bot-sdk `integration.test.ts`). Not built: webhook execute with V2, select menus outside action rows.
  Files: packages/shared/src/platform.ts, apps/server/src/lib/components.ts, apps/web/src/components/chat/ComponentsV2.tsx, packages/bot-sdk/src/index.ts. Size: M.

## Scheduled sends

- [x] **Schedule a message to send later.** Migration `060_scheduled_messages.sql`; `POST /channels/:id/scheduled-messages`, `GET/DELETE /users/@me/scheduled-messages`; the sweeper (`services/scheduledMessages.ts`) claims due rows atomically, re-checks channel permissions, DM blocks and slowmode at send time and records failures; gateway `SCHEDULED_MESSAGE_UPDATE`; web composer clock button, `ScheduleModal`, Inbox > Scheduled (`scheduled-messages.test.ts`, `ScheduleModal.test.tsx`). Limits: text only, 10 s to 30 days ahead, 25 pending per user; the send time is accurate to the sweep interval (10 s by default).
  Files: apps/server/src/services/scheduledMessages.ts, apps/server/src/routes/scheduledMessages.ts, apps/web/src/components/modals/ScheduleModal.tsx. Size: M.

## Cosmetics

- [x] **Avatar decorations and profile effects.** Eight original CSS decorations and ten original CSS profile effects (no Discord assets); migration `017_cosmetics.sql`, ids validated against the shared catalog in `PATCH /users/@me`, broadcast on `USER_UPDATE`, drawn by `Avatar.tsx` everywhere avatars appear and by `ProfileEffect` on profile cards; picker in Settings > Profile (`CosmeticsPicker.tsx`); `parity-cosmetics.test.ts` (every catalog id round-trips), `lib/cosmetics.test.ts` (every id has CSS).
  Files: packages/shared/src/parity.ts, apps/web/src/cosmetics.css, apps/web/src/components/settings/CosmeticsPicker.tsx. Size: M.

## Link and file safety

- [x] **External-link confirmation and risky-file warning.** Links to hosts other than this app/server ask first, with a "trust this domain" option stored in the account's preferences (`trustedLinkDomains`, managed in Privacy & Safety); executable/script/macro attachments (and names like `invoice.pdf.exe`) get a warning before open or download (`lib/links.ts`, `modals/LinkGuard.tsx`, `links.test.ts`). Applies to message links, embed titles, link buttons and attachment links.
  Files: apps/web/src/lib/links.ts, apps/web/src/components/modals/LinkGuard.tsx, apps/web/src/components/settings/LinkSafetyPanel.tsx. Size: S.

## Desktop native

- [x] **Clipboard, OS-keychain token storage, idle and wake presence (Tauri).** `tauri-plugin-clipboard-manager`; `keyring` crate behind `secure_set/get/delete` (login tokens move into the keychain, web storage is the fallback); `idle_seconds` (Windows `GetLastInputInfo`, macOS CoreGraphics; Linux falls back to in-window activity) and a `jorcord://power` wake event drive automatic idle after N minutes (`lib/idle.ts`, setting in Privacy & Safety). `cargo check` passes on Linux; the Windows and macOS code and the real keychain were not run. Not built: native file dialogs, lock/unlock/suspend events, clipboard images.
  Files: apps/desktop/src-tauri/src/lib.rs, apps/web/src/lib/native.ts, apps/web/src/lib/secureStore.ts, apps/web/src/lib/authStorage.ts, apps/web/src/lib/idle.ts. Size: L.
