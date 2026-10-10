# Parity TODO: Discord features not yet in Jorcord

Scope: "everything Discord has except the paywall". Nitro payments, Server Subscriptions, shop/SKUs, Lobbies/Social SDK and parental "Family Center" are out of scope. Everything else is free for everyone.
Companion to `PARITY.md` (API/platform gaps) and `CONTRACT.md` (what is implemented). Status: done / partial / todo. "Notice" = how much ordinary users notice (5 = daily, 1 = rare). Voice items belong to the voice owner and are listed for completeness only.
Rank = order in which this pass implements items (R1 first). `-` = not planned in this pass.

## A. Ranked list (what users notice most)

| Rank | Feature | Status | Notice | Evidence / notes |
|---|---|---|---|---|
| R1 | Inbox / recent mentions panel | DONE (`routes/social.ts`, `SocialModals.tsx`) | 5 | `FriendsHome.tsx` Inbox button has no handler; no mentions query endpoint |
| R2 | Privacy: who can DM you, friend-request controls, message requests for non-friends | DONE (`routes/social.ts`, `services/privacy.ts`, `PrivacyTab.tsx`, `DmSidebar.tsx`) | 5 | `POST /users/@me/channels` only checks friend-or-shared-server; no settings |
| R3 | User notes (private note on a profile) + mutual friends on profiles | DONE (`routes/social.ts`, `Profile.tsx`) | 4 | mutual servers done (`routes/users.ts` GET /users/:id); `mutualFriends` typed in `lib/api.ts` but never sent; no notes |
| R4 | Message forwarding | DONE (`routes/messages.ts`, `SocialModals.tsx`, `MessageItem.tsx`) | 4 | no `forward` in messages; no snapshot model |
| R5 | Message reminders ("Remind me") + saved messages ("Saved for later") | DONE (`routes/social.ts`, `services/reminders.ts`, Inbox tabs) | 3 | no table/route |
| R6 | Verification levels, raid protection, explicit-media filter, default notification level (Safety Setup) | todo | 4 | `Guild` has none; screening only |
| R7 | AutoMod: keyword presets, mention-spam limit, allow-list, exempt channels, timeout length, custom message | DONE (`services/automod.ts`, `GuildSettings.tsx`); alert channel and regex still todo | 3 | 4 triggers, `exemptRoles` only (`routes/guilds.ts` automod, `services/messages.ts`) |
| R8 | Avatar decorations, profile effects, name plates, server tag (guild tag beside name) | todo | 4 | only accent/banner/`themeColors` (`profileTheme.ts`) |
| R9 | Activities / rich presence (Playing X, Listening, Streaming, Competing) shown in member list, profile and friends "Now Playing" | todo | 4 | `PRESENCE_UPDATE` has status+customStatus only |
| R10 | Activity privacy (hide activity), Hide muted channels, sidebar "Show all/Hide" | todo | 3 | no setting |
| R11 | Announcement channels: follow + crosspost | todo | 3 | channel type exists, no routes |
| R12 | NSFW age-gate interstitial | DONE (`services/agegate.ts`, `ChatView.tsx` AgeGate) | 3 | `nsfw` flag stored, no gate in web |
| R13 | Server welcome screen (channel list) + onboarding questions (channels & roles prompts) | partial | 3 | rules screening + welcome modal done (`ExtraModals.tsx` OnboardingModal); no questions/default channels |
| R14 | User-created guild templates (share code), widget, vanity URL claim UI, server insights/analytics | partial/todo | 2 | built-in presets only (`services/guilds.ts`); vanity PATCH exists |
| R15 | GIF favorites, saved media | todo | 3 | `GET /gifs/*` only |
| R16 | Account switching (multi-account) | todo | 3 | single session store (`lib/session.ts`) |
| R17 | Connections on profile (links to Twitch/GitHub...) | todo | 2 | none |
| R18 | Soundboard (guild sounds + play in voice) | todo | 4 | `USE_SOUNDBOARD` bit only; UI part lives in voice (other agent) |
| R19 | Message edit history | todo | 1 | `edited_at` only; Discord itself does not show history, skip |
| R20 | Server boost levels page perks list | partial | 2 | boosts free/unlimited (`GuildSettings` boosts tab) |
| R21 | Linked roles, integrations (Twitch/YouTube), app directory | todo | 1 | skip |
| R22 | Mod view / member safety flags, bulk-ban, prune | todo | 2 | ban/kick/timeout done |

## B. Already done (verified in this pass)

Mark unread (`lib/menus.ts` messageMenu), mark server/folder/channel read, server folders, quick switcher, polls, scheduled events, stages, forum tags, threads (auto-archive/lock), slash commands + autocomplete, bots/OAuth2, custom status + expiry, two-colour profile themes, push-to-talk and per-user volume (voice), keybind settings + shortcuts modal, member search, ban + message deletion, timeouts, audit log, per-channel notification settings, spoilers, mentions highlighting, membership screening (rules), welcome modal, discovery, invites, webhooks, emoji/stickers, i18n.

## C. Implementation log

Updated as items land (see git log, prefix `parity:`).
