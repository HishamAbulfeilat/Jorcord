# Discord gaps

A checklist of Discord features that Jorcord does **not** have yet. Every item below was verified missing against `apps/server`, `apps/web` and `packages/shared` (searches for transcripts, `MediaRecorder`, `superRe`, `clips`, `recurrence`/`rrule`, `answers_vk`, `Media (media-only)` channel types, `appActivity`/`embedded`/`iframe` in voice, `push` notification settings, `preferredLocale?, onboarding?` and `picture-in-picture?` poll ). Excluded on purpose because they already exist: voice messages attachments SEND permission (server swallows and returns them, `parity-voice-messages.test.ts`), keybinds (`stores/ui.ts` defaultKeybinds + `KeybindsTab`), streamer mode (`lib/streamer.ts`), server templates (`parity-guildextras.test.ts`), Go Live quality presets and viewer quality tiles (`voice/controls.tsx` + `voice/tiles.tsx`), stage channels (`parity-voice-priority.test.ts`, `services/stage.ts`), thread topics and [Stage] so on.

Checklist items are grouped by feature. Each row lists the files it would touch and an S/M/L size.

## Voice messages

- [ ] **Record a voice message from the composer.** The server already accepts audio attachments and returns the `VOICE_MESSAGE`-flavoured attachment (`parity-voice-messages.test.ts`), but the client has no recording button: there is no `MediaRecorder` anywhere in `apps/web` and no audio waveform player (audio attachments render as a bare `<audio controls>` tag).
  Files: apps/web/src/components/chat/Composer.tsx, apps/web/src/components/chat/Attachments.tsx. Size: M.

## Forum / media channels

- [x] **Media channel** (a forum whose posts are media-only, no text body). `ChannelType` has a `'media'` member (`packages/shared/src/types.ts`) and `services/messages` enforces the media-only guard via `isMediaAttachment` / `requireMedia`; posts carry attachments through `POST /channels/:id/forum/posts`.
  Files: packages/shared/src/types.ts, packages/shared/src/limits.ts, apps/server/src/routes/channels.ts, apps/server/src/services/messages.ts, apps/web/src/components/settings/ChannelSettings.tsx. Size: M.
- [ ] **Forum channel default sort order / default layout (gallery or list).** `Channel` carries `availableTags`, `requireTag`, `defaultAutoArchiveDuration` but no `defaultSortOrder` / `defaultForumLayout`; `ForumView.tsx` hard-codes newest-first and has no layout picker.
  Files: packages/shared/src/types.ts, apps/server/src/routes/channels.ts, apps/web/src/components/settings/ChannelSettings.tsx, apps/web/src/components/chat/ForumView.tsx. Size: S.
- [ ] **Forum channel default reaction emoji.** Discord lets a forum add a default reaction to every new post; `channelFields` / `Channel` have no such field and `routes/channels` has no reaction hook for the newly created post.
  Files: packages/shared/src/types.ts, apps/server/src/routes/channels.ts, apps/server/src/services/messages.ts, apps/web/src/components/settings/ChannelSettings.tsx. Size: S.

## Threads

- [x] **`THREAD_DELETE` gateway event.** `gateway/intents.ts` maps `THREAD_DELETE` ([I.GUILDS, 0]); `DELETE /channels/:id` broadcasts `THREAD_DELETE {id,guildId,parentId}` for the thread itself and for every child thread when its parent channel is deleted; `apps/web/src/stores/data.ts` drops the cached thread from the guild on the event.
  Files: apps/server/src/gateway/intents.ts, apps/server/src/routes/channels.ts. Size: S.

## Stage channels

- [ ] **Blocked / anonymous speakers on stage** (invite attendee who then views without identity or raised-hand queue ordering). `services/stage.ts` has request-to-speak and speaker promote/demote but no queue-order persistence beyond `requestToSpeakAt`.
  Files: apps/server/src/services/stage.ts, apps/server/src/routes/voice.ts. Size: S.

## Super reactions

- [ ] **Super reactions (burst reaction emoji with burst bar)** — zero code references; no burst emoji set stored on the server, no burst path in `services/messages` and no burst tint in `MessageItem` / reactions.
  Files: apps/server/src/services/messages.ts, apps/server/src/routes/messages.ts, apps/web/src/components/chat/MessageItem.tsx, apps/web/src/components/chat/ChatView.tsx. Size: M.

## Embeds / atoms

- [x] **Poll answer-voters endpoint and remove-my-vote naming.** `GET /channels/:id/polls/:mid/answers/:id` (paginated with `after`/`limit`, wired into a paged `PollVotersModal`) plus `DELETE /votes/@me`; gateway emits `MESSAGE_POLL_VOTE_ADD`/`MESSAGE_POLL_VOTE_REMOVE` with the per-answer count and distinct-voter total, applied live in `stores/messages.pollVote` + the exact-total re-read in `session.ts`.
  Files: apps/server/src/routes/polls.ts, apps/server/src/services/polls.ts, apps/web/src/lib/polls.ts. Size: S.

## Go Live / streaming extras

- [ ] **"Go Live" viewers overlay + viewer limit / kicked-viewer edge cases.** Quality presets exist (`voice/controls.tsx`, `voice/tiles.tsx`) but there is no viewer list, no viewer cap and no "everyone can watch" invitation model.
  Files: apps/web/src/voice/Room.tsx, apps/web/src/voice/tiles.tsx, apps/server/src/services/voice.ts. Size: M.

## Activities / embedded apps

- [ ] **Activities menu (embedded apps such as YouTube Together, Poker, Chess).** Rich presence is implemented (`parity-activities.test.ts`), but nothing in `apps/web/src/voice` spins up an embedded-app session, and the server has no app-activity invite/voice-track model.
  Files: apps/web/src/voice/controls.tsx, apps/web/src/voice/Room.tsx, apps/server/src/services/voice.ts, apps/server/src/routes/activities.ts. Size: L.

## Scheduled events

- [ ] **Scheduled-event recurrence rules.** `routes/events.ts` has no `recurrence` field, `eventFields` contains only start/end/location/image/privacyLevel, and there is no `rrule` expansion anywhere.
  Files: apps/server/src/routes/events.ts, apps/server/src/services/scheduled.ts, packages/shared/src/types.ts, apps/web/src/components/modals/PlatformModals.tsx. Size: M.

## Message extras

- [ ] **Message clips (in-app screen-recording clipping, clips channel auto-collect).** There is no clips service, no clips-channel semantics (the `'clips'` channel in the default template is an ordinary text channel), and no clip upload route — the client only has clipboard paste in the composer and soundboard clips in the voice dock.
  Files: apps/server/src/routes/messages.ts, apps/server/src/services/messages.ts, apps/web/src/lib/menus.ts, apps/web/src/components/chat/MessageItem.tsx. Size: L.

## Polls details

- [ ] **Poll answer-voter list with member filters and multi-select vote events.** `GET /channels/:id/polls/:mid/answers/:answerId` exists, but there is no `?type=` filter, no `MESSAGE_UPDATE` re-render of vote counts, and poll expiry auto-finalize is timestamp-based only (`poll_expiry`), so an instant-finalize edit is impossible.
  Files: apps/server/src/routes/polls.ts, apps/server/src/services/polls.ts, apps/web/src/components/chat/MessageExtras.tsx. Size: S.
