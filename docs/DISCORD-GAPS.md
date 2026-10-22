# Discord gaps

A checklist of Discord features and whether Jorcord has them. Last verified against the repo on 2026-10-22 (server migrations 001-042 plus 049/050, `apps/server/src/routes/*.ts`, `apps/web/src`, `packages/shared`). A ticked item names the code and test that prove it; an unticked item was checked and is still missing. Items this file once called missing (voice-message recording, forum defaults, super reactions, activities, recurrence, clips, poll voter filters) have since landed.

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

- [ ] **Blocked / anonymous speakers on stage** (invite attendee who then views without identity or raised-hand queue ordering). `services/stage.ts` has request-to-speak and speaker promote/demote but no queue-order persistence beyond `requestToSpeakAt`.
  Files: apps/server/src/services/stage.ts, apps/server/src/routes/voice.ts. Size: S.

## Super reactions

- [x] **Super reactions (burst reaction emoji with burst bar).** Migration `035_burst_reactions.sql` (`reactions.burst`, `burst_color`, `burst_reaction_usage`); `PUT .../reactions/:emoji/@me` with `{ burst: true }` and a daily allowance (`LIMITS.burstReactionsPerDay`, `consumeBurstQuota` in `services/messages.ts`); web `chat/Reactions.tsx` and `stores/messages.ts` (`burst-reactions.test.ts` on both sides).
  Files: apps/server/src/services/messages.ts, apps/server/src/routes/messages.ts, apps/web/src/components/chat/MessageItem.tsx, apps/web/src/components/chat/ChatView.tsx. Size: M.

## Embeds / atoms

- [x] **Poll answer-voters endpoint and remove-my-vote naming.** `GET /channels/:id/polls/:mid/answers/:id` (paginated with `after`/`limit`, wired into a paged `PollVotersModal`) plus `DELETE /votes/@me`; gateway emits `MESSAGE_POLL_VOTE_ADD`/`MESSAGE_POLL_VOTE_REMOVE` with the per-answer count and distinct-voter total, applied live in `stores/messages.pollVote` + the exact-total re-read in `session.ts`.
  Files: apps/server/src/routes/polls.ts, apps/server/src/services/polls.ts, apps/web/src/lib/polls.ts. Size: S.

## Go Live / streaming extras

- [ ] **"Go Live" viewers overlay + viewer limit / kicked-viewer edge cases.** Quality presets exist (`voice/controls.tsx`, `voice/tiles.tsx`) but there is no viewer list, no viewer cap and no "everyone can watch" invitation model.
  Files: apps/web/src/voice/Room.tsx, apps/web/src/voice/tiles.tsx, apps/server/src/services/voice.ts. Size: M.

## Activities / embedded apps

- [x] **Shared voice-channel activities (Watch Together, Tic-Tac-Toe).** Migration `042_channel_activities.sql`; `routes/activities.ts` (`/channels/:id/activities`, `/activities/:id`) with server-side authorization: you must be connected to the voice channel, Tic-Tac-Toe moves are validated by `services/tictactoe.ts`, and only the host or a `MANAGE_CHANNELS` holder can end a session (`parity-channel-activities.test.ts`); web `voice/WatchTogether.tsx`, `voice/TicTacToe.tsx`. Not built: third-party embedded apps (Poker, Chess) and an Embedded-App-SDK.
  Files: apps/server/src/routes/activities.ts, apps/server/src/services/tictactoe.ts, apps/web/src/voice/WatchTogether.tsx, apps/web/src/voice/TicTacToe.tsx. Size: L.

## Scheduled events

- [x] **Scheduled-event recurrence rules.** Migration `036_recurrence.sql`; `recurrenceRule` (daily/weekly/monthly, interval, until, count) in `routes/events.ts`; `nextOccurrences` computed in `services/scheduled.ts` (`platform.test.ts` "recurrence"); web `PlatformModals.tsx` and `lib/events.ts`.
  Files: apps/server/src/routes/events.ts, apps/server/src/services/scheduled.ts, packages/shared/src/types.ts, apps/web/src/components/modals/PlatformModals.tsx. Size: M.

## Message extras

- [ ] **Message clips (in-app screen-recording clipping, clips channel auto-collect).** Server side is done: migration `040_clips.sql`, `isClipsChannel` on channels, `routes/clips.ts` (`POST/GET /channels/:id/clips`, `DELETE /channels/:id/clips/:clipId`; only in a clips channel, MP4/WebM sniffed by magic bytes, 30 s and 100 MB limits, 6 posts/min; `clips.test.ts`). Still open: the web clips UI (recorder, clips channel view) and the screen-recording capture itself.
  Files: apps/server/src/routes/messages.ts, apps/server/src/services/messages.ts, apps/web/src/lib/menus.ts, apps/web/src/components/chat/MessageItem.tsx. Size: L.

## Polls details

- [x] **Poll answer-voter list with member filters and multi-select vote events.** `GET /channels/:id/polls/:mid/answers/:answerId?type=members|bots` (`routes/polls.ts`); `POST .../polls/:mid/expire` ends a poll early; `finalizePoll` emits `MESSAGE_UPDATE` (`services/polls.ts`); vote events are covered in `hardening.test.ts`.
  Files: apps/server/src/routes/polls.ts, apps/server/src/services/polls.ts, apps/web/src/components/chat/MessageExtras.tsx. Size: S.
