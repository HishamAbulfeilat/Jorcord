# Jorcord master plan and agent instructions

Single source of truth for taking Jorcord from its current state to full Discord-class feature coverage.
Written to be handed to a coding agent (Claude Code) working **inside this repo**. Read sections 0-2 first, then pick work from section 8.

Inputs used to write this:
- Local reverse engineering of the installed Discord desktop client 1.0.9261 (REA + Ghidra). Evidence in Appendix A.
- Discord's public developer documentation (`github.com/discord/discord-api-docs`), cited as `DD:<path>`.
- The method of `Jakeschincariol/replica-skill` (recon map -> architecture -> design -> build -> test -> diff). Used as a *method*, see section 0.3.
- The repo itself: `README.md`, `PLAN.md`, `docs/PARITY.md`, `docs/CONTRACT.md`, `docs/PLATFORMS.md`, `docs/WRAPPER_WEB_NEEDS.md`, and a route/migration inventory taken on 2026-10-10.

Status vocabulary: **done**, **partial**, **missing**. Size: S (<=2 days), M (~1 week), L (multi-week). Priority: P0 to P3.

---

## 0. How an agent should use this file

### 0.1 Order of work
1. Run `git status --short --branch` and confirm you are on a feature branch, not `main`.
2. Read `docs/CONTRACT.md` (API), `docs/PARITY.md` (gap analysis, already detailed) and this file.
3. Pick the next unchecked item in section 8 (phase order is deliberate). One item per branch/PR.
4. For each item follow the **per-item loop** in section 9. Do not start the next item until the previous one passes its acceptance tests.

### 0.2 Hard rules (clean room)
- **Never copy** Discord code, CSS, SVG, images, sounds, fonts, copy text, the Krisp models (`*.kef`), mediapipe models, or any DLL/EXE from the install. Implement behaviour from the public docs and from the *capability lists* in this file.
- **Never** implement: game-process DLL injection (`discord_hook`, overlay hooks), anti-tamper (`discord_aegis`), token/credential harvesting, or anything that talks to Discord's own servers. Jorcord is its own network.
- Product name, logo, wording, emoji packs and sounds are Jorcord's own. Do not use "Discord"/"Nitro" in UI strings. (PLAN.md section 0 already says this.)
- Everything is free for everyone (README, CONTRACT). No payment code. Where Discord gates a feature behind Nitro/boosts, Jorcord gives it to all, using `packages/shared/src/limits.ts`.
- The install contains only the desktop **shell**; the chat UI is remote and was never available. Do not claim chat-UI details came from the install.

### 0.3 Using the replica-skill pack (optional, method only)
The pack (`/plugin marketplace add Jakeschincariol/replica-skill`) gives a useful pipeline: `recon -> architect -> design -> build -> backend -> test -> diff`, with artifacts in `replica/` (`recon.md`, `features.csv`, `architecture.md`, screenshots).
- **Use**: `replica-test` and `replica-diff` (click every flow, score parity against reference screenshots), and its `features.csv` / definition-of-done habit.
- **Do not rely on**: `replica-recon` for this project. Its rules forbid decompiling the original, and the user explicitly asked for decompilation of their own installed copy; recon is already done (this file). `replica-brand/launch/deploy` are unnecessary (name and release flow exist).
- If you install it, keep its output in `replica/` and mirror the feature matrix in section 4 into `replica/features.csv`.

### 0.4 Using REA (reverse engineering) later
REA is installed globally (`rea`, MCP server `rea`, skill `reverse-engineer-anything`). Needs Node 22.19+/24.11+ and, for native, `GHIDRA_INSTALL_DIR=C:\Users\User\tools\ghidra_12.1.4_PUBLIC` and `JAVA_HOME` (JDK 21).
- JS/Electron: `rea analyze-javascript-application <asar-or-dir> --json > out.json` (output is large, write to a file, then summarise with a script).
- Native `.node`/`.dll`: REA's Ghidra provider on Windows accepts only `.exe`. Use Ghidra headless with a dump script (see Appendix A.4).
- Only do further RE when a spec question cannot be answered from public docs. Prefer public docs.

---

## 1. Product definition and decisions

| Decision | Choice | Why |
|---|---|---|
| Positioning | Free, open-source, self-hostable Discord-class platform | README |
| Wire format | **Jorcord-native** (`/api/v1`, camelCase, string enums) stays the primary API. Add an **optional Discord-compat layer** (section 6.10) so discord.js/py bots and the Embedded-App-SDK style activities can talk to it | PARITY.md calls wire compat "the largest multiplier"; the native API is already large, so compat is a translation layer, not a rewrite |
| Voice | LiveKit SFU (already in repo) | Writing an SFU is months; Discord's own engine is native C++ and not reusable |
| Clients | One React/Vite web app -> PWA, Tauri desktop, Capacitor mobile | PLATFORMS.md |
| Storage | Embedded DB default, Postgres/Redis/S3 optional | README |
| Premium | None. All limits are the "max" tier | CONTRACT |
| Permissions | Keep Discord's *algorithm*; keep Jorcord's own bit layout above bit 32 (documented in `permissions.ts`, `DISCORD_PERMISSION_BITS` maps to Discord's) | PARITY section 8 |

---

## 2. Current state snapshot (from repo docs and inventory, 2026-10-10)

Not re-verified by running the app. Re-check with `git log` and the tests before relying on any single line.

**Done (per README/PARITY):** accounts (register/login/refresh/logout, email verify, password reset, TOTP MFA, sessions), profiles (display name, bio, pronouns, avatar, banner, accent, custom status, themes), friends/blocks/read-states, DMs and group DMs (+ring), guilds, channels (text, voice, announcement, stage, forum, category, thread), categories + reorder, roles + overwrites using Discord's algorithm, members (nick, timeout, kick, ban), invites (+preview, join), messages (reply, edit, delete, bulk delete, pins, reactions, search, unfurl, GIFs, attachments via `/uploads`), threads (create-from-message, forum posts, auto-archive, lock), polls, scheduled events, stage instances (+request to speak, speakers), voice (LiveKit token, voice-states, moderation move/mute/deafen), webhooks (create/list/delete/execute), automod (keyword/spam/mention_spam/link), emoji + stickers, audit log, boosts (free), discovery, membership screening (`pending`), notification settings, push (VAPID + devices), applications + bot tokens + OAuth2 (+PKCE) + application commands (+permissions) + interactions (gateway + signed HTTP) + components + modals, rate-limit headers + buckets, numeric error codes, gateway intents (migration 008), data export (`/users/@me/export`), i18n (6 languages), Developer Portal page, Tauri desktop shell (tray, autostart, deep-link, single-instance, updater, window-state, notifications), Capacitor mobile shells, Docker compose, release workflow.

**Open per PARITY section 8:** Components V2, soundboard, onboarding prompts, avatar decorations, plus everything in section 4 marked missing or partial.

Inventory facts: ~125 route handlers in `apps/server/src/routes/*.ts` (applications, auth, channels, commands, events, guilds, interactions, members, messages, misc, polls, push, users, voice); migrations `001`-`008`; web app under `apps/web/src/{components,pages,stores,voice,i18n,lib}`; packages `shared`, `voice`, `bot-sdk`.

---

## 3. What the Discord desktop client contributes (summary of Appendix A)

The install is a thin Electron shell. Chat features are server-driven web UI and are specified here from public docs. The shell adds a **native capability layer** Jorcord's Tauri app must match. See section 7 for the plan and Appendix A for evidence.

---

## 4. Master feature matrix (the recon map)

Source tags: **DD** public docs, **RE** seen in local client analysis, **JP** Jorcord's own docs. Status is per section 2.

### 4.1 Accounts and identity
| Feature | Status | Pri | Size | Notes / source |
|---|---|---|---|---|
| Register, login, refresh, logout, sessions, MFA, email verify, password reset | done | - | - | JP |
| Passkeys / WebAuthn | missing | P2 | M | Standard; not in Discord docs |
| QR-code login (mobile approves desktop) | missing | P3 | M | Common pattern; implement with a short-lived pairing token |
| Account deletion / disable, data export | partial | P2 | S | `DELETE /users/@me`, `/users/@me/export` exist; add grace period + owned-guild transfer rule |
| Username uniqueness model (unique handle + display name) | partial | P2 | S | verify `routes/auth.ts` |
| Profile: pronouns, bio, banner, accent, theme | done | - | - | JP |
| Avatar decorations (cosmetic frames) | missing | P1 | M | `avatar_decoration_data` DD:resources/user; ship an original asset set |
| Profile effects | missing | P2 | M | original animations |
| Server tags (clan tags next to username) | missing | P1 | S-M | `primary_guild` DD:resources/user |
| Per-guild profile (avatar, banner, bio) | partial | P3 | S | |
| Connections (Steam, GitHub, Twitch...) + linked roles | missing | P3 | L | DD:resources/application-role-connection-metadata |
| User flags / badges (staff, bot, early supporter) | missing | P3 | S | |

### 4.2 Social
| Feature | Status | Pri | Notes |
|---|---|---|---|
| Friends, requests, blocks | done | - | |
| Mutual friends/servers, user notes | partial | P2 | S |
| Message requests / DM spam filter | missing | P2 | M |
| Activity feed ("friends are playing") | missing | P2 | needs rich presence (4.8) |
| Group DM owner transfer, icon | partial | P3 | S |
| Presence: online/idle/dnd/invisible + custom status + expiry | done | - | |

### 4.3 Guilds
| Feature | Status | Pri | Size | Notes |
|---|---|---|---|---|
| CRUD, icon/banner/splash, preview, discovery | done/partial | - | - | |
| Templates (user-created, shareable codes) | partial | P2 | S-M | built-ins only; DD:resources/guild-template |
| Onboarding prompts (questions assigning roles/channels), default channels | missing | P1 | M | DD:resources/guild |
| Rules / membership screening | done | - | - | |
| Verification level, explicit-content filter, default notifications, MFA-for-mods | missing | P1 | S-M | guild fields |
| Welcome screen | missing | P2 | S | |
| Prune, bulk ban | missing | P2 | S | |
| Widget (JSON + embed) | missing | P3 | S | |
| Vanity URL set endpoint | partial | P2 | S | |
| Audit log (numeric action types, `changes`) | partial | P1 | S-M | broaden coverage |
| Server insights / analytics | missing | P3 | M | |
| Server boosts (free) + tier perks | done | - | - | |
| Community server features (rules channel, public updates channel, discovery listing) | partial | P2 | S | |
| Server folders in rail | done (client) | - | - | |

### 4.4 Channels
| Feature | Status | Pri | Notes |
|---|---|---|---|
| text/voice/announcement/stage/forum/category/thread | done | - | |
| Voice-channel text chat | done | - | |
| Forum tags, sort order, layout (list/gallery), require_tag, guidelines | partial | P1 | M |
| Media channel (gallery-only forum) | missing | P3 | S |
| Threads: private, invitable, `THREAD_LIST_SYNC`, archived listing | partial | P1 | M |
| Announcement follow + crosspost | missing | P1 | M |
| Per-channel slowmode, NSFW/age gate | partial | P2 | S (verify) |
| Channel permission overwrites UI | done | - | |
| Stage instances (topic, privacy), "stage live" indicator | partial | P1 | S-M |
| Directory channel / linked-role-gated channels | missing | P3 | M |

### 4.5 Messaging
| Feature | Status | Pri | Size | Notes |
|---|---|---|---|---|
| Send/edit/delete/reply/bulk delete/pins/reactions | done | - | - | |
| Markdown, code blocks, spoilers, mentions, embeds (server unfurl) | done/partial | - | - | |
| Client/bot-sent rich embeds (author, fields, footer, up to 10) | partial | P1 | S | |
| Message components v1 + modals | done | - | - | |
| **Components V2** (container, section, text display, media gallery, file, separator, thumbnail) | missing | P1 | M | DD:components/reference |
| Message flags (suppress embeds, ephemeral, silent, voice message, components v2) | partial | P1 | M | |
| `allowed_mentions` | missing | P1 | S | |
| Voice messages (record, waveform, playback) | missing | P1 | M | flag + attachment waveform; perm SEND_VOICE_MESSAGES |
| Message forwarding (snapshots) | missing | P2 | M | |
| Message types (~40: thread starter, boost tiers, stage events, poll result, call...) | partial | P1 | M | system messages |
| Stickers (guild + standard packs), emoji (role-restricted), GIF picker | partial | P2 | S-M | |
| Polls | done | - | - | |
| Search with filters (`from:`, `has:`, `mentions:`, `in:`, `before/after/during`, `pinned`) | partial | P1 | M | |
| Link previews | done | - | - | |
| Message "jump to" / unread divider / mark unread | verify | P2 | S | |
| Edit history, scheduled sends | missing | P3 | M | |
| Link/attachment safety (file-type warnings, external link confirm) | partial | P1 | S | RE: confirm-before-open external URLs |

### 4.6 Roles and permissions
| Feature | Status | Pri | Notes |
|---|---|---|---|
| Roles, hierarchy, colours, hoist, overwrites, algorithm | done | - | |
| Role icons, gradient role colours | missing | P2 | S |
| Self-assignable roles (onboarding, role-reaction via bots) | partial | P2 | S |
| Missing bits: MANAGE_EVENTS/CREATE_EVENTS, USE_EXTERNAL_STICKERS, SEND_VOICE_MESSAGES, SEND_POLLS, USE_EXTERNAL_APPS, PIN_MESSAGES, BYPASS_SLOWMODE, USE_EXTERNAL_SOUNDS, MANAGE_GUILD_EXPRESSIONS | partial | P1 | S | audit against `DISCORD_PERMISSION_BITS` |

### 4.7 Voice, video, streaming
| Feature | Status | Pri | Size | Notes |
|---|---|---|---|---|
| Voice/video/screenshare (LiveKit), 4K60 limits, mute/deafen/move | done | - | - | |
| Push-to-talk (global hotkey in desktop) | partial | P1 | S-M | web has no global keys; Tauri global-shortcut |
| Voice activity sensitivity, auto-gain, echo cancel | partial | P1 | S | |
| **Noise suppression** (own: RNNoise/WASM or LiveKit filter) | missing | P1 | M | RE: Discord ships Krisp NC lite/med/pro + VAD; do not ship their models |
| **Soundboard** | missing | P1 | M | section 5.1 |
| Per-user volume, stereo pan | partial | P1 | S | RE: `setLocalVolume`, `setLocalPan` |
| Priority speaker | missing | P2 | S | |
| Speaking-while-muted hint | missing | P2 | S | RE: `OnSpeakingWhileMuted` |
| Go Live / stream preview / viewer list / stream quality presets | partial | P1 | M | |
| Screen share with system audio (soundshare) | partial | P1 | M | RE: soundshare callbacks; WebView2 limits |
| Background blur / virtual background (own model) | missing | P2 | M | RE: selfie segmentation .tflite in the install; use an open model (MediaPipe is Apache-2.0) |
| Voice effects / voice changer | missing | P3 | M | |
| Spatial audio | missing | P3 | M | RE: `isSpatialAudioEnabled` |
| **E2EE calls** (MLS-style) | missing | P2 | L | DD:topics/voice-connections "DAVE"; LiveKit E2EE (insertable streams) is the practical route |
| Stage channels (request to speak, audience) | done | - | - | |
| DM calls (ring, decline, video) | partial | P1 | S | |
| Region selection, ping/stats overlay | partial | P2 | S | |
| Clips / replay buffer (last 30s-10min saved) | missing | P3 | L | RE: clip load/move/delete IPC, `setClipRecordUser`, replay connection |
| Camera/mic device pickers, test mic, loopback | partial | P1 | S | |

### 4.8 Activities, rich presence, games
| Feature | Status | Pri | Size | Notes |
|---|---|---|---|---|
| **Embedded Activities platform** (iframe apps + SDK) | missing | P1 | L | section 5.2 |
| **Rich presence** (`activities[]` on presence) | missing | P1 | M | section 5.3 |
| Local RPC (named pipe + localhost WS) for games/apps | missing | P2 | M | RE: `discord-ipc` pipe, RPC WebSocket |
| Game detection (process scan -> "Playing X") | missing | P2 | M | RE: Steam/Battle.net/Uplay/EA/Google Play detection, game-event stream |
| Game library / activity privacy settings | missing | P2 | S | |
| Lobbies / Social-SDK-lite (game invites, linked channels) | missing | P3 | L | DD:resources/lobby |
| Overlay in games | **won't do** | - | - | requires injection |

### 4.9 Bots, apps, integrations
| Feature | Status | Pri | Size | Notes |
|---|---|---|---|---|
| Applications, bot users/tokens, OAuth2 (+PKCE), install flow | done | - | - | |
| Slash/user/message commands, autocomplete, permissions | done/partial | - | - | verify autocomplete + context menus |
| Interactions (gateway + signed HTTP), followups, modals | done | - | - | |
| Entry-point commands (App Launcher) | missing | P1 | S | needed by activities |
| App Launcher UI (browse apps/activities in channel) | missing | P1 | M | |
| User-installable apps (user install context) | partial | P2 | M | `/applications/:id/installs` exists |
| Gateway: full event set, intents, sharding, `GUILD_MEMBERS_CHUNK`, resume | partial | P1 | L | section 6.10 |
| Compat layer for discord.js/py | missing | P2 | L | section 6.10 |
| Webhooks full API (token get/patch/delete, edit message, `thread_id`, `wait`) | partial | P1 | S | |
| Webhook events (app-level HTTP events) | missing | P3 | M | DD:events/webhook-events |
| Slack/GitHub-compatible webhook endpoints | missing | P3 | S | |
| Bot SDK package | done | - | - | `packages/bot-sdk`; extend for activities, soundboard |
| Developer Portal (apps, tokens, OAuth redirects, commands, activity URL mappings) | partial | P1 | M | extend for activities |
| App directory / bot listing | missing | P3 | M | |

### 4.10 Moderation and safety
| Feature | Status | Pri | Notes |
|---|---|---|---|
| Ban/kick/timeout, audit log | done/partial | - | |
| AutoMod depth: presets, regex, allow-lists, exempt channels, timeout duration, alert channel, MEMBER_PROFILE trigger, execution event | partial | P2 | M |
| Reports (user, message, server) + moderator queue | missing | P1 | M |
| Raid protection (join-rate lockdown), verification gating | missing | P1 | M |
| Explicit-image scan / safe-DM filter | missing | P3 | L (needs a model or third-party) |
| Age gate for NSFW | partial | P2 | S |
| Appeals | missing | P3 | M |

### 4.11 Notifications and settings
| Feature | Status | Pri | Notes |
|---|---|---|---|
| Push (web push + devices), per-guild/channel notification settings | done | - | |
| Unread/mention badges, taskbar/dock badge | partial | P1 | desktop badge missing (section 7) |
| Do-not-disturb schedules, quiet hours | missing | P3 | S |
| Settings sync across devices | partial | P2 | S |
| Keybinds editor | missing | P2 | M |
| Accessibility: reduced motion, high contrast, text scaling, screen-reader pass | partial | P1 | M |
| Languages | 6 | P3 | add more |

### 4.12 Platform (desktop and mobile)
See section 7. Mobile: push via FCM/APNs, CallService on Android, share targets, haptics (WRAPPER_WEB_NEEDS.md).

---

## 5. Detailed specs for the large missing features

### 5.1 Soundboard
Public reference: `DD:resources/soundboard`.
- **Object**: `{ id, guildId|null, name, volume 0..1, emojiId|null, emojiName|null, available, userId, filename }`. Default sounds have `guildId=null` and are listed by `GET /soundboard-default-sounds`. Ship ~16 original default sounds (license-clear, your own).
- **Limits** (Discord's public numbers: 512 KB, 5.2 s; adopt them, add them to `limits.ts`). Allowed MP3/OGG. Slot counts: free for all, set to the top tier (48).
- **Routes** (native Jorcord style): `GET /guilds/:id/soundboard-sounds`, `POST` (multipart), `PATCH/DELETE /guilds/:id/soundboard-sounds/:sid`, `GET /soundboard-default-sounds`, `POST /channels/:id/send-soundboard-sound {soundId, sourceGuildId?}`.
- **Permissions**: `USE_SOUNDBOARD` (exists), `CREATE_GUILD_EXPRESSIONS`, `MANAGE_GUILD_EXPRESSIONS`, `USE_EXTERNAL_SOUNDS` (new), and `SPEAK` + not deafened/muted/suppressed in the channel.
- **Events**: `GUILD_SOUNDBOARD_SOUND_CREATE|UPDATE|DELETE`, `VOICE_CHANNEL_EFFECT_SEND {channelId,userId,soundId,soundVolume,emoji?}`.
- **Delivery**: sender calls the REST route; server validates and broadcasts `VOICE_CHANNEL_EFFECT_SEND` to channel members; **every client plays the sound locally** (fetch file, play through the output device, respect per-user mute of the sender and a "mute soundboard" setting). No server mixing.
- **Rate limit**: 1 sound per 2 s per user per channel (own number).
- **Audit**: create/update/delete entries.
- **UI**: soundboard popover in the voice panel (server sounds, default sounds, favourites), "Upload sound" modal with trim/preview, settings toggle to disable sounds, on-screen effect toast.
- **Tests**: permission matrix, size/duration rejection, event fan-out, cross-guild with/without `USE_EXTERNAL_SOUNDS`.

### 5.2 Embedded Activities
Public reference: `DD:activities/*`, `DD:developer-tools/embedded-app-sdk`. Observed in local shell: external URL opens go through a confirmation/allow-list path and `will-navigate` is locked to the app origin; the same sandbox idea applies to activity iframes.

Architecture:
1. **Activity** = a web app registered on an Application (`activityUrl`, URL mappings, supported platforms, max participants).
2. **Launch**: an **entry-point command** (auto-created "Launch" per app with activities enabled) or interaction callback type `LAUNCH_ACTIVITY` (12). Starting in a voice/stage/DM call creates an **activity instance** `{ instanceId, applicationId, guildId, channelId, location, participants[], startedAt }`.
3. **Hosting**: client renders an `<iframe sandbox="allow-scripts allow-same-origin allow-forms allow-popups ...">` pointing to `https://{applicationId}.{ACTIVITY_PROXY_DOMAIN}/…`. The server runs an **activity proxy** that maps the activity origin to the developer's URL and applies the developer's URL mappings (everything else blocked by CSP). WebRTC blocked, WebSocket allowed (matches DD). Query params on the iframe URL carry `instance_id`, `location_id`, `guild_id`, `channel_id`, `platform`, `frame_id`.
4. **postMessage protocol** (re-implement; message shapes are public in the SDK repo): opcodes `HANDSHAKE`, `FRAME`, `CLOSE`, `HELLO`; request/response by `nonce`; events pushed by the host.
5. **SDK package** `@jorcord/embedded-app-sdk` in `packages/embedded-app-sdk`: `ready()`, `subscribe/unsubscribe`, `close()`, commands `authorize`, `authenticate`, `getChannel`, `getChannelPermissions`, `getActivityInstanceConnectedParticipants`, `getPlatformBehaviors`, `setActivity` (rich presence), `openInviteDialog`, `shareLink`, `openExternalLink`, `setConfig`, `setOrientationLockState`, `userSettingsGetLocale`, `initiateImageUpload`, `encourageHardwareAcceleration`, `captureLog`; events `READY`, `ERROR`, `VOICE_STATE_UPDATE`, `SPEAKING_START/STOP`, `ACTIVITY_LAYOUT_MODE_UPDATE`, `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`, `CURRENT_USER_UPDATE`, `CURRENT_GUILD_MEMBER_UPDATE`, `ORIENTATION_UPDATE`, `THERMAL_STATE_UPDATE`, `RELATIONSHIP_UPDATE`, `ENTITLEMENT_CREATE` (skip monetization ones: `getSkus`, `getEntitlements`, `startPurchase`).
6. **Auth in activities**: `authorize` pops the existing OAuth2 consent modal; the activity backend exchanges the code at `/oauth2/token`; `authenticate` returns `{ accessToken, user, scopes }`. Reuse the existing OAuth2 code (done).
7. **Layout**: focused (main stage), picture-in-picture, grid; mobile orientation rules; participants list; "Join" from the voice channel tile.
8. **Built-in activities** (original, MIT): shared whiteboard, watch-together (synced `<video>`/YouTube URL), trivia, tic-tac-toe/chess, simple card game. They also act as the reference implementation and test fixtures. Provide an optional **room relay** (`/activities/:instanceId/ws`) so activities need no backend for simple state.
9. **Security**: sandbox flags, strict CSP, no cookies from the host origin, activity origin distinct from the app origin, token never in URL, rate-limit `postMessage` commands, activity can only call commands allowed by granted OAuth scopes (`rpc.activities.write`, `identify`, `guilds`...).
10. **Developer Portal**: Activities tab (enable, URL mappings, root URL mapping, supported platforms, max participants, default entry-point command, test-in-guild).
11. **Schema**: `activity_instances`, `activity_participants`, application columns `activity_url`, `activity_mappings jsonb`, `activity_flags`.
12. **Tests**: handshake, scope-gated commands, join/leave participant events, proxy blocks unmapped hosts, instance cleanup when the call ends.

### 5.3 Rich presence and game detection
Public reference: `DD:rich-presence/*`, activity object in `DD:events/gateway-events`. Local evidence: the client has a local **RPC server** (named pipe `discord-ipc` and a localhost WebSocket), a **game-events** stream, a process **executable fingerprint** mechanism, and store-library scanners (Steam `libraryfolders`, Battle.net, Uplay, EA, Google Play).
- **Presence model**: `presence.activities[]` with `{ type: playing|streaming|listening|watching|custom|competing, name, details, state, createdAt, timestamps{start,end}, applicationId, assets{largeImage,largeText,smallImage,smallText}, party{id,size[cur,max]}, secrets{join,spectate,match}, buttons[{label,url}] (max 2), instance }`. Custom status stays as the type-custom entry.
- **Gateway**: `PRESENCE_UPDATE` carries activities; `IDENTIFY` presence supports bots.
- **Local RPC** (desktop only): listen on a named pipe `jorcord-ipc-0..9` (Windows `\\?\pipe\jorcord-ipc-N`, unix `$XDG_RUNTIME_DIR/jorcord-ipc-N`) and `ws://127.0.0.1:6473-6482` with Origin checking. Handshake `{v:1, client_id}`, then frames `SET_ACTIVITY`, `SUBSCRIBE`/`UNSUBSCRIBE`, `AUTHORIZE`, `AUTHENTICATE`, `GET_SELECTED_VOICE_CHANNEL`, `GET_VOICE_SETTINGS`/`SET_VOICE_SETTINGS`, `ACTIVITY_INVITE_USER`, `ACCEPT_ACTIVITY_INVITE`, `SEND_ACTIVITY_JOIN_INVITE`, `CLOSE_ACTIVITY_JOIN_REQUEST` (command names confirmed in the Game SDK analysis, A.4b; voice `input_mode` = `PUSH_TO_TALK|VOICE_ACTIVITY`). Port range deliberately differs from Discord's so the two do not collide. Validate `client_id` against registered applications.
- **Game detection** (Tauri side, opt-in, off by default): scan running processes (Rust `sysinfo`) every few seconds against a **detectable-apps list** served by the Jorcord server (`GET /detectable-applications`, community-maintained JSON: `{ id, name, executables[{name,os}] , aliases }`). Show "Playing X" as an activity of type playing. Per-game toggle and global toggle (User Settings > Activity Privacy). Never upload process lists; only the matched app id.
- **Steam/Battle.net library** import is **out of scope**; use detection only.
- **UI**: activity line in member list and profile popover, "Join" / "Ask to join" buttons using `party`+`secrets`, activity privacy page, friends-activity sidebar.
- **Tests**: schema validation, button/URL allow-list, RPC frame parser fuzz, detection matching.

### 5.4 Onboarding, avatar decorations, server tags
- **Onboarding**: `GET/PUT /guilds/:id/onboarding {enabled, mode, defaultChannelIds[], prompts[{id,title,type single|multiple,required,inOnboarding,options[{id,title,description,emoji,roleIds[],channelIds[]}]}]}`; apply roles/channels on completion; "Customize Community" channel list; `GUILD_ONBOARDING_*` audit entries. New members see screening (exists) then onboarding.
- **Avatar decorations**: catalogue table `decorations(id,name,asset,animated)` + `users.decoration_id`; render as an overlay ring; admin-uploadable decorations per guild optional. Original artwork only.
- **Server tags**: `users.primary_guild_id`, guild `tag` (4 chars) + `tagBadge`; guild opts in via setting; shown after the name in chat/member list.

### 5.5 Lobbies and Social-SDK-lite (optional, P3)
`DD:resources/lobby`: lobby create/join/modify/delete, members with metadata, linked channel, lobby messages, voice via LiveKit room. Gives third-party games chat+voice without a guild. Implement after activities; reuse LiveKit rooms and message storage.

### 5.6 E2EE voice (P2)
Discord's public "DAVE" protocol (MLS-based, see `DD:topics/voice-connections`) is not what LiveKit does. Use **LiveKit E2EE** (insertable streams, shared key per call, key rotation on membership change, key exchange via the existing gateway with per-device public keys). Verified-call indicator + safety code UI. Document that file/text E2EE is out of scope.

### 5.7 Clips (P3)
Desktop only. Rolling replay buffer of screen+audio via the webview capture stream (MediaRecorder ring buffer in memory or temp files), "Save last N seconds", trim UI, share to a channel as an attachment. Native module not required for the first version.

### 5.8 Linked roles and connections (P3)
Application role-connection metadata (`DD:resources/application-role-connection-metadata`): apps register metadata schema, users link accounts via OAuth, guild roles require metadata conditions. Implement after the compat layer.

---

## 6. Architecture changes

### 6.1 New tables (migrations 009+)
`soundboard_sounds`, `decorations`, `activity_instances`, `activity_participants`, `onboarding_prompts`, `onboarding_options`, `guild_templates` (user), `reports`, `lobbies`, `lobby_members`, `detectable_applications`, `app_role_connections`; columns: `applications.activity_*`, `guilds.verification_level|explicit_filter|welcome_screen|tag`, `users.decoration_id|primary_guild_id`, `messages.flags|snapshots`.

### 6.2 Gateway events to add
`GUILD_SOUNDBOARD_SOUND_*`, `VOICE_CHANNEL_EFFECT_SEND`, `ACTIVITY_INSTANCE_*`, `GUILD_ONBOARDING_UPDATE`, `THREAD_LIST_SYNC`, `THREAD_MEMBER_UPDATE`, `INVITE_CREATE|DELETE`, `AUTO_MODERATION_ACTION_EXECUTION`, `WEBHOOKS_UPDATE`, `STICKERS_UPDATE` (exists), `GUILD_SCHEDULED_EVENT_*` (verify).

### 6.3 Scale and reliability (needed before public hosting)
Redis pub/sub for multi-instance gateway fan-out, rate limits in Redis, sharded gateway, lazy member lists (don't send every member), presence throttling, message partitioning, attachment virus-scan hook, backup/restore doc, observability (metrics, structured logs), load test target numbers in `docs/DEPLOY.md`.

### 6.4 Search
Postgres FTS exists; add Meilisearch/OpenSearch adapter behind the same interface when message volume warrants; keep the filter grammar in `packages/shared`.

### 6.5 Files and media
Direct-to-S3 presigned uploads, image resizing/thumbnailing worker, video poster frames, waveform generation for voice messages, animated avatars (APNG/WebP/GIF) allowed for all.

### 6.6 Security checklist (run the `backend-design:security-reviewer` agent per PR)
IDOR on every `:id` route, mass assignment, SSRF in unfurl and webhook URLs, upload type sniffing, rate limits on auth, session revocation on password change, OAuth redirect URI exact-match, PKCE required for public clients, activity iframe sandbox, CSP in all shells, token storage in OS keychain on desktop.

### 6.7 Accessibility and i18n
WCAG 2.1 AA pass (focus order, labels, contrast, reduced motion), screen-reader announcements for new messages/voice joins, RTL support, string extraction to catalogs, add languages.

### 6.8 Mobile specifics
Push via FCM/APNs, Android foreground `CallService`, iOS CallKit/PushKit (needs Apple account), share-sheet target, haptics, background audio, orientation rules for activities.

### 6.9 Admin and ops
Instance admin panel (users, guilds, reports, global bans), first-run setup, SMTP config, S3/LiveKit health checks, license + privacy pages.

### 6.10 Discord-compat layer (optional, P2)
A separate Fastify plugin mounted at `/api/v10` and a gateway endpoint speaking Discord's JSON/ETF-less protocol: snake_case, numeric enums, Discord event names, intents, zlib-stream, `READY` lazy guilds, `GUILD_MEMBERS_CHUNK`. Translate to the native services. Goal: discord.js and discord.py bots connect by changing only the base URL. Keep it isolated so native API evolution is not constrained. (Local evidence: the desktop shell uses `erlpack` + `zstd` native modules for gateway encoding/compression, which confirms those are optional optimisations, not required for compat.)

---

## 7. Desktop native layer (Tauri), derived from the local client analysis

Create `packages/native` with `JorcordNative` types plus a web fallback, and Tauri commands in `apps/desktop/src-tauri`. Groups mirror what the reference shell exposes (names are ours):

| Group | Capabilities | Status in repo | Pri |
|---|---|---|---|
| app | version/arch/channel, relaunch, quit-and-install, open-on-startup get/set, preferred languages, system text direction | partial (autostart, updater) | P1 |
| window | min size 320x180, bounds/maximized persist, minimize-to-tray, start-minimized, close-to-tray, taskbar buttons (mute/deafen), mouse coords, display count | partial | P1 |
| tray | state icons (normal/unread/mention/in-call), quick actions | partial | P1 |
| badge | unread/mention count on taskbar/dock | missing | P1 |
| notifications | show/close/clear, permission state, click-to-focus channel | partial | P1 |
| clipboard | copy/cut/paste incl. images | missing | P1 |
| files | open/save dialogs, show in folder, download to path, asset cache | missing | P1 |
| secure storage | OS keychain for tokens (replaces localStorage tokens on desktop) | missing | P1 |
| power | system idle time (auto-idle), lock/unlock/suspend/resume events, block display sleep during calls | missing | P1 |
| shortcuts | global PTT / mute / deafen, keybind editor | missing | P1 |
| capture | source picker (screens/windows), system-audio capture where possible | partial | P1 |
| external links | confirm-before-open for untrusted hosts; origin lock for navigation | missing | P1 |
| updater | splash, progress, optional vs required, backoff, rollback-safe | partial | P1 |
| spellcheck | languages, learned words | missing | P3 |
| gpu / diagnostics | hardware-acceleration toggle (needs relaunch), system info, logs path, crash reports (local) | missing | P2 |
| rpc/game detection | section 5.3 | missing | P2 |
| clips | section 5.7 | missing | P3 |
| overlay | **not planned** | - | - |

Linux Wayland note: global shortcuts and screen capture need portals; document limits.

---

## 8. Build order (phases) and acceptance

Each item ends with its tests green and `docs/CONTRACT.md` + `docs/PARITY.md` updated.

**Phase A: quick wins (1-2 weeks)** : permission bits audit + missing bits; `allowed_mentions`; message flags; client-sent embeds; webhook full API; announcement follow/crosspost; stage-instance polish; audit-log coverage; reports API + mod queue; verification level/explicit filter fields; desktop P1 native items (tray/badge/clipboard/files/keychain/idle/power/external-link confirm).
*Done when*: new tests pass, `PARITY.md` rows flipped, desktop build runs with the new commands.

**Phase B: community features (2-4 weeks)** : soundboard (5.1), voice messages, Components V2, forum polish, thread lifecycle, onboarding (5.4), avatar decorations + server tags, welcome screen/prune/bulk-ban, noise suppression, PTT global hotkey, per-user volume/pan, search filters.
*Done when*: two clients exchange soundboard effects in a voice channel; onboarding assigns a role; Components V2 message renders.

**Phase C: platform (4-8 weeks)** : entry-point commands + App Launcher, **Activities platform** (5.2) with 3 built-in activities, **rich presence** (5.3) + local RPC + game detection, Developer Portal activity tab, gateway scale work (6.3), compat layer (6.10).
*Done when*: an unmodified sample Embedded-App-SDK-style activity (ours) runs in two clients and updates presence; a discord.js bot logs in through `/api/v10` and replies to a slash command.

**Phase D: depth (ongoing)** : E2EE voice, clips, lobbies, linked roles, passkeys/QR login, AutoMod depth, raid protection, i18n expansion, mobile push/CallKit, admin panel.

Suggested parallel workstreams (one git worktree each): (1) server REST/DB, (2) gateway/events/scale, (3) web UI, (4) voice/soundboard/noise, (5) activities platform + SDK, (6) desktop native + RPC, (7) QA/diff.

---

## 9. Per-item loop and definition of done

For every item:
1. Write/extend the spec bullet in `docs/CONTRACT.md` (routes, payloads, errors, events).
2. Migration (reversible, indexed FKs, owner column), shared types/permission bits, server route + service, authorization check per query, rate limit, audit entry, gateway event.
3. Web UI with every state (empty/loading/error/no-permission/long content), mobile width 390px and 1440px, keyboard-only flow, i18n keys.
4. Tests: unit + route tests (`apps/server/test`), permission matrix, at least one two-client e2e (Playwright) for real-time features.
5. Run lint, typecheck, tests; screenshot key screens; run `security-reviewer` on the diff.
6. Update `docs/PARITY.md` status and `README` feature list. One commit per item.

Definition of done = acceptance line of the phase plus: no console errors, no hard-coded Discord assets/copy, features free-for-all via `limits.ts`, docs updated.

---

## 10. Risks, limits, unknowns

- Discord's chat UI was not in the install, so UI layout/behaviour comes from public docs, support articles and the existing Jorcord UI. Use `replica-diff`-style screenshot comparison only against screenshots the user personally takes in their own session.
- Native module internals are only partially decompiled (Appendix A.4); no behaviour was copied.
- Wire-compat with Discord is a moving target (new fields monthly). Treat the compat layer as best-effort.
- Voice quality/scale depends on LiveKit deployment, not client code.
- Apple builds need a Mac and developer account; store publishing needs the owner's accounts.
- Legal: Discord's Terms restrict reverse engineering and clones that confuse users. Keep branding distinct, copy no assets, and obtain legal advice before public launch.

---

## Appendix A. Local reverse-engineering evidence (Discord 1.0.9261)

### A.1 Layout
`app-1.0.9261/resources/app.asar` (3.5 MB bootstrap) + `modules/discord_desktop_core-1/discord_desktop_core/core.asar` (shell) + 17 native module folders. Electron 42.7.1.

### A.2 JavaScript shell (REA `analyze_javascript_application`)
- app.asar: 1026 JS modules, 1 BrowserWindow (splash), preload `splashScreenPreload.js`, IPC: `DISCORD_SPLASH_UPDATE_STATE`, `DISCORD_SPLASH_SCREEN_QUOTE|READY|QUIT`, `DISCORD_GET_BUILD_OVERRIDE_STATUS`, `DISCORD_CLEAR_BUILD_OVERRIDE`; updater/env flags `NEW_UPDATE_ENDPOINT`, `ALLOW_OPTIONAL_UPDATES`, `SKIP_HOST_UPDATE`, `SKIP_MODULE_UPDATE`, `USE_PINNED_UPDATE_MANIFEST`, `ALWAYS_BOOTSTRAP_MODULES`, `DESKTOP_TTI_*` (time-to-interactive tuning), `START_MINIMIZED`, Sentry.
- core.asar: 547 modules, 73 IPC operations, `DiscordNative` context bridge with groups `app, process, os, settings, nativeModules, clipboard, ipc, gpuSettings, window, spellCheck, crashReporter, desktopCapture, fileManager, processUtils, powerSaveBlocker, accessibility, features, userDataCache, safeStorage, http`; frameless window (`frame:false`, min 320x180, bg `#2f3136`), `WEBAPP_ENDPOINT` remote UI, `will-navigate` origin lock, `setWindowOpenHandler` -> safe external opener, single-instance `second-instance`, settings keys `WINDOW_BOUNDS, IS_MAXIMIZED, IS_MINIMIZED, MINIMIZE_TO_TRAY, MIN_WIDTH, MIN_HEIGHT, enableHardwareAcceleration, trayBalloonShown, enableConferenceMode, DANGEROUS_ENABLE_DEVTOOLS_ONLY_ENABLE_IF_YOU_KNOW_WHAT_YOURE_DOING`. Other IPC groups seen: notifications, system tray (icon/strings/states/applications), thumbar buttons, search index (index/delete/clear domains/items), clips (`LOAD_CLIPS_DIRECTORY`, `LOAD_CLIP`, `MOVE_CLIP`, `DELETE_CLIP`, `RENDER_MONTAGE_RECIPE`), NTP clock sync, intents activity (macOS), navigation history clear, analytics events, paint metrics, frame-evictor pause.
- Dependencies (package.json): Sentry browser/electron, lodash, yauzl, node-downloader-helper, unbzip2 (module installer).

### A.3 Native module inventory
discord_voice (21 MB), discord_krisp (14 MB), discord_dispatch (10 MB), discord_cloudsync (4.2 MB), discord_utils (2 MB), discord_game_utils (1 MB), discord_hook, discord_overlay2, discord_desktop_overlay, discord_media, discord_zstd, discord_erlpack, discord_modules (+aegis), discord_rpc (JS: named pipe + WebSocket server), discord_notifications (JS), discord_spellcheck (JS), plus helper executables (DiscordSystemHelper, gpu_encoder_helper, audio_effects_helper, DiscordHookHelper).

### A.4 Native decompilation (Ghidra 12.1.4 headless, script `DumpModule.java`)
Method: REA's Ghidra provider rejects DLL/`.node` on Windows, so each module was imported with `analyzeHeadless`, auto-analysed, and a script dumped exports, imports, strings and decompiled exported functions. Results are summarised below per module. Raw dumps are in the session scratchpad and are **not** part of this repo.

All modules are 64-bit Windows PE DLLs loaded as Node-API addons (`napi_register_module_v1`). Several are Rust (`discord_common\rust\napi`), the rest C++. **Observed** = in strings/imports/decompiled exports; **Inferred** = reasoned from names. What each finding means for Jorcord is in the last column.

| Module | Observed | Inferred / meaning for Jorcord |
|---|---|---|
| `discord_voice` (21 MB) | Built on **libwebrtc** (AEC3 echo canceller incl. "Transparent Mode", AGC2 adaptive digital gain, NACK/FlexFEC, loss-based BWE v2, SRTP/DTLS, simulcast stream factory, multi-encoder). **Video codecs** H.264, H.265, AV1 with hardware encoders via NVENC/CUDA, AMD AMF, Intel QSV, Media Foundation (CPU/GPU/DX11), VAAPI/Vulkan on Linux; software fallbacks (FFmpeg H.264 decoder, Electron decoders), `FallibleVideoDecoder` and **pixel-capped decoder** fallbacks, encoder stall/unsupported error taxonomy. **Audio**: WASAPI device enumeration, loopback capture for **soundshare** (`soundshare/controller.cpp`, `loopback_controller.cpp`), `spatial_mixer.cpp` (Steam Audio `IPL*` effects), echo canceller factory + probe bank, per-device audio effects, noise canceller wrapper for Krisp (`krisp/noise_canceller.cpp`). **E2EE**: bundled `libdave` (MLS: sessions, external sender, welcome/commit/proposal handling, epoch authenticator, key ratchet, persisted key pair on Windows). **Clips**: a separate **clips child process** (`clips_process_bridge_win.cpp`, shared-memory frame control, DXGI shared textures, `gpu_copy_fence_win.cpp`, `clips_video_forwarder_win.cpp`). **Capture**: GDI BitBlt/PrintWindow, DXGI graphics capture, auto-stop when exclusive fullscreen detected. Adaptation stats: bandwidth/CPU/quality-limited resolution percentages. MediaPipe + selfie-segmentation models for background effects. Camera orientation correction, DirectShow capture pins, I420/RGBA frame types. | Confirms the architecture Jorcord should mimic at the *browser* level: simulcast, adaptive bitrate, hardware encode when the browser exposes it, fallbacks, stats overlay. LiveKit already provides simulcast, NACK, FEC, TWCC, E2EE (insertable streams), AV1/VP9/H.264. The native engine is not reusable and not needed. Takeaways: (1) expose quality presets + codec preference, (2) fall back gracefully on decoder failure, (3) stop/pause capture when a game goes exclusive fullscreen (desktop), (4) a separate process for clip recording avoids stalling voice, (5) E2EE = MLS with an external sender (the server); LiveKit's shared-key E2EE is the pragmatic equivalent, MLS is a stretch goal. |
| `discord_krisp` (14 MB) | Third-party **Krisp SDK** (ONNX runtime inside) exposing `KrispInitializeExternal`, `KrispNCSetup/Process/ProcessFloat/Reset/SetModel`, `KrispNCGetSessionStats`, VAD setup; suppression level get/set; model files (NC lite v1, NC med v7, NC narrowband v2, BVC pro v3, VAD v2). **It refuses to initialise unless the host app is signed by Discord.** | Cannot and must not be reused (licensed, signature-locked). Jorcord: ship **RNNoise (BSD) via WASM AudioWorklet** or LiveKit's noise filter option; expose "Off / Standard / High" and a VAD-based gate. Provide suppression level UI. |
| `discord_utils` (2 MB, C++) | N-API `getGPUDriverVersions`, `setCandidateGamesCallback`, `setServiceChannel`; a Windows **system helper service** protocol (`FocusWindowRequest`, `GpuBoostRequest`, `PerformanceMonitorRequest`, `GetPerformanceMonitorSnapshotRequest`); **game events** (`startGameEvents`, `stopGameEvents`, `inputGetRegisteredEvents`); process priority (`setProcessPriority`, `D3DKMTSetProcessSchedulingPriorityClass`), foreground-process setter, **executable fingerprint** collection, perf-attributed memory stats, heap hooks, **WER crash minidump** writer, store launcher detection strings (Steam `libraryfolders` + registry, Battle.net, Uplay, EA Play, Google Play Games), curated game names. | Basis for Jorcord's game detection (section 5.3): detect by process image name against a server-side list, optionally with a fingerprint to avoid spoofing; do **not** hook heaps or install services. Crash handling: use `tauri-plugin` crash/minidump to local files only (opt-in upload). |
| `discord_game_utils` | Game library helpers: `setRecentGames`, `launchTarget`, `createShortcuts` / `removeShortcuts`, per-game `executables`, `publisher`, `distributor`, `workingDir`, `useLauncher`, `thirdPartySkus`; a video/audio hook client (`VideoHook`, `AudioEncoder`, `AdmHelper` strings shared with the hook family). | Optional "Game library" panel: recently played list, launch shortcut, hide game. Low priority (P3). |
| `discord_rpc` (JS) | Local IPC server on named pipe `\\?\pipe\discord-ipc-N` (unix: `$TMP/discord-ipc-N`) plus a localhost WebSocket server with origin checks; safe emitter wrapper. | Implement `jorcord-ipc-N` + `ws://127.0.0.1:6473..6482` (section 5.3). Same shape, different names/ports. |
| `discord_overlay2` + `discord_hook` + `discord_desktop_overlay` | Overlay host process per game, per-process renderer create/destroy, JSON IPC (`relay`, `renderer_ready`, `deactivate_overlay`, `set_drawing_state`), framebuffer submission (`SendOverlayFrame`, `sendFramebuffer`), input translation (`translateInputEvent`, click counts, modifiers), crash/load-failure counters, MinHook-based API hooking (`MH_*`) and injected `DiscordHook(64).dll`. | **Not implemented** (needs DLL injection into third-party processes; anti-cheat risk). Offer instead: always-on-top mini voice window + OS notifications. |
| `discord_cloudsync` (Rust) | Content-addressed chunk sync with commands `CloudSync::Sync`, config `{ id, paths, patterns, manifestPath, replacements, forceHash }`, push/pull, compression, hit/miss chunk stats (`chunkCount`, `compressedSize`, `hitChunkCount`, `missCompressedSize`, `startTimestamp`, `endTimestamp`), TLS + AES-GCM/ChaCha20 via OpenSSL/ring. Likely **game-save cloud sync**. | Out of scope for chat parity. If wanted later: per-app save sync as an Activity/app service. Settings sync is simpler: `PATCH /users/@me/settings` blob. |
| `discord_media` (Rust) | `getGpuStats`, `getMemoryUsageBlob`, `getSystemAnalyticsBlob`: GPU vendor/device/driver, PCIe link, hybrid iGPU flag, monitors (size, refresh, colour space), default camera capabilities (max resolution, I420/NV12/YUY2/MJPG formats, bus, vendor), CPU memory. | Used for choosing encoder/quality and diagnostics. Jorcord: a Diagnostics page (WebRTC stats, `navigator.mediaDevices.enumerateDevices`, `getCapabilities`), no vendor-ID telemetry. |
| `discord_erlpack` | Erlang External Term Format encoder/decoder (zlib-compressed terms, big ints up to 8 bytes, recursion limits). Shares the hook-family strings. | Optional gateway encoding. Jorcord uses JSON; add msgpack/zstd only if bandwidth data justifies. |
| `discord_zstd` (Rust) | `DecompressStream` over zstd-safe 7.1, `initializeLogging`. | Gateway transport compression (`zstd-stream`); pairs with the compat layer (6.10). |
| `discord_dispatch` (10 MB), `discord_modules`+`aegis`, `discord_notifications` (JS), `discord_spellcheck` (JS) | Not decompiled (dispatch = legacy game install/store; aegis = integrity/anti-tamper; notifications and spellcheck are JS shims). | Skipped by design. |
| `DiscordSystemHelper.exe` | Rust Windows **service** (install/uninstall/relaunch-as-service, non-admin fallback uninstall) talking to the app over a **named pipe** (`CreateNamedPipeW`, client-PID check, impersonation) with typed messages `FocusWindowRequest/Response`, `GpuBoostRequest/Response`, `PerformanceMonitorRequest` / `GetPerformanceMonitorSnapshotRequest/Response`, and a **keybind service** (`KeybindServiceReady`) built on `RegisterRawInputDevices` + HID with `OnlyWhenFocused` / `OnlyWhenUnfocused` modes. Imports WinTrust/Crypt32 (signature verification of the caller). | The useful idea is **global keybinds that still fire while a game has focus** (PTT, mute): raw input, not normal hotkeys. Jorcord: Tauri global-shortcut for the default, optional raw-input mode on Windows behind a setting. The rest (installing a service, GPU boost) is not needed. |

**Voice features Jorcord should add because the engine has them (cross-checked with DD):** per-user volume + pan, local mute, priority speaker, "speaking while muted" detection, PTT with global hotkey, ping/RTCP stats overlay, region/ICE failure recovery, encoder/decoder fallback with a visible "reduced quality" hint, stream quality presets (resolution x fps x codec), screen capture stop on exclusive fullscreen, system-audio share with per-app exclusion where the OS allows, spatial/stereo mixing toggle, replay-buffer clips, E2EE indicator.

**Limits of this analysis:** strings, imports, export names and a few decompiled napi entry points only; no function-by-function review and no dynamic analysis. Anything labelled "inferred" must be re-validated against public docs before being specified in a ticket.

### A.4b Second pass (targeted decompilation by string cross-reference, plus the remaining binaries)
Method: for each key behaviour string, the functions referencing it were decompiled (`DumpDeep.java`). Raw decompilation is unreadable without renaming, so only *behaviours confirmed by code structure and strings* are recorded.

**`discord_voice` confirmed details (use as requirements, implement fresh):**
- **Transport encryption mode table** (id -> name): 0 `xsalsa20_poly1305`, 1 `xsalsa20_poly1305_suffix`, 2 `xsalsa20_poly1305_lite`, 3 `xsalsa20_poly1305_lite_rtpsize`, 4 `aead_aes256_gcm`, 5 `aead_aes256_gcm_rtpsize`, 6 `aead_xchacha20_poly1305_rtpsize`. A `GetEncryptionModes` call returns the supported list to the JS layer. Jorcord uses WebRTC DTLS-SRTP through LiveKit, so this is informational; if a custom UDP voice path is ever built, prefer the AEAD modes.
- **Voice connection API surface** (JS-visible): create voice connection / own-stream connection / replay connection, `setSelfMute`, `setSelfDeafen`, local mute, `setLocalVolume`, `setLocalPan`, `setPTTActive`, `setRemoteUserSpeakingStatus`, `setRemoteUserCanHavePriority`, speaking and speaking-while-muted callbacks, `setDesktopSource(WithOptions)` with a capturer type, desktop-source status/ended callbacks, soundshare start/ended/failed callbacks (`soundshare_send_start`), `setGoLiveDevices` / `clearGoLiveDevices` (camera frames as a Go Live source), `setPingInterval` + ping/timeout callbacks, RTCP message callback, filtered stats, first-frame callbacks (delivered/encrypted), decoder/encoder fallback callbacks, MLS failure callback, secure-frames state callback. Map these to a typed `VoiceController` in `packages/voice` so features are testable.
- **Ducking**: option `attenuateWhileSpeakingOthers` (+ attenuation factor) lowers other audio (including streams/soundshare) while others speak. Add as an app-level setting. A separate `dont_emit_volume_only_speaking_events` flag exists: speaking events fire on voice activity, not raw volume.
- **Spatial / distance attenuation**: binaural spatial mixer and a `calculateDistanceAttenuation` path for positional audio. Not needed for chat; reserve for proximity-voice activities (Phase D).
- **Clips**: settings `setClipBufferLength`, `setClipRecordUser`, `setClipsDataPath`, quality settings (resolution, fps), `saveClipEx` with a save timeout, a clips child process that can start late ("cold-spawn"), stats per clip (duration, size, save time, frames submitted/encoded/dropped), and a loudness/"dB score" for choosing highlight moments. For Jorcord: buffer length 30 s to 10 min, record-user toggle, save command, show a toast with the clip card; compute a simple loudness score to suggest highlights (optional).
- **Capture safety**: graphics capture is stopped when exclusive fullscreen is detected, and capture failures are reported to the UI; a media-thread watchdog stops the engine if the thread exits uncleanly. Implement equivalent "capture ended" events in the web/desktop layer.
- **Bandwidth adaptation** exposes percentages for bandwidth-limited / CPU-limited / quality-limited resolution; a "stream quality" tooltip can show the reason.

**`gpu_encoder_helper.exe` (Rust):** a helper process, launched with `--vendor` (`cuda`, `dx11`, `basic`, `nvidia`, `intel`, `amd`, `windows-media-foundation`), that *probes which codecs (H.264, H.265, AV1, 10-bit) a GPU vendor's encoder supports* out of process, so a driver crash cannot take down the app. Idea for Jorcord desktop: probe codec support in a sandboxed child process before offering "hardware encoding"; in the browser use `MediaCapabilities.encodingInfo` / `VideoEncoder.isConfigSupported` (WebCodecs).

**`audio_effects_helper.exe` (Rust):** takes a device GUID and configures a WASAPI client in raw mode (bypasses OS audio effects) with format negotiation (`preferred format`, closest match, WAVEFORMATEXTENSIBLE). Idea: a "disable OS audio enhancements for my mic" option (raw mode) on Windows; in the browser this is `getUserMedia` constraints (`echoCancellation`, `noiseSuppression`, `autoGainControl` all false).

**`discord_game_sdk_x64.dll` (Rust, public Game SDK):** exports `DiscordCreate`, `DiscordVersion`. Its strings show the **RPC command set the SDK uses**: `SET_ACTIVITY`, `ACTIVITY_INVITE_USER`, `ACCEPT_ACTIVITY_INVITE`, `SEND_ACTIVITY_JOIN_INVITE`, `CLOSE_ACTIVITY_JOIN_REQUEST`, `AUTHENTICATE`, `GET_APPLICATION_TICKET`, `GET_ENTITLEMENT_TICKET`, `START_PURCHASE`, `SET_VOICE_SETTINGS_2`, `SET_USER_VOICE_SETTINGS_2`, plus fields `session_id, channel_id, message_id` and voice `input_mode` = `PUSH_TO_TALK | VOICE_ACTIVITY`. Add to the local RPC subset in section 5.3 (skip ticket/purchase commands: no monetization): `SET_ACTIVITY`, `ACTIVITY_INVITE_USER`, `ACCEPT_ACTIVITY_INVITE`, `SEND_ACTIVITY_JOIN_INVITE`, `CLOSE_ACTIVITY_JOIN_REQUEST`, `AUTHENTICATE`, `GET_VOICE_SETTINGS`/`SET_VOICE_SETTINGS`, `GET_SELECTED_VOICE_CHANNEL`, `SUBSCRIBE`/`UNSUBSCRIBE`.

**`discord_modules.node`:** loader for the game-SDK/hook family; contains MinHook strings. Not applicable.

**`discord_dispatch.node` (Rust, 10 MB):** game **install/patch manager**: manifest-driven chunked downloads (`/builds/live`, `/download-signatures`, `/oauth2/token/builds`), pause/cancel/resume/repair, patch queue ("a patch is already processing"), entitlement checks, disk-space and permission errors, install scripts + launch options per platform, uninstall. A store feature; **out of scope** for Jorcord.

**`notificationstate.node`, `cld.node`:** third-party npm natives (`windows-notification-state` = Windows focus-assist / presentation-mode query; `cld` = Compact Language Detector used by spellcheck). Jorcord equivalents: respect OS Do-Not-Disturb when showing notifications (Tauri + Windows `SHQueryUserNotificationState`), and language detection for spellcheck is optional (browser spellcheck handles it).

**Coverage now:** all 9 first-pass binaries + 7 deep passes + dispatch, gpu_encoder_helper, audio_effects_helper, discord_modules, game SDK, notificationstate, cld. Not analysed: `discord_hook`, `DiscordHook(64).dll`, `DiscordHookHelper(64).exe`, `discord_overlay_sdk_*.dll`, `discord_aegis_*.dll`, `discord_desktop_overlay.node`, `mediapipe.dll` (Google open-source). These are overlay injection, anti-tamper and a public library, deliberately skipped because Jorcord will not implement those features.

### A.5 Public documentation index (for implementers)
`DD:resources/{soundboard,voice,lobby,poll,stage-instance,guild-scheduled-event,webhook,auto-moderation,audit-log,sticker,emoji,message,channel,user}`, `DD:activities/{how-activities-work,building-an-activity,development-guides/*}`, `DD:developer-tools/embedded-app-sdk`, `DD:rich-presence/{overview,best-practices,using-with-the-embedded-app-sdk}`, `DD:topics/{permissions,rate-limits,oauth2,voice-connections}`, `DD:events/{gateway,gateway-events,webhook-events}`, `DD:interactions/{application-commands,receiving-and-responding}`, `DD:components/{overview,reference}`, `DD:discord-social-sdk/*`, `DD:resources/application-role-connection-metadata`. Base: `https://github.com/discord/discord-api-docs/blob/main/discord-api-docs/docs/` (path prefix `developers/`).
