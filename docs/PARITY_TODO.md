# Parity TODO: Discord features not yet in Jorcord

Scope: "everything Discord has except the paywall". Nitro payments, Server Subscriptions, shop/SKUs, Lobbies/Social SDK and parental "Family Center" are out of scope. Everything else is free for everyone.
Companion to `PARITY.md` (API/platform gaps) and `CONTRACT.md` (what is implemented). Status: done / partial / todo. "Notice" = how much ordinary users notice (5 = daily, 1 = rare). Voice items belong to the voice owner and are listed for completeness only.
Rank = order in which this pass implements items (R1 first). `-` = not planned in this pass.

## A. Ranked list (what users notice most)

| Rank | Feature | Status | Notice | Evidence / notes |
|---|---|---|---|---|
| R1 | Inbox / recent mentions panel | DONE (`routes/social.ts`, `SocialModals.tsx`, `FriendsHome.tsx`, `ChatView.tsx`, `ModalHost.tsx`) | 5 | mentions query + inbox tabs wired; Inbox button in FriendsHome and ChatView header both open the modal |
| R2 | Privacy: who can DM you, friend-request controls, message requests for non-friends | DONE (`routes/social.ts`, `services/privacy.ts`, `PrivacyTab.tsx`, `DmSidebar.tsx`) | 5 | `POST /users/@me/channels` only checks friend-or-shared-server; no settings |
| R3 | User notes (private note on a profile) + mutual friends on profiles | DONE (`routes/social.ts`, `Profile.tsx`) | 4 | mutual servers done (`routes/users.ts` GET /users/:id); `mutualFriends` typed in `lib/api.ts` but never sent; no notes |
| R4 | Message forwarding | DONE (`routes/messages.ts`, `SocialModals.tsx`, `MessageItem.tsx`) | 4 | no `forward` in messages; no snapshot model |
| R5 | Message reminders ("Remind me") + saved messages ("Saved for later") | DONE (`routes/social.ts`, `services/reminders.ts`, Inbox tabs) | 3 | no table/route |
| R6 | Verification levels, raid protection, explicit-media filter, default notification level (Safety Setup) | DONE (`routes/safety.ts`, `services/safety.ts`, `SafetyTab.tsx`; media filter blurs instead of classifying) | 4 | `Guild` has none; screening only |
| R7 | AutoMod: keyword presets, mention-spam limit, allow-list, exempt channels, timeout length, custom message | DONE (`services/automod.ts`, `lib/saferegex.ts`, `AutoModTab.tsx`; alert channel, safe-regex, 4 more triggers, multi-action, test mode) | 3 | 4 triggers, `exemptRoles` only (`routes/guilds.ts` automod, `services/messages.ts`) |
| R8 | Avatar decorations, profile effects, name plates, server tag (guild tag beside name) | DONE (`services/cosmetics.ts`, `cosmetics.css`, `CosmeticsPicker.tsx`; 8 decorations, 10 effects, all original CSS) | 4 | only accent/banner/`themeColors` (`profileTheme.ts`) |
| R9 | Activities / rich presence (Playing X, Listening, Streaming, Competing) shown in member list, profile and friends "Now Playing" | DONE (`routes/activities.ts`, `ActivityLine.tsx`, bot-sdk `setActivity`) | 4 | `PRESENCE_UPDATE` has status+customStatus only |
| R10 | Activity privacy (hide activity) DONE; Hide muted channels DONE (`channelHide.ts`), onboarding "Browse Channels" toggle DONE | 3 | no setting |
| R11 | Announcement channels: follow + crosspost | DONE (`routes/follows.ts`, `FollowsList.tsx`, `FollowChannelModal`) | 3 | channel type exists, no routes |
| R12 | NSFW age-gate interstitial | DONE (`services/agegate.ts`, `ChatView.tsx` AgeGate) | 3 | `nsfw` flag stored, no gate in web |
| R13 | Server welcome screen (channel list) + onboarding questions (channels & roles prompts) | DONE (`routes/onboarding.ts`, `OnboardingModals.tsx`, `OnboardingTab.tsx`) | 3 | rules screening + welcome modal done (`ExtraModals.tsx` OnboardingModal); no questions/default channels |
| R14 | User-created guild templates (share code), widget, vanity URL claim UI, server insights/analytics | DONE (`routes/guildextras.ts`, `services/templates.ts`, `ServerExtrasTabs.tsx`, `TemplatePage.tsx`) | 2 | built-in presets only (`services/guilds.ts`); vanity PATCH exists |
| R15 | GIF favorites, saved media | DONE (`routes/favorites.ts`, `gifFavorites.ts`, EmojiPicker Favorites tab) | 3 | `GET /gifs/*` only |
| R16 | Account switching (multi-account) | DONE (`lib/accounts.ts`, `AccountsSection.tsx`, status menu) | 3 | single session store (`lib/session.ts`) |
| R17 | Connections on profile (links to Twitch/GitHub...) | DONE (`routes/connections.ts`, `ConnectionsTab.tsx`; self-declared + verify-by-code, no third-party OAuth) | 2 | none |
| R18 | Soundboard (guild sounds + play in voice) | DONE (`routes/soundboard.ts`, `components/Soundboard.tsx`) | 4 | upload/limits, play over gateway event, USE_SOUNDBOARD, per-user + global mute, voice dock button |
| R19 | Message edit history | DONE (migration `031_edit_history.sql`, `GET /channels/:id/messages/:mid/edits` in `routes/messages.ts`, `parity-edit-history.test.ts`) | 1 | prior contents are kept on every edit; the original note to skip it was reversed later |
| R20 | Server boost levels page perks list | DONE (`routes/guilds.ts`, `services/boosts.ts`, `BoostTab.tsx`; levels 1-3, enforced emoji/sticker slots, progress, boosters, booster role, announcements) | 2 | boosts free/unlimited (`GuildSettings` boosts tab) |
| R21 | Linked roles, app directory (Twitch/YouTube integrations skipped on purpose, see `PARITY.md`) | DONE (`routes/linkedroles.ts`, `services/linkedroles.ts`, `LinkedRolesTab.tsx`, `routes/directory.ts`, `AppDirectory.tsx`, Developer Portal listing; bot metadata API) | 1 | criteria: account/join age, messages, verified connection, app metadata |
| R22 | Mod view / member safety flags, bulk-ban, prune, warnings, mod notes, mod-log CSV | DONE (`routes/modtools.ts`, `ModView.tsx`, `ModToolsTab.tsx`, composer `/warn`) | 2 | ban/kick/timeout were already done |
| R23 | Scheduled message sends (compose now, post later, list and cancel) | DONE (migration `060_scheduled_messages.sql`, `routes/scheduledMessages.ts`, `services/scheduledMessages.ts`, `ScheduleModal.tsx`, Inbox > Scheduled) | 3 | text only; permissions, DM blocks and slowmode re-checked at send time |
| R24 | Components V2 layout messages for bots | DONE (`lib/components.ts`, `chat/ComponentsV2.tsx`, bot-sdk builders) | 2 | webhook execute does not accept V2 |
| R25 | External-link confirmation (trusted domains per user) and risky-file warning | DONE (`lib/links.ts`, `LinkGuard.tsx`, `LinkSafetyPanel.tsx`) | 3 | |
| R26 | Desktop: native clipboard, keychain token storage, idle and wake presence | DONE, unverified at runtime (`apps/desktop/src-tauri/src/lib.rs`, `lib/native.ts`, `lib/idle.ts`) | 2 | `cargo check` on Linux only; Windows/macOS idle code and the real keychain not run |

## B. Already done (verified in this pass)

Mark unread (`lib/menus.ts` messageMenu), mark server/folder/channel read, server folders, quick switcher, polls, scheduled events, stages, forum tags, threads (auto-archive/lock), slash commands + autocomplete, bots/OAuth2, custom status + expiry, two-colour profile themes, push-to-talk and per-user volume (voice), keybind settings + shortcuts modal, member search, ban + message deletion, timeouts, audit log, per-channel notification settings, spoilers, mentions highlighting, membership screening (rules), welcome modal, discovery, invites, webhooks, emoji/stickers, i18n.

## C. Implementation log

Updated as items land (see git log, prefix `parity:`).

Second pass (soundboard through multi-account), one commit each, prefix `parity:`:
1. Soundboard (R18): `routes/soundboard.ts`, gateway `VOICE_CHANNEL_EFFECT_SEND` to the people in the voice channel (no LiveKit track, so voice reconnect is untouched), `components/Soundboard.tsx` (voice dock button, settings tab, per-user/global mute).
2. Activities (R9, R10 activity privacy): `routes/activities.ts`, `PRESENCE_UPDATE.activities`, bot-sdk `setActivity`.
3. Cosmetics (R8): free CSS catalog (`cosmetics.css`), `services/cosmetics.ts`, server tags.
4. Safety Setup (R6): verification levels, raid protection, media blur (no classifier), default notifications.
5. Onboarding questions + Hide Muted Channels (R13, R10).
6. Announcement follow/crosspost (R11).
7. Templates, widget, insights, vanity UI (R14).
8. GIF favorites (R15). 9. Connections (R17, self-declared + verify by code). 10. Multi-account (R16).
Third pass (R7 AutoMod v3, R20 boost levels, R21 linked roles + App Directory, R22 mod tools): all done. R19 (edit history) landed later, see the table.
Fourth pass: message search filters (`has` incl. video, `mentions`, `author_id`, `before`/`after` by snowflake or ISO date, `sort_by`/`sort_order`; `services/search.ts`, `lib/searchTokens.ts`): done. No new migration: `mentions` reuses the GIN index from 009.
