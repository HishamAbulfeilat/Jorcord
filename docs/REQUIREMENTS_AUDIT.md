# Requirements audit (JO-044)

Audited 2026-10-22 against the repo at `claude/discord-clone-design-cdj43b`; rows 12 (clips), the Phase A desktop row and section 4 were re-verified after the follow-up work listed there. Method: for every item the claim in `docs/DISCORD-GAPS.md` and the Phase A line of `docs/JORCORD_MASTER_PLAN.md` section 8 was checked against the named files, routes, migrations and tests. Status is **done** (implemented and covered by a test), **partial** (works but a stated part is missing or untested) or **missing**. The first audit only reported; the follow-up pass then brought DISCORD-GAPS.md, PARITY_TODO.md and the master plan status rows in line with this file (rows for permission bits, server tags, message requests, forwarding, welcome screen, priority speaker, stage queue and Go Live viewers were deliberately left to a later pass).

## 1. DISCORD-GAPS.md

The file currently lists 13 original checklist rows plus the rows added for Components V2, scheduled sends, cosmetics, link safety and desktop native (all ticked, see section 4). The original 13 are covered.

| # | Item | Status | Evidence |
|---|------|--------|----------|
| 1 | Voice message recording from the composer | done | `apps/web/src/lib/voiceRecord.ts`, `lib/voiceMsg.ts`, `components/chat/Attachments.tsx`; server gate `routes/messages.ts` L163-164 (`SEND_VOICE_MESSAGES` for `audio/*`); tests `apps/server/test/parity-voice-messages.test.ts`, web `voiceRecord.test.ts`, `voiceMsg.test.ts` |
| 2 | Media channel (media-only posts) | done | `ChannelType` includes `'media'` (`packages/shared/src/types.ts` L6); `requireMedia`/`isMediaAttachment` guard in `services/messages.ts` L84 |
| 3 | Forum default sort order / layout | done | migration `034_forum_defaults.sql`; `routes/channels.ts` L128 (`defaultSortOrder`, `defaultForumLayout`); `test/parity-forum-defaults.test.ts`; `ForumView.tsx` |
| 4 | Forum default reaction emoji | done | `routes/channels.ts` L128/L137 (custom emoji must belong to the server); covered in `test/sec-review-2026-10.test.ts` and `parity-forum-defaults.test.ts` |
| 5 | `THREAD_DELETE` gateway event | done | `gateway/intents.ts` L11 mapping; `routes/channels.ts` L184-186 emits for the thread and each child thread; web `stores/data.ts` L153 drops the thread |
| 6 | Blocked / anonymous speakers, raised-hand queue ordering | missing | `services/stage.ts` has request-to-speak and promote/demote only; no persisted queue order and no anonymous viewing. Correctly unticked in DISCORD-GAPS.md |
| 7 | Super (burst) reactions | done | migration `035_burst_reactions.sql`; `routes/messages.ts` L44-45 (`burst`, `burstColor`), daily quota in `services/messages.ts`; `test/burst-reactions.test.ts` (server and web) |
| 8 | Poll answer voters endpoint, remove vote | done | `routes/polls.ts` L64 (`GET .../answers/:answerId`), `DELETE .../votes/@me`, `POST .../expire` L82; `web/src/lib/polls.ts`; `test/hardening.test.ts` covers vote events |
| 9 | Go Live viewer overlay / viewer cap | missing | no viewer list or cap in `services/voice.ts`; only quality presets in `web/src/voice/tiles.tsx` / `controls.tsx`. Correctly unticked |
| 10 | Shared voice-channel activities (Watch Together, Tic-Tac-Toe) | done | migration `042_channel_activities.sql`; `routes/activities.ts`, `services/tictactoe.ts` (server-validated moves); web `voice/WatchTogether.tsx`, `voice/TicTacToe.tsx`; `test/parity-channel-activities.test.ts`. Third-party embedded apps / Embedded App SDK are not built (stated in the file) |
| 11 | Scheduled-event recurrence | done | migration `036_recurrence.sql`; `routes/events.ts`; `services/scheduled.ts` (`nextOccurrences`); `test/platform.test.ts` "recurrence"; web `lib/events.ts` |
| 12 | Message clips | done | Server: migration `040_clips.sql`, `routes/clips.ts` (clips channel only, magic-byte sniff, 30 s / 100 MB, rate limit), `test/clips.test.ts`. Web (landed since the first audit): `voice/clipBuffer.ts` + `voice/ClipRecorder.tsx` rolling buffer, `voice/ClipModals.tsx` preview/share, clips viewer button in `chat/ChatView.tsx`; tests `clipBuffer.test.ts`, `clipModals.test.tsx` |
| 13 | Poll voter member filters, multi-select vote events | done | `routes/polls.ts` (`?type=members|bots`), `services/polls.ts` `finalizePoll` emits `MESSAGE_UPDATE`; `test/hardening.test.ts` |

Summary: 11 done, 0 partial, 2 missing (stage anonymous speakers / queue order, Go Live viewer overlay and cap).

## 2. Master plan Phase A (section 8)

| Item | Status | Evidence / gap |
|------|--------|----------------|
| Permission bits audit + missing bits | partial | `packages/shared/src/permissions.ts` has 44 bits including `SEND_POLLS`, `USE_EXTERNAL_APPS`, `SEND_VOICE_MESSAGES`, `CREATE_EVENTS`, `MANAGE_EVENTS`, `RECORD_VOICE`; positions above bit 32 intentionally differ from Discord and are mapped in `DISCORD_PERMISSION_BITS`; `test/permissions.test.ts`. Still absent: `PIN_MESSAGES`, `BYPASS_SLOWMODE`, `USE_EXTERNAL_STICKERS`, `VIEW_GUILD_INSIGHTS` (grep finds none) |
| `allowed_mentions` | done | `routes/messages.ts` accepts `allowedMentions`; stored in `messages.allowed_mentions` (migration `028_allowed_mentions.sql`); `services/serializers.ts` L134; `test/parity-messages-mentions.test.ts` |
| Message flags | partial | `MessageFlags` in `packages/shared/src/platform.ts` L90. User sends accept `SUPPRESS_EMBEDS` and `SUPPRESS_NOTIFICATIONS` only (`routes/messages.ts` L140); `SUPPRESS_NOTIFICATIONS` honoured in `services/push.ts` L276; `EPHEMERAL`/`LOADING` used by interactions. No test dedicated to `SUPPRESS_EMBEDS` on normal messages was found |
| Client-sent embeds | done | `routes/messages.ts` L29-30 (bots/webhooks only, validated by `lib/embeds.ts`); `test/parity-embeds.test.ts` |
| Webhook full API | done | `routes/channels.ts`: list/create/get/patch/delete by id (L230-321) and by token (L528-565), execute (L563) and message get/patch/delete (L594-620); `test/parity-webhooks.test.ts`, `sec3-webhook-token-channel.test.ts` |
| Announcement follow / crosspost | done | `routes/follows.ts` (follow, `POST /channels/:id/messages/:mid/crosspost` L99, ping defanging), migration `020_follows.sql`; `test/parity-follows.test.ts` |
| Stage-instance polish | done | `routes/events.ts` L202-233 (`POST/GET/PATCH/DELETE /stage-instances`), `services/stage.ts`; request-to-speak in `routes/voice.ts` L93-99; `test/platform.test.ts` L721-778. (PARITY.md row 34 still says "partial"; the code is ahead of that row) |
| Audit-log coverage | partial | `audit()` called from 17 route/service files; numeric `AuditActionType` taxonomy (`packages/shared/src/platform.ts` L37-53) with `?actionType=` filter (`routes/guilds.ts` L148-154); `MESSAGE_PIN`, `STICKER_UPDATE`, `WEBHOOK_UPDATE`, `BOT_ADD` are emitted. Recently added: ban appeal actions 195-197. Gaps: not every taxonomy entry has an emitter and there is no automated check that each is emitted |
| Reports API + mod queue | done | migration `029_reports.sql`; `routes/modtools.ts` L205-246 (create with 10/h limit, list, resolve); `test/parity-reports.test.ts`; web report form and queue |
| Verification level / explicit filter fields | done | migration `018_safety.sql`; `routes/safety.ts` L12-26; enforcement in `services/safety.ts` L26-43; `test/parity-safety.test.ts` |
| Desktop P1 native items | partial | Tauri shell `apps/desktop/src-tauri/src/lib.rs`: tray (`TrayIconBuilder`), badge (capability `core:window:allow-set-badge-count`, `web/src/lib/native.ts` `setBadgeCount`), autostart, deep links, single instance, updater, window state, opener, game detection and overlay commands. Added since: clipboard plugin, OS keychain tokens, system idle time and wake detection, external-link confirmation (section 4). **Still missing:** native file dialogs (the browser file input is used), lock/unlock/suspend events (only wake-from-sleep is detected), clipboard images |

Summary: 6 done, 4 partial (permission bits, message flags, audit coverage, desktop native), 0 completely missing.

## 3. Account features added in this pass (for the record)

| Ticket | Status | Evidence |
|--------|--------|----------|
| JO-051 Passkeys | done | migration `049_passkeys.sql`, `routes/passkeys.ts`, `services/passkeys.ts`, tests `test/passkeys.test.ts` (software authenticator), e2e `e2e/tests/passkeys.spec.ts` (CDP virtual authenticator) |
| JO-052 Ban appeals | done | migration `050_ban_appeals.sql`, `routes/appeals.ts`, `services/appeals.ts`, `test/ban-appeals.test.ts`, e2e `e2e/tests/appeals.spec.ts` |
| JO-054 Data export | done | migration `051_export_jobs.sql`, `routes/dataexport.ts`, `services/dataExport.ts`, `lib/zip.ts`, `test/data-export.test.ts`, e2e `e2e/tests/data-export.spec.ts`. Not done: a deletion grace period (master plan 4.1 row) |

## 4. Follow-up work (this pass)

Verified by `pnpm -r typecheck`, server tests (69 files, 476 passed), web tests (85 files, 485 passed) and the web production build. Desktop Rust: `cargo check` on Linux only.

| Item | Status | Evidence |
|------|--------|----------|
| External-link confirmation with per-user trusted domains; risky-file warning | done | `apps/web/src/lib/links.ts`, `components/modals/LinkGuard.tsx`, `components/settings/LinkSafetyPanel.tsx`; links wired in `chat/Markdown.tsx`, `chat/Attachments.tsx` (embed titles, files), `chat/MessageExtras.tsx` (link buttons); tests `lib/links.test.ts`. Trusted domains are the `trustedLinkDomains` pref (synced with the account settings) |
| Desktop clipboard plugin | done (unverified at runtime) | `tauri-plugin-clipboard-manager` in `Cargo.toml`/`lib.rs`/`capabilities/default.json`; `clipboard` in `lib/native.ts`, used by `copyText` in `lib/format.ts`; `native.test.ts`. Falls back to `navigator.clipboard` |
| Keychain token storage | done (unverified at runtime) | `keyring` crate with `secure_set/get/delete` (allow-listed slots `auth`, `accounts`); `lib/secureStore.ts`, `lib/authStorage.ts` (`hydrateSecureAuth` before first render in `main.tsx`; failure falls back to web storage; tokens are migrated into the keychain and removed from web storage); tests `authStorage.test.ts` with a fake keychain. Other accounts' tokens (`lib/accounts.ts`) are still in web storage |
| Idle and power presence | done (partly unverified) | `idle_seconds` command (Windows `GetLastInputInfo`, macOS `CGEventSourceSecondsSinceLastEventType`, none on Linux) and `jorcord://power` wake event (clock-gap detector); `lib/idle.ts` moves only `online` to `idle` and back (never DND/invisible), setting "Go idle automatically" (default 10 min); tests `lib/idle.test.ts`. Not verified: the Windows/macOS code does not compile on this Linux host |
| Profile effects and avatar decorations | done | already end to end (migration 017, validation, DTO, `Avatar.tsx`, picker); this pass added four effects (embers, petals, starfield, northern lights) and a server test that every catalog id round-trips |
| Components V2 | done | see DISCORD-GAPS.md "Components V2"; `test/components-v2.test.ts`, `ComponentsV2.test.tsx`, bot-sdk integration test |
| Scheduled message sends | done | migration `060_scheduled_messages.sql`; `test/scheduled-messages.test.ts`, `lib/scheduledMessages.test.ts`, `ScheduleModal.test.tsx` |

## 5. Recommended follow-ups

1. (done) Web clips recorder and clips channel view.
2. Add `PIN_MESSAGES`, `BYPASS_SLOWMODE`, `USE_EXTERNAL_STICKERS` permission bits with a migration that ORs them into existing roles where appropriate.
3. Desktop: native file dialogs, lock/unlock/suspend events, clipboard images, move other accounts' tokens into the keychain, and a run on real Windows/macOS/Linux desktops (see section 4).
4. A test that walks `AuditActionType` and asserts each action has an emitter or is marked reserved.
5. Stage anonymous speakers / persisted raised-hand order; Go Live viewer cap.
