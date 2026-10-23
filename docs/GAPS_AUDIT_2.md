# Gaps audit 2

Scope: the master-plan rows (`JORCORD_MASTER_PLAN.md` section 4) still marked partial/missing for search, threads, expressions, guild admin, profiles, social, presence and voice settings. The status column in the master plan is stale, so every row below was re-checked against routes, migrations, tests and web components. "This pass" = implemented together with this audit (server + web + tests + `CONTRACT.md`).

Status: **done** (exists and is tested), **partial**, **missing**.

| Row | Master plan | Verified status | Evidence |
|---|---|---|---|
| Search filters `from:` `has:` `mentions:` `in:` `before/after/during` `pinned` | partial | **done** | `services/search.ts` (`searchQuerySchema`, `buildSearchSql`, `during`, `pinned`, `mentions`), `routes/messages.ts` search routes (guild, channel, DMs), `test/search-filters.test.ts`; web `lib/searchTokens.ts` parses the tokens, `Panels.tsx` SearchPanel |
| Threads: private | partial | **missing -> done (this pass)** | `POST /channels/:id/threads {type:'private'}`, `thread_private` (migration 063), visibility enforced in `perms.ts` (`channelAccess`, `channelPermsLite`, `viewersAmong`), `guilds.ts` `visibleChannelRows`; `test/private-threads.test.ts`; web `NewThreadForm` in `Panels.tsx` |
| Threads: invitable | partial | **missing -> done (this pass)** | `thread_invitable`, invite rule in `PUT /channels/:id/thread-members/:userId` |
| `THREAD_LIST_SYNC` | partial | **missing -> done (this pass)** | sent after `READY` (`gateway/ws.ts`) and on gaining a parent channel (`services/visibility.ts`); web store handles it (`stores/threadSync.test.ts`) |
| Threads: archived listing | partial | **done** | `GET /channels/:id/threads/archived` paging, `test/gaps.test.ts` "threads" |
| Role-restricted emoji | partial | **missing -> done (this pass)** | `emojis.role_ids` (migration 064), `services/emojis.ts`, enforced for message content and reactions; `test/emoji-roles.test.ts`; web `EmojiRoles` in `GuildSettings.tsx`, picker hides unusable emoji (`lib/emojiRoles.ts`) |
| Guild stickers | partial | **done** | `routes/guilds.ts` CRUD, `StickersTab`, `STICKERS_UPDATE` |
| Standard sticker packs | partial | **missing -> done (this pass)** | `packages/shared/src/stickers.ts` (original SVG packs), `GET /stickers/standard[/:id.svg]`, `std_*` ids accepted in `stickerIds`; `test/standard-stickers.test.ts`, web picker + `MessageItem` render |
| GIF picker | partial | **done** | `GET /gifs/search|trending` (`routes/misc.ts`), favourites (migration 022), web `GifPickerModal`, `EmojiPicker` GIF tab, `ComposerGif.test.tsx` |
| User-created guild templates | partial | **done** | `routes/guildextras.ts` templates CRUD + `POST /guilds/templates/:code`, migration 021, `test/parity-guildextras.test.ts`, web `TemplateTab` |
| Onboarding prompts assigning roles/channels | missing | **done** | `routes/onboarding.ts`, migration 019, `test/parity-onboarding.test.ts` (roles granted/removed, channels recorded), web `OnboardingTab`, `OnboardingModals` |
| Prune and bulk ban | missing | **done** | `routes/modtools.ts` (`/moderation/bulk`, `/prune`, dry-run), `test/parity-modtools.test.ts`, web `ModToolsTab` |
| Widget (JSON + embed) | missing | **done** | `GET /guilds/:id/widget.json`, `widget.svg` badge, settings API, `test/parity-guildextras.test.ts`, web `WidgetTab` |
| Vanity URL set endpoint | partial | **done** | `PATCH /guilds/:id/vanity-url` (`routes/members.ts`), join by vanity, `test/parity-invites.test.ts`, web `VanityUrl` |
| Server insights | missing | **done** | `GET /guilds/:id/insights`, daily counters, `test/parity-guildextras.test.ts`, web `InsightsTab` |
| User flags / badges | missing | **missing -> done (this pass)** | `users.public_flags` (migration 066), `UserFlags` in shared, admin `PATCH /admin/users/:id/flags`, `test/user-flags.test.ts`, web `UserBadges` on profiles + admin dashboard |
| Per-guild profile (avatar, banner, bio) | partial | **done** | `members.avatar/banner/bio/pronouns` (migration 033), `PATCH /guilds/:id/members/@me`, `test/member-profiles.test.ts`, web `ServerProfiles.tsx` |
| Group DM owner transfer and icon | partial | **partial -> done (this pass)** | owner hand-off existed only when the owner left; now `PATCH /channels/:id {icon, ownerId}` (migration 065), `test/group-dm-manage.test.ts`, web `GroupDmModal` |
| Mutual friends/servers | partial | **done** | `GET /users/:id` returns `mutualGuilds` + `mutualFriends`; web `Profile.tsx` |
| User notes | partial | **done** | `GET/PUT /users/@me/notes/:userId` (`routes/social.ts`), migration 009, web `NoteBox` |
| Rich presence | missing | **done** (server) | `services/activities.ts`, `PUT /users/@me/presence`, `PRESENCE_UPDATE.activities`, web `ActivityLine`/`ActivityCards` |
| Activity feed ("friends are playing") | missing | **missing -> done (this pass)** | web `ActiveNow` panel on the Friends home (inline `ActivityLine` per friend existed already) |
| Push-to-talk global hotkey | partial | **partial -> done (this pass), runtime unverified** | Tauri `ptt_register` command + `jorcord://ptt` event (`apps/desktop/src-tauri/src/lib.rs`, `cargo check` passes), `@jorcord/voice` `globalSource`, web `lib/globalPtt.ts`, Voice settings toggle; unit tests only (no OS-level test possible here) |
| Auto-gain / echo-cancel / sensitivity settings | partial | **done** | `VoiceSettings.tsx` (echo cancellation, AGC, input sensitivity slider, noise engine), applied in `voice/controller.ts` |
| Soundshare (screen share with audio) | partial | **done on web; native per-app capture out of scope** | `startScreenShare({audio})` in `packages/voice/src/client.ts`, share-audio toggle in `voice/controls.tsx`, clip capture includes the screen-share audio track. WebView2/WebKit cannot capture a single app's audio; the browser/OS picker decides (tab or system audio) |

| Twitch/YouTube: verified connections | missing ("skipped on purpose") | **missing -> done (this pass), provider calls mocked in tests** | OAuth "Connect with Twitch/YouTube" when the operator sets client credentials (`services/connectionOAuth.ts`, migration 070, `test/integrations-streams.test.ts`, web `ConnectionsTab.tsx`); the code-in-page flow is unchanged without credentials. See `docs/INTEGRATIONS.md` |
| Twitch/YouTube: live and upload notifications | missing | **missing -> done (this pass), provider calls mocked in tests** | `/guilds/:id/stream-feeds`, `services/streamfeeds.ts` poller (Helix streams with an app token; YouTube public RSS, no key), migration 071, web `StreamFeedsPanel.tsx`. Subscriber roles stay out of scope |

Out of scope (as requested): native Android/iOS screen share.

## Notes

- Migrations used: 063 (private threads), 064 (emoji roles), 065 (group DM icon), 066 (user flags), 070 (connection OAuth), 071 (stream feeds). 067 is unused.
- Private threads do not use channel overwrites; visibility is membership based. They are excluded from `trackVisibility` (overwrite snapshots) on purpose.
- `std_*` sticker ids cannot collide with snowflakes (digits only). Image URLs are public and immutable like `/files`.
- Global push-to-talk captures the key system-wide, so other apps do not receive it; modifier-only keys and mouse buttons are not supported by OS hotkeys and fall back to the in-window listener.
