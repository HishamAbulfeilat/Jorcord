# Server issues found while building the web client and e2e suite

Found against `apps/server` at the time of testing (another agent owns that directory; nothing here was changed by the web/e2e work).
Each item lists what was observed, how to reproduce it and the web-side workaround that is currently in place.

## 1. `READY.presences` never includes the current user
`apps/server/src/gateway/ws.ts` builds `presences` from *peers* only (`SELECT DISTINCT x.uid ... peers`), so right after IDENTIFY a user's
own entry is missing. Result: in the member list you appear OFFLINE to yourself (first screenshot of a fresh server shows "OFFLINE - 1 / Alice").
Repro: register, create server, open the member list.
Workaround: web `applyReady` seeds `presences[me.id]` (`apps/web/src/stores/data.ts`). Proper fix: include the user in `presences`.

## 2. A user who joins a guild is not announced as online to the guild's existing members
Alice (already in the guild) sees Bob as OFFLINE after Bob accepts the invite while connected; the member list only corrects itself on Alice's next READY
(page reload). Bob's gateway session was IDENTIFYed before he was a member, so `broadcastPresence` had no audience, and `MEMBER_ADD` is not followed by a
`PRESENCE_UPDATE` for the new member.
Repro: two browsers, Alice creates server, Bob opens `/invite/<code>` and accepts; Alice's member list shows Bob offline.
Same root cause for friends: after Bob accepts Alice's friend request, Alice's friends list shows Bob as "Offline" while he is online, because no `PRESENCE_UPDATE` is sent when a relationship is created/accepted.
Suggested fix: after a join (`POST /invites/:code`, member add) call `hub.broadcastPresence(newMember)` (and send the guild's current presences to the joiner).

## 3. Mention counts are tracked on both sides
`services/messages.ts` increments `read_states.mention_count` and pushes `READ_STATE_UPDATE` while the web client also bumps its local counter on
`MESSAGE_CREATE`. It converges because the server event overwrites the local value, but the badge can briefly show 2. Not blocking; documented so the
two do not drift (the client could just wait for `READ_STATE_UPDATE`).

## 4. LiveKit token grants (`POST /voice/token`)
* The grant lacks `canUpdateOwnMetadata`. The client library (`@jorcord/voice`) sets participant *attributes* for "priority speaker" and the legacy hand-raise;
  LiveKit rejects `setAttributes` without that grant. The web client now uses the REST stage API for hand raise, but priority speaker (`PRIORITY_SPEAKER`)
  cannot work until `canUpdateOwnMetadata: true` is added to `addGrant`.
* `caps.canStream` is true for non-stage voice channels whenever `Perm.STREAM` is set, which is fine, but there is no cap on stream resolution/bitrate at
  token level (`LIMITS.stream` is only enforced client-side). Consider `canPublishSources` + a LiveKit egress/room limit if this must be enforced.

## 5. (Unverified) Voice state cleared when the last gateway socket closes
`gateway/ws.ts` calls `clearVoiceState` in the `close` handler once `sessionDetached` reports no attached sessions. If `sessionDetached` does not apply the
5 minute resume window, a flaky network drops the user from the voice list for everyone although their LiveKit connection survives. The web client
re-announces its voice state after the next `READY`, so it recovers, but other users would see a leave+join flicker. Please confirm the grace period is applied.

## 6. Needs from the web UI work (new features)
* **Join a DISCOVERABLE guild without an invite.** `GET /discover/guilds` lists them but there is no join endpoint. The Discover page joins via the guild's `vanityUrl` (`POST /invites/:vanity`); guilds without one show an error. Proposed: `POST /guilds/:id/join` (200 `GuildFull`, 404 unless `DISCOVERABLE`, same ban/limit checks as `POST /invites/:code`). The web client already calls it as a fallback (`api.guilds.joinDiscoverable`).
* **No gateway events for stickers** (`STICKERS_UPDATE`) and no `PUT/DELETE` push on stickers; the web client re-fetches `GET /guilds/:id/stickers` when a message references an unknown sticker. Stickers can only be sent from the message's own guild (server filters by guild).
* **Onboarding / rules screening is client-side only.** The welcome + rules modal is driven by `description` / `rulesChannelId` and a per-user acknowledgement kept in `users.settings.layout.onboarded`. The server does not gate posting until rules are accepted (Discord's "pending" member state). Proposed: `members.pending` flag + `PUT /guilds/:id/members/@me/screening`.
* **Profile themes are a single `accentColor`** (`#rrggbb`); the web client derives a gradient and tint from it. A real two-colour theme would need `themeColors: [string, string]` on `User` (visible to others, unlike `settings`).
* **Rail order / folders** are stored in `users.settings.layout` (PATCH `/users/@me {settings}` replaces the whole object, the client merges). Fine, but a dedicated `guild_order` would avoid clobbering concurrent settings writes.
* **Custom status expiry** is client-side (`settings.layout.statusExpiresAt`); it only clears while a client of that user is running. Proposed: `customStatus.expiresAt` enforced server side.
* Push payload fields used by the web service worker / Capacitor handler: `{kind,title,body,tag,channelId,guildId,messageId}`; FCM `data` must carry `channelId`/`guildId` (it does).
