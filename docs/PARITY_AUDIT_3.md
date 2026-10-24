# Parity audit 3: Discord (late 2026) vs Jorcord

Date: 2026-10-24. Method: every row below was checked against the code (routes in `apps/server/src/routes`, services, migrations 001-090, shared types, `apps/web/src`, `apps/desktop/src-tauri`, `apps/mobile`, tests). Older docs (`PARITY.md`, `PARITY_TODO.md`, `DISCORD-GAPS.md`, `GAPS_AUDIT_2.md`) were used only as a map; where they disagree with the code, the code wins.

Out of scope on purpose: Quests/Orbs, Nitro plans, payments, shop, role/server subscriptions, Family Center, Social SDK/Lobbies. Nitro-style perks are free for everyone.

Status: **done** (exists and wired end to end), **partial** (exists but a visible part is missing), **missing** (no code). Evidence is a path under `apps/` or `packages/` unless stated. "Server" = `apps/server/src`, "Web" = `apps/web/src`.

Headline: the platform is far ahead of what the older docs suggest. Most remaining gaps are small, user-visible polish items (voice channel status, TTS, translation, ignore, username change) plus a few developer-platform items (application emoji, user-installable apps, embedded-app SDK).

## 1. Accounts and profile

| Feature | Status | Evidence / notes |
|---|---|---|
| Register, login, logout, refresh tokens | done | `apps/server/src/routes/auth.ts` (`/auth/register`, `/login`, `/refresh`, `/logout`) |
| Email verification, password reset | done | `/auth/verify-email*`, `/auth/password/forgot|reset`; `test/password-reset.test.ts` |
| QR login / linked devices (scan from a logged-in device) | done | `routes/remoteauth.ts`, migration 037, `ScanQrDialog.tsx`, `lib/qrLogin.ts`; `test/remote-auth.test.ts` |
| Passkeys (WebAuthn login and as MFA) | done | `routes/passkeys.ts`, migration 049, `PasskeysPanel.tsx`; `test/passkeys.test.ts` |
| TOTP MFA + recovery codes | done | `/auth/mfa/setup|enable|disable`, `recoveryCodes` in `lib/api.ts`, `UserSettings.tsx`; `test/reset-2fa-verify.test.ts` |
| SMS / phone number verification | missing | no phone column or route (intentional-ish: needs an SMS provider) |
| Session list and revoke (one / all others) | done | `POST /auth/sessions`, `GET /auth/sessions`, `UserSettings.tsx` Security tab |
| Data export (GDPR package) | done | `routes/dataexport.ts`, `services/dataExport.ts`, migration 051, `DataPrivacyPanel.tsx`; `test/data-export.test.ts` |
| Account deletion with grace period | done | `services/accountDeletion.ts`, migration 055, `DELETE /users/@me`, `/users/@me/deletion` |
| Temporary account disable (deactivate) | missing | only admin disable (`routes/admin.ts`); no self-service |
| Change username (pomelo-style unique handle) | **missing** | `patchMe` in `routes/users.ts` has no `username`; the handle is fixed at register |
| Change email / password | partial | password: `POST /auth/password` done; email change route missing (`patchMe` has no `email`) |
| Display name, pronouns, bio, accent colour | done | `patchMe` (`displayName`, `pronouns`, `bio`, `accentColor`) |
| Avatar, banner (upload and from-URL), animated GIF avatars | done | `POST /users/@me/avatar/from-url`, `banner/from-url`, `lib/profileGif.ts`; `test/profile-image-from-url.test.ts` |
| Per-server profile (nick, avatar, banner, bio, pronouns) | done | migration 033, `Member` fields, `ServerProfiles.tsx`; `test/member-profiles.test.ts` |
| Avatar decorations, profile effects, nameplates | done | `services/cosmetics.ts`, migration 017, `cosmetics.css`, `CosmeticsPicker.tsx`; `test/parity-cosmetics.test.ts` (8 / 10 / catalog, original art) |
| Display-name styles (font and effect on names) | missing | nameplates only; no font/effect choice for the display name itself |
| Server tag (clan tag) | done | `Guild.tag`, `serverTagGuildId`, `services/cosmetics.ts`; shown in member list and messages |
| Profile themes (two colours) | done | `themeColors`, `lib/profileTheme.ts` |
| App themes (dark/light/AMOLED) + density + font scale + saturation | done | `stores/ui.ts` (`theme`, `density`, `fontScale`, `saturation`, `highContrast`) |
| Custom status with expiry | done | `customStatus.expiresAt`, sweeper clears it |
| Presence (online/idle/dnd/invisible) + auto-idle | done | `PUT /users/@me/presence`, `lib/idle.ts`, desktop `idle_seconds` |
| Activity status / rich presence, "Now playing", hide activity | done | `routes/activities.ts`, migration 016, `ActivityLine.tsx`, `privacy.showActivity`; `test/parity-activities.test.ts` |
| Connections (self-declared, verify by code, Twitch/YouTube OAuth) | done | `routes/connections.ts`, migrations 023/070, `ConnectionsTab.tsx` |
| Linked roles from connections | done | `routes/linkedroles.ts`, `LinkedRolesTab.tsx` |
| User badges / public flags | done | migration 066, `ui/UserBadges.tsx`, `test/user-flags.test.ts` |
| Multi-account switching | done | `lib/accounts.ts`, `AccountsSection.tsx` |
| Private user notes, mutual servers and friends on profile | done | `PUT /users/@me/notes/:userId`, `GET /users/:id`, `Profile.tsx` |

## 2. Friends, blocks, requests

| Feature | Status | Evidence / notes |
|---|---|---|
| Friend requests (send, accept, decline, cancel), add by username | done | `PUT/DELETE /users/@me/relationships/:userId`, `GET /users?name=`; `test/social.test.ts` |
| Who can add me (everyone / friends of friends / server members) | done | `Privacy.friendRequests`, `services/privacy.ts` |
| Block | done | relationship type `blocked`, enforced in DMs/calls/mentions (`services/memberDms.ts`, `calls.ts`) |
| Ignore a user (hide their messages in servers without blocking) | **missing** | `Relationship.type` is friend/blocked/incoming/outgoing; only `dm_ignores` (message-request ignore) exists |
| Friend nicknames | missing | no field |
| Message requests (accept/ignore, spam-style inbox) | done | `POST /channels/:id/accept-request|ignore-request`, `DmSidebar.tsx`, `DM_REQUEST` event |
| Mass-DM / impersonation guards | done | migrations 082/083, `services/massdm.ts`, `impersonation.ts` |
| Active Now / friends activity panel | done | `home/ActiveNow.tsx` |

## 3. DMs and group DMs

| Feature | Status | Evidence / notes |
|---|---|---|
| 1:1 and group DMs (add/remove, name, icon) | done | `POST /users/@me/channels`, `PUT/DELETE /channels/:id/recipients`, migration 065; `test/group-dm-manage.test.ts` |
| Voice and video calls in DMs and group DMs, ringing, decline | done | `services/calls.ts`, `POST /channels/:id/call/decline`, `voice/DmCall.tsx`, `IncomingCall.tsx`; `test/call-ring.test.ts`, `e2e/tests/callring.spec.ts` |
| Pins in DMs | done | generic `GET/PUT/DELETE /channels/:id/pins`; `PIN_MESSAGES` bit |
| Search in DMs / all DMs | done | `GET /channels/:id/messages/search`, `GET /users/@me/messages/search` |
| Secret (end-to-end encrypted) DMs | done (extra) | `routes/e2ee.ts`, `docs/E2EE_DMS.md`, `SecretChat.tsx` |
| Ephemeral / disappearing DMs (auto-delete timer) | **missing** | no TTL on channels or messages (`services/e2ee.ts` has none) |
| Per-server DM opt-in ("allow DMs from this server") | done | `PUT /guilds/:id/members/@me/dms`, migration 080 |
| Group DM call from the member list, screen share in DM call | done | `DmCall.tsx` uses the same LiveKit controls |

## 4. Servers and community

| Feature | Status | Evidence / notes |
|---|---|---|
| Create server, templates (built-in and user-created), template page | done | `POST /guilds`, `routes/guildextras.ts`, `pages/TemplatePage.tsx` |
| Server import / export (structure) | done (extra) | `routes/guildport.ts`, `ServerPortTab.tsx` |
| Discovery (list, join) | done | `GET /discover/guilds`, `home/DiscoveryPage.tsx` |
| Community mode, rules screening, welcome screen | done | features `COMMUNITY`/`MEMBER_SCREENING`, `GET /guilds/:id/screening`, `welcome-screen`, `WelcomeScreenTab.tsx` |
| Onboarding (questions, default channels, role assignment, browse channels) | done | `routes/onboarding.ts`, migration 019, `OnboardingTab.tsx`; `test/parity-onboarding.test.ts` |
| Announcement channels: follow and crosspost | done | `routes/follows.ts`, `POST .../messages/:mid/crosspost`, migration 020 |
| Forum channels (tags, require tag, sort, layout, default reaction, guidelines) | done | `ForumView.tsx`, migration 034, `POST /channels/:id/forum/posts`; `test/parity-forum-defaults.test.ts` |
| Media channels | done | `type 'media'`, media-only guard in `routes/channels.ts:425`, gallery layout |
| Stage channels (instance, topic, speakers, raise hand queue, block) | done | `routes/voice.ts`, `services/stage.ts`, migration 058, `StageQueue.tsx`; `test/stage-queue.test.ts` |
| Scheduled events (voice/stage/external, RSVP, recurrence) | done | `routes/events.ts`, migration 036, `PlatformModals.tsx` |
| Threads: public, private, invitable, archive/lock, auto-archive durations, list sync | done | `services/threads.ts`, migration 063, `sweeper.ts`; `test/private-threads.test.ts` |
| Thread slowmode (rate limit per thread, default thread slowmode on forums) | missing | channel `slowmode` exists; no thread-specific or forum default value |
| Server boosts as free perks (levels 1-3, emoji/sticker slots, booster role, announcements) | done | `services/boosts.ts`, migration 025, `BoostTab.tsx` |
| Vanity URL | done | `PATCH /guilds/:id/vanity-url`, `VanityUrl` UI |
| Audit log (numeric action types, filters) | done | `GET /guilds/:id/audit-logs`, `AuditActionType` in `shared/platform.ts`; `test/audit-coverage.test.ts` |
| AutoMod (keyword, presets, regex, spam, mention spam, links, invites, caps, repeated chars; block/timeout/alert/warn; test mode) | done | `services/automod.ts`, migrations 014/024, `AutoModTab.tsx`; `test/parity-automod.test.ts` |
| AutoMod: member-profile (username/nickname) rule | missing | triggers list has no profile trigger |
| Raid protection, verification levels, explicit-media filter, default notification level | done | `services/safety.ts`, migration 018, `SafetyTab.tsx`; media filter blurs, no classifier (partial detection) |
| Safety alerts (raid / DM-spam alerts posted to a mod channel with action buttons) | **missing** | no alert emitter besides AutoMod alert action; grep for raid alert posting finds none |
| Server widget, insights | done | `GET /guilds/:id/widget(.json|.svg)`, `/insights`, `ServerExtrasTabs.tsx` |
| Server guide / welcome sticker "Wave to say hi" on join | missing | join message exists (`type 'join'`), no wave reply sticker |
| Server folders, mark server read, mute server | done | `lib/menus.ts`, `railLayout.ts` |
| Ban appeals | done (extra) | `routes/appeals.ts`, migration 050, `AppealsTab.tsx` |
| Ownership transfer, leave, delete | done | `POST /guilds/:id/transfer-ownership`, `DELETE /users/@me/guilds/:id` |
| Role subscriptions / server shop | n/a | out of scope |

## 5. Roles and permissions

| Feature | Status | Evidence / notes |
|---|---|---|
| Roles: colour, hoist, mentionable, reorder, member assign | done | `routes/guilds.ts` roles, `RolesEditor.tsx` |
| Gradient role colours | done | migration 053, `colorSecondary` |
| Role icons | done | `Role.icon`, `IconPicker` in `RolesEditor.tsx:76`, `RoleIcon` in `MessageItem.tsx` |
| Linked roles | done | see section 1 |
| Role mentions, `@everyone`, `@here`, allowed_mentions | done | `mentionRoles`, migration 028; `test/parity-messages-mentions.test.ts` |
| Channel overwrites (role and member), category inheritance at create | done | `PUT /channels/:id/permissions/:overwriteId`, `PermGrid.tsx` |
| Permission sync with category (button / sync state indicator) | missing | grep `sync` finds nothing in `ChannelSettings.tsx` or server |
| Permission bits | partial | 47 bits in `packages/shared/src/permissions.ts` (view, send, manage, threads, events, soundboard, polls, external apps/stickers, voice messages, pin, bypass slowmode, record voice). **Missing**: `SET_VOICE_CHANNEL_STATUS`, `USE_EXTERNAL_SOUNDS`, `CREATE_GUILD_EXPRESSIONS` (split from `MANAGE_EMOJIS`), `VIEW_GUILD_INSIGHTS` (insights ride on `MANAGE_GUILD`), `USE_EMBEDDED_ACTIVITIES` (activities use CONNECT) |
| Administrator bypass, owner, role hierarchy checks | done | `services/perms.ts`, `permcache.ts`; `test/permissions.test.ts`, `sec7-overwrite-delete.test.ts` |
| Emoji restricted by role | done | migration 064 |
| Command permissions per role/channel | done | `PUT /applications/:app/guilds/:gid/commands/:cid/permissions`, `CommandPermissions.tsx` |

## 6. Channels

| Feature | Status | Evidence / notes |
|---|---|---|
| Text, voice, announcement, stage, forum, media, category | done | `GUILD_TYPES` in `routes/channels.ts:22` |
| Channel topic, NSFW + age gate, slowmode (server-enforced) | done | `services/agegate.ts`, `services/posting.ts:25` |
| Slowmode countdown in the composer | missing | `slowmode` appears in web only in `ChannelSettings.tsx` |
| Voice channel text chat | done | `chat/VoiceChat.tsx` |
| Voice channel status (the short text under a voice channel name) | **missing** | no route, column or UI (only the voice client's connection `VoiceStatus` type) |
| Soundboard (upload, play, mute, limits, perms) | done | `routes/soundboard.ts`, migration 015, `Soundboard.tsx`; `test/parity-soundboard.test.ts` |
| Voice effects (emoji reactions floating in the call, "voice effects") | missing | `VOICE_CHANNEL_EFFECT_SEND` carries soundboard sounds only (`shared/protocol.ts:110`) |
| Activities / embedded apps | partial | built-in Watch Together and Tic-Tac-Toe (`routes/activities.ts`, migration 042, `voice/WatchTogether.tsx`, `TicTacToe.tsx`). No third-party embedded-app SDK / app launcher for iframes |
| Hide muted channels, channel reorder, collapse categories | done | `lib/channelHide.ts`, `channelOrder.ts` |
| Clips channel (extra) | done | `routes/clips.ts`, `ClipRecorder.tsx` |

## 7. Messaging

| Feature | Status | Evidence / notes |
|---|---|---|
| Markdown: bold, italic, underline, strike, code, code blocks with language, quotes (`>`, `>>>`), spoilers, masked links, headings (1-3), lists (flat, ordered) | done | `lib/markdown.ts`, `markdown.test.ts` |
| Subtext (`-# small text`) | **missing** | not parsed in `markdown.ts` |
| Nested lists / indented sub-items | missing | list parser is flat |
| Timestamps `<t:...:R>` | done | `markdown.ts:115` |
| Mentions (user, role, channel, everyone/here) with autocomplete | done | `Composer.tsx` suggest, `Markdown.tsx` |
| Replies with ping toggle | done | `Composer.tsx` (`pingReply`) |
| Forward messages (snapshot) | done | `forward` in `routes/messages.ts`, migration 011 |
| Reactions, custom emoji, animated emoji, role-locked emoji | done | `Reactions.tsx`, `EmojiPicker.tsx` |
| Super (burst) reactions | done | migration 035, `test/burst-reactions.test.ts` |
| Polls (multi-select, duration, end early, voters) | done | `routes/polls.ts`, `PollVotersModal` |
| Stickers: guild, standard packs, external | done | `shared/stickers.ts`, `GET /stickers/standard`; Lottie format declared in type but rendering unverified (partial for Lottie) |
| GIF picker (search, trending, favorites) | done | `GET /gifs/search|trending`, `routes/favorites.ts`, `GifPickerModal` |
| Attachments, drag and drop, paste, spoiler flag, previews | done | `POST /uploads`, `ChatView.tsx` onDrop, `Attachments.tsx` |
| Attachment alt text / description | missing | no field (`Attachment` type has none) |
| Voice messages (record, waveform) | done | `lib/voiceRecord.ts`, `voiceMsg.ts`; `test/parity-voice-messages.test.ts` |
| Edit, delete, bulk delete, edit history | done | `GET .../messages/:mid/edits`, migration 031 |
| Pins | done | `PIN_MESSAGES`, system message `pin` |
| Saved for later (bookmarks) | done | `PUT /users/@me/saved/...`, Inbox > Saved |
| Reminders | done | `services/reminders.ts`, Inbox > Reminders |
| Scheduled messages (with attachments) | done | migrations 060/076, `ScheduleModal.tsx` |
| `@silent` (suppress notifications) and suppress embeds | partial | server accepts both flags (`routes/messages.ts:128`, `push.ts:277`, `push.test.ts`). **No web UI**: Composer never sets `flags`, message menu has no "Remove embeds" |
| Components V2, buttons, selects, modals, embeds (bots) | done | `lib/components.ts`, `ComponentsV2.tsx`; `test/components-v2.test.ts` |
| Link previews / unfurl (SSRF-safe) | done | `services/unfurl.ts`, `lib/ssrf.ts` |
| Link and phishing warnings, risky-file warning | done (extra) | `shared/trust.ts`, `LinkGuard.tsx` |
| Message translation | **missing** | none |
| Text-to-speech `/tts` | **missing** | `SEND_TTS` bit exists (`shared/permissions.ts:10`) but nothing sends or plays TTS |
| Drafts (per channel, kept across channel switches) | partial | in-memory `drafts` in `stores/ui.ts:118`; not persisted across reload or synced between devices |
| Typing indicators, read states, mark unread | done | `TypingIndicator.tsx`, `POST /channels/:id/ack`, `lib/menus.ts` |
| Spoiler/NSFW image blur, media filter | done | `services/safety.ts`, spoiler flag |
| Slash commands: `/me`, `/shrug`, `/spoiler`, `/tableflip` client commands | partial | `SlashCommands.tsx` handles app commands; built-in text commands not verified one by one |

## 8. Search

| Feature | Status | Evidence / notes |
|---|---|---|
| Server search with `from:` `mentions:` `has:` (incl. video) `before:` `after:` `during:` `pinned:` `sort:` | done | `lib/searchTokens.ts:46`, `services/search.ts`; `test/search-filters.test.ts` |
| `in:#channel` token | partial | no `in:` token parsed; scope is chosen by where you search (channel vs server vs DMs) |
| `author_type:` (bot/user), `link:`/`embed:` extras | partial | `author_type` absent (`link`/`embed` are covered through `has:`) |
| Quick switcher (Ctrl+K) | done | `layout/QuickSwitcher.tsx`, default keybind `Ctrl+K` |
| Member search | done | `GET /guilds/:id/members/search` |

## 9. Notifications

| Feature | Status | Evidence / notes |
|---|---|---|
| Per-server / per-channel settings, mute with duration, suppress @everyone and roles, level | done | `routes/push.ts`, `NotificationSettings` type (`mutedUntil`, `suppressEveryone`, `suppressRoles`, `level`) |
| Per-thread follow / mute | partial | thread members exist (`thread-members`); no per-thread notification setting |
| Web push (VAPID), mobile push (Capacitor), push devices | done | `routes/push.ts`, `lib/push.ts`, `@capacitor/push-notifications` |
| Notification digest (batch pings) | done (extra) | migration 086, `routes/digest.ts` |
| Inbox: mentions, saved, reminders, scheduled, digest | done | `SocialModals.tsx:19` |
| Inbox: "Unreads" and "For You / Threads" tabs | missing | tab list has only mentions/digest/saved/reminders/scheduled |
| Native desktop notifications, badge counts | done | `lib/native.ts`, `UserSettingsExtra.tsx` |

## 10. Voice and video

| Feature | Status | Evidence / notes |
|---|---|---|
| Voice channels over LiveKit, reconnect, join/leave sounds | done | `packages/voice`, `routes/voice-livekit.ts`; `test/voice-livekit.test.ts` |
| Go Live screen share with presets up to 1440p60 / 4K60 / source, viewer limit, kick viewers | done | `packages/voice/src/presets.ts:5`, `shared/limits.ts:24`, `routes/voice.ts`; `test/golive-viewers.test.ts` |
| Screen-share audio (soundshare) | done on web | `startScreenShare({audio})`; native per-app capture out of scope |
| Noise suppression (RNNoise), echo cancel, auto gain | done | `voice/noiseSetup.ts`, `VoiceSettings.tsx` |
| Push to talk, global PTT (desktop) | done | `packages/voice/src/ptt.ts`, `lib/globalPtt.ts`, `ptt_register` in `lib.rs` |
| Per-user volume, per-user mute | done | `voice/userAudio.ts`, `userVolumeMenu.test.tsx` |
| Priority speaker, server mute/deafen, move members | done | `PRIORITY_SPEAKER`, `POST /guilds/:id/voice-states/:userId/move` |
| Camera, camera quality presets | done | `voice/cameraQuality.test.ts` |
| Camera effects: blur and exposure on the **local preview only**; no background replacement or segmentation | partial | `voice/cameraEffects.ts` header says a real cut-out is "not shipped" |
| Stage hand raise queue, speaker approval | done | see section 4 |
| Live captions | done (extra) | `voice/Captions.tsx`, `stores/captions.ts` |
| Voice recording | done (extra) | `services/recordings.ts`, migration 039 |
| Soundshare / Watch Together | done | see section 6 |
| Spatial / stereo audio settings | done | `VoiceSettings.tsx` |
| Mobile screen share (Android) | done | `ScreenShareService.java`, `docs/MOBILE_SCREENSHARE.md` |
| Mobile call integration (Android foreground service) | done | `CallServicePlugin.java`; iOS CallKit/PushKit not found in `apps/mobile/ios` (partial on iOS) |

## 11. Developer platform

| Feature | Status | Evidence / notes |
|---|---|---|
| Applications, bot tokens, reset token/secret | done | `routes/applications.ts`; `test/bots-flow.test.ts` |
| Slash commands (global/guild), subcommands, options, choices, autocomplete | done | `routes/commands.ts`, `CommandOptionType` (types 1-11), `INTERACTION_AUTOCOMPLETE_RESULT` |
| User and message context-menu commands | done | `CommandType` USER/MESSAGE (`shared/platform.ts:75`); `lib/menus.ts` |
| Components (buttons, selects), modals, deferred and follow-up responses, ephemeral | done | `routes/interactions.ts`, `services/interactions.ts`; `test/platform.test.ts` |
| Signed HTTP interactions endpoint | done | `lib/interactionSig.ts`, `interactions_endpoint` in `services/apps.ts` |
| Webhooks (execute, thread_id, edit/delete messages) | done | `routes/channels.ts:615`, `routes/integrations.ts`; `test/parity-webhooks.test.ts` |
| OAuth2 (authorize, token, revoke, PKCE, scopes incl. bot, applications.commands) | done | `routes/applications.ts`, migration 007, `OAuthAuthorize.tsx` |
| Gateway: identify, resume, intents (privileged opt-in), request members | done | `gateway/ws.ts`, `gateway/intents.ts`; migration 008 |
| Rate-limit headers (`X-RateLimit-*`, `Retry-After`) | done | `app.ts`, `lib/ratelimit.ts`; `test/ratelimit.test.ts` |
| Bot SDK (TypeScript) with Components V2 builders and `setActivity` | done | `packages/bot-sdk` |
| App directory / listing | done | `routes/directory.ts`, `AppDirectory.tsx` |
| Application emoji (emoji owned by the app, usable anywhere) | **missing** | no table or route |
| User-installable apps / integration types and contexts on commands | **missing** | no `integration_types`/`contexts` anywhere in `services/commands.ts` or shared types |
| Embedded App SDK (third-party iframe activities) | missing | see section 6 |
| REST path compatibility (`/api/v10`) | partial | only `/api/v1` prefix (`app.ts:172`); error codes follow Discord numbering (`shared/platform.ts`) |
| Audit-log reason header on moderation endpoints | partial | `reason` accepted in bodies; header not verified |
| Developer portal UI | done | `pages/DeveloperPortal.tsx` |

## 12. Client (web, desktop, mobile)

| Feature | Status | Evidence / notes |
|---|---|---|
| Keyboard shortcuts, rebinding, shortcuts modal | done | `stores/ui.ts:55`, `Keybinds` tab |
| Drag and drop upload, paste upload, emoji picker, GIF picker | done | `ChatView.tsx`, `Composer.tsx` |
| Accessibility: reduced motion, high contrast, font scale, saturation, compact mode, aria-live, axe test | done | `stores/ui.ts:10`, `e2e/tests/a11y.spec.ts` |
| Dyslexia-friendly font option, colour-blind modes, role-colour contrast option | missing | no hits |
| Languages | partial | English plus ar, de, es, fr, tr (`web/src/i18n`); Discord ships 30+ |
| Streamer mode | done | `lib/streamer.ts`, `StreamerTab` |
| In-game overlay | done | `overlay/*`, `overlay_apply` in `lib.rs` (needs runtime verification on Windows/macOS) |
| Game detection and rich presence | done | `list_running_games`, `detectable_games.json`, `RegisteredGamesTab.tsx` |
| Desktop: tray, autostart, auto-update, deep links, single instance, keychain, idle presence, global PTT | done | `apps/desktop/src-tauri/src/lib.rs`, `Cargo.toml` plugins |
| Mobile apps (Capacitor Android/iOS) | partial | project generated; Android builds, iOS needs a Mac (`docs/PLATFORMS.md`) |
| Link handling, external link confirmation | done | `lib/links.ts` |
| Spellcheck | partial | native browser spellcheck only |

## 13. Moderation and safety

| Feature | Status | Evidence / notes |
|---|---|---|
| Timeouts (with duration, history) | done | `timeoutUntil`, `MODERATE_MEMBERS` |
| Ban (with message deletion window), unban, kick | done | `PUT /guilds/:id/bans/:userId`, `GET /guilds/:id/bans` |
| Bulk ban, prune (dry run), warnings, mod notes, mod log CSV | done | `routes/modtools.ts`, `ModView.tsx` |
| Mod view (member safety flags) | done | `GET /guilds/:id/members/:userId/mod-view` |
| Report message flow + server reports queue | done | `POST .../messages/:mid/report`, `GET /guilds/:id/reports`, `PATCH /guilds/:id/reports/:rid`, migration 029 |
| Instance admin dashboard | done (extra) | `routes/admin.ts`, migrations 030/032/090 |
| Member verification levels | done | see section 4 |
| Safety alerts | missing | see section 4 |
| Timeout/ban from message context menu | done | `lib/menus.ts` |

## 14. Privacy

| Feature | Status | Evidence / notes |
|---|---|---|
| DM permissions (server members, message requests) | done | `Privacy` type, `PrivacyTab.tsx` |
| Friend request controls | done | same |
| Explicit-media filter (per server) | partial | blur-based, no classifier (`services/safety.ts`) |
| Age confirmation / age-restricted channels | done | `POST /users/@me/age-confirm` |
| Data export and delete | done | section 1 |
| Activity privacy | done | `showActivity` |
| Per-server DM privacy | done | migration 080 |

## 15. Ranked missing and partial items (impact vs effort)

Impact: how often users notice. Effort: S <= 2 days, M ~ 1 week, L multi-week.

| Rank | Item | Status | Impact | Effort | WP |
|---|---|---|---|---|---|
| 1 | `@silent` and "remove embeds" UI (server done) | partial | high | S | A |
| 2 | Voice channel status | missing | high | S-M | B |
| 3 | Username change (+ email change) | missing | high | M | C |
| 4 | Ignore user | missing | high | S-M | C |
| 5 | Subtext `-#` and nested lists | missing | medium | S | A |
| 6 | Slowmode countdown in the composer | partial | medium | S | A |
| 7 | Text-to-speech `/tts` | missing | medium | S-M | A |
| 8 | Message translation | missing | medium | M | A |
| 9 | Missing permission bits (`SET_VOICE_CHANNEL_STATUS`, `USE_EXTERNAL_SOUNDS`, `CREATE_GUILD_EXPRESSIONS`, `VIEW_GUILD_INSIGHTS`, `USE_EMBEDDED_ACTIVITIES`) | partial | medium | S-M | B |
| 10 | Permission sync with category | missing | medium | S | B |
| 11 | Safety alerts (raid / DM spam to mod channel) | missing | medium | M | C |
| 12 | Inbox Unreads and Threads tabs; per-thread notifications | missing | medium | M | C |
| 13 | Ephemeral / disappearing DMs | missing | medium | M | C |
| 14 | Application emoji | missing | medium (ecosystem) | M | D |
| 15 | User-installable apps (integration types / contexts) | missing | medium (ecosystem) | M-L | D |
| 16 | More languages (target 15+) | partial | medium | M (mostly translation work) | D |
| 17 | Camera background replacement (segmentation) | partial | medium | M-L | B |
| 18 | Voice effects (emoji bursts in calls) | missing | low-medium | M | B |
| 19 | Attachment alt text | missing | low-medium | S | A |
| 20 | Persisted drafts | partial | low-medium | S | A |
| 21 | Thread slowmode and forum default thread slowmode | missing | low | S | B |
| 22 | AutoMod member-profile rule | missing | low | S-M | C |
| 23 | Display-name styles | missing | low | M | C |
| 24 | `in:` search token, `author_type:` | partial | low | S | A |
| 25 | `/api/v10` alias + audit reason header | partial | low (bot compat) | S | D |
| 26 | Embedded App SDK (iframe activities) | missing | low-medium | L | D |
| 27 | Accessibility: dyslexia font, colour-blind modes | missing | low | S | D |
| 28 | iOS CallKit / PushKit | partial | medium on iOS | L (needs Mac) | D |
| 29 | Friend nicknames, temporary account disable, wave sticker | missing | low | S each | C |
| 30 | SMS / phone verification | missing | low (needs provider) | M | C (skip unless asked) |
| 31 | Explicit-media classifier | partial | low | L | skip |

## 16. Four work packages (mostly disjoint files)

Shared rules for all four: no package edits another package's files; the few shared hotspots (`packages/shared/src/types.ts`, `protocol.ts`, `permissions.ts`, `apps/server/src/app.ts`, `apps/web/src/lib/api.ts`) get additive edits only and new code goes in new files where possible (for example `packages/shared/src/parity3a.ts`, re-exported by one line in `index.ts`). Migration numbers are reserved per package: A 100-109, B 110-119, C 120-129, D 130-139. Each item ships with a vitest test next to the existing ones (`apps/server/test/parity3-*.test.ts` or `*.test.tsx`). Do not add Discord assets or copy Discord text; keep all art original.

### WP-A: Messaging and composer

Files owned: `apps/web/src/components/chat/Composer.tsx`, `MessageItem.tsx`, `Markdown.tsx`, `apps/web/src/lib/markdown.ts`, `searchTokens.ts`, `apps/web/src/stores/ui.ts` (drafts only), `apps/server/src/routes/messages.ts`, `services/messages.ts`, `services/search.ts`, `lib/menus.ts` (message items only).

1. `@silent` and suppress embeds: in the composer add a "Send silently" toggle (also parse a leading `@silent ` token, strip it, send `flags |= 1<<12`) and in the message menu add "Remove embeds" / "Restore embeds" that PATCHes `flags` (allow `SUPPRESS_EMBEDS` on `PATCH /channels/:id/messages/:mid` for the author or MANAGE_MESSAGES; update `UpdateMessage` zod and the `MESSAGE_UPDATE` payload). Test: extend `push.test.ts` pattern; edit flag test.
2. Markdown: `-# ` subtext line (new `subtext` node, render small and muted), nested lists (two-space indent, one extra level). Update `markdown.test.ts`.
3. Slowmode countdown: from the 429/`slowmode` error or the last own message timestamp, disable the send button and show a countdown in the composer; skip for `BYPASS_SLOWMODE`/MANAGE roles.
4. `/tts`: in the composer a `/tts text` built-in sends with a new message flag `TTS = 1<<4` (gated by `SEND_TTS`, add to the flag whitelist at `routes/messages.ts:129`); clients play it with `speechSynthesis` when the setting "Allow TTS" is on and the user is not in a call. Add a setting in Notifications tab.
5. Translation: message menu "Translate" calls a new `POST /channels/:id/messages/:mid/translate {to}` which uses an operator-configured provider (env `TRANSLATE_URL`, LibreTranslate-compatible; 501 `NOT_CONFIGURED` otherwise) with SSRF-safe fetch (`lib/safepost.ts`), caches per (message, lang) for 24h; web falls back to the browser Translator API when present.
6. Attachment alt text: `description` on attachment upload metadata (migration 100: `attachments.description text`), shown as `alt`, editable in the upload preview.
7. Persist drafts: mirror `drafts` to `localStorage` per channel (debounced, try/catch), restore on load, clear on send.
8. Search: parse `in:#name` / `in:<id>` and `author_type:bot|user`; map to the existing `channelId`/`authorId` params and add `author_type` to `services/search.ts`.

### WP-B: Voice, channels and permissions

Files owned: `packages/shared/src/permissions.ts`, `apps/web/src/lib/perms.ts`, `apps/server/src/services/perms.ts`, `permcache.ts`, `services/voice.ts`, `routes/voice.ts`, `routes/channels.ts`, `apps/web/src/components/settings/ChannelSettings.tsx`, `PermGrid.tsx`, `apps/web/src/voice/*`, `components/layout/ChannelSidebar.tsx`, `VoiceChannelView.tsx`.

1. Voice channel status: migration 110 `channels.voice_status text`; `PUT /channels/:id/voice-status {status}` (<= 500 chars, needs `SET_VOICE_CHANNEL_STATUS` and being connected to the channel; cleared when the channel empties, in the same sweep as voice state cleanup); gateway event `CHANNEL_VOICE_STATUS_UPDATE` (add to `protocol.ts` and `intents.ts` under GUILDS); show under the channel name in `ChannelSidebar.tsx` and in the voice header; audit log entry.
2. New permission bits appended after bit 46: `SET_VOICE_CHANNEL_STATUS` 47, `USE_EXTERNAL_SOUNDS` 48, `CREATE_GUILD_EXPRESSIONS` 49, `VIEW_GUILD_INSIGHTS` 50, `USE_EMBEDDED_ACTIVITIES` 51. Update `DISCORD_PERMISSION_BITS` map, `perms.ts` UI descriptions, a migration (110) that grants the new bits to roles holding the nearest existing bit (MANAGE_CHANNELS, MANAGE_EMOJIS, MANAGE_GUILD, CONNECT respectively) exactly like migration 052; enforce in `routes/soundboard.ts` (external sounds), emoji/sticker create routes (expressions: accept either `MANAGE_EMOJIS` or `CREATE_GUILD_EXPRESSIONS` for create-own), `GET /guilds/:id/insights`, `routes/activities.ts`.
3. Permission sync with category: `POST /channels/:id/permissions/sync` copies the parent category overwrites (audit-logged); in `ChannelSettings.tsx` show "Synced with category" state computed by comparing overwrites, and a "Sync now" button; moving a channel into a category offers sync.
4. Thread slowmode: `channels.slowmode` already exists; allow PATCH on threads, add forum `defaultThreadSlowmode` (migration 111) applied to new posts; enforce in `services/posting.ts` using the thread value.
5. Voice effects: extend `VOICE_CHANNEL_EFFECT_SEND` with an optional `emoji` payload (`{emoji}` instead of `sound`), `POST /channels/:id/voice-effect {emoji}` rate limited to 1 per 3s, floating emoji animation in `voice/tiles.tsx`; needs `USE_SOUNDBOARD` or `ADD_REACTIONS`.
6. Camera background: add optional `@mediapipe/tasks-vision` selfie segmentation (self-hosted wasm, same CSP rules as RNNoise) in `voice/cameraEffects.ts` to replace/blur background of the **published** track, not only the preview; keep it opt-in and off when the tab is hidden.

### WP-C: Accounts, social, safety

Files owned: `apps/server/src/routes/users.ts`, `routes/auth.ts`, `routes/social.ts`, `services/privacy.ts`, `services/safety.ts`, `services/automod.ts`, `services/dms.ts`, `services/sweeper.ts` (new sweep jobs only), `apps/web/src/components/settings/UserSettings.tsx`, `PrivacyTab.tsx`, `SafetyTab.tsx`, `AutoModTab.tsx`, `modals/SocialModals.tsx`, `layout/DmSidebar.tsx`, `modals/Profile.tsx`.

1. Username change: `PATCH /users/@me {username}` (or `POST /users/@me/username` with current password), same validator as register, uniqueness with case-folding, 2 changes per 30 days (`username_changed_at`, migration 120), old handle reserved 14 days to stop impersonation; audit via `impersonation.ts`; UI in My Account. Email change: `POST /users/@me/email {newEmail, password}` sends a verify link to the new address (`services/mailer.ts`), applies on confirm, invalidates other sessions; UI beside it.
2. Ignore user: new relationship type `ignored` (migration 121 widens the check), `PUT /users/@me/relationships/:id {type:'ignored'}`; server still delivers but flags; web hides ignored authors' messages behind "Ignored message, click to show", no pings from them, no DM block; menu items in user context menu and Profile.
3. Safety alerts: in `services/safety.ts` emit a message to a configured alert channel (`guilds.safety_alerts_channel_id`, migration 122) on raid-join spikes and on mass-DM-spam detection (`services/massdm.ts` hook) with buttons (Lock invites, Kick new members, Dismiss) implemented as Components on a system-bot message (`services/sysbots`); settings in `SafetyTab.tsx`.
4. Inbox tabs and thread notifications: add "Unreads" (channels with unread, from `read_states`) and "Threads" (followed threads with new activity) tabs in `SocialModals.tsx`; per-thread notification setting (`notification_settings` scope `thread`, reuse `routes/push.ts` shape without editing it by adding the scope in `routes/social.ts`; coordinate: push.ts changes are a single enum widening).
5. Disappearing DMs: `channels.message_ttl_seconds` (migration 123; options off/1h/1d/1w) set via `PATCH /channels/:id` for DM/group DM (put the DM branch in `services/dms.ts`), messages get `expires_at` on insert and the sweeper deletes them (new sweep job), system message "X turned on disappearing messages", UI in DM header menu.
6. Small items: AutoMod `member_profile` trigger (username/nickname/bio keyword check on join and profile update), temporary self-disable (`POST /users/@me/disable`, reactivates on next login), friend nicknames (`relationships.nickname`), display-name style (font + effect ids from a shared catalog, like `cosmetics.ts`), join "Wave to say hi" action sending a sticker reply.

### WP-D: Developer platform and platform polish

Files owned: `apps/server/src/routes/applications.ts`, `routes/commands.ts`, `routes/interactions.ts`, `routes/directory.ts`, `routes/activities.ts` (embedded apps only), `services/apps.ts`, `services/commands.ts`, `services/interactions.ts`, `services/emojis.ts` (app emoji only), `apps/server/src/app.ts` (prefix registration), `packages/bot-sdk`, `apps/web/src/pages/DeveloperPortal.tsx`, `components/settings/BotsAppsTab.tsx`, `apps/web/src/i18n/*`, `apps/web/src/components/settings/UserSettings.tsx` Accessibility section only (A11y function; coordinate with WP-C by keeping edits inside `function A11y`), `apps/mobile/ios`.

1. Application emoji: migration 130 `application_emojis`, `GET/POST/PATCH/DELETE /applications/:id/emojis` (limit 2000 per app, bot token or owner), usable in message content by any bot-sent message via `<:name:id>` and in component emoji fields; render path in `Markdown.tsx` only needs a resolver call (one-line hook, WP-A owns that file, so expose the lookup through `GET /emojis/:id` and let the existing unknown-emoji fetch pick it up).
2. User-installable apps: `integration_types` (0 guild, 1 user) and `contexts` (0 guild, 1 bot DM, 2 private channel) on application commands (migration 131), `POST /oauth2/authorize` with scope `applications.commands` and `integration_type=1` creates a per-user install (`application_user_installs`), command listing merges user installs (`GET /users/@me/application-commands`), interactions from non-bot-member guilds are allowed when the user installed the app, reply as ephemeral/interaction-token messages only. Gate with `USE_EXTERNAL_APPS` (already exists).
3. Embedded App SDK (MVP): app registers `activity_url` (HTTPS, CSP allowlisted per app), `POST /channels/:id/activities {applicationId}` launches a sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`, no top nav) in the voice view; a `postMessage` bridge exposes `ready`, `getParticipants`, `getUser`, `subscribe(VOICE_STATE_UPDATE)`; uses the existing activity session table (042). Keep Watch Together / Tic-Tac-Toe as built-ins.
4. REST compat: register the same routes under `/api/v10` and `/api/v9` prefixes in `app.ts`, accept `X-Audit-Log-Reason` (URL-decoded) for all moderation/management routes via one onRequest hook that fills `req.auditReason`, and make the audit writer use it.
5. Languages: add at least 10 locale files (pt-BR, ru, ja, ko, zh-CN, it, pl, nl, uk, hi, id, vi) following `i18n/index.ts`, fall back to English per key, RTL already works (`ar`); add a CI check that every locale has no extra keys (`i18n.test.ts`).
6. Accessibility: OpenDyslexic-style option (bundle an OFL font locally, no CDN), colour-blind-safe status colours (shape plus colour for presence), and "role colours in dark/light contrast safe" toggle that clamps role colour contrast to 4.5:1.
7. iOS call integration: CallKit + PushKit VoIP push plugin in `apps/mobile/ios` mirroring `CallServicePlugin.java`; server side VoIP push token registration is an addition to `push-devices` (`kind: 'voip'`); verify only on a Mac, document in `docs/PLATFORMS.md`.
