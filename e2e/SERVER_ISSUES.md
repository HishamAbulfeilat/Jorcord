# Server issues found while building the web client and e2e suite

Found against `apps/server` at the time of testing (another agent owns that directory; nothing here was changed by the web/e2e work).
Each item lists what was observed, how to reproduce it and the web-side workaround that is currently in place.

## 1. (Resolved: `buildReady` adds the user's own entry) `READY.presences` never includes the current user
`apps/server/src/gateway/ws.ts` builds `presences` from *peers* only (`SELECT DISTINCT x.uid ... peers`), so right after IDENTIFY a user's
own entry is missing. Result: in the member list you appear OFFLINE to yourself (first screenshot of a fresh server shows "OFFLINE - 1 / Alice").
Repro: register, create server, open the member list.
Workaround: web `applyReady` seeds `presences[me.id]` (`apps/web/src/stores/data.ts`). Proper fix: include the user in `presences`.

## 2. (Resolved: `announceJoin` after joins, `PRESENCE_UPDATE` on friend accept) A user who joins a guild is not announced as online to the guild's existing members
Alice (already in the guild) sees Bob as OFFLINE after Bob accepts the invite while connected; the member list only corrects itself on Alice's next READY
(page reload). Bob's gateway session was IDENTIFYed before he was a member, so `broadcastPresence` had no audience, and `MEMBER_ADD` is not followed by a
`PRESENCE_UPDATE` for the new member.
Repro: two browsers, Alice creates server, Bob opens `/invite/<code>` and accepts; Alice's member list shows Bob offline.
Same root cause for friends: after Bob accepts Alice's friend request, Alice's friends list shows Bob as "Offline" while he is online, because no `PRESENCE_UPDATE` is sent when a relationship is created/accepted.
Suggested fix: after a join (`POST /invites/:code`, member add) call `hub.broadcastPresence(newMember)` (and send the guild's current presences to the joiner).

## 3. (Documented, intentional) Mention counts are tracked on both sides
`services/messages.ts` increments `read_states.mention_count` and pushes `READ_STATE_UPDATE` while the web client also bumps its local counter on
`MESSAGE_CREATE`. It converges because the server event overwrites the local value, but the badge can briefly show 2. Not blocking; documented so the
two do not drift (the client could just wait for `READ_STATE_UPDATE`).

## 4. (Resolved: `canUpdateOwnMetadata: true` is granted; stream caps stay client-side) LiveKit token grants (`POST /voice/token`)
* The grant lacks `canUpdateOwnMetadata`. The client library (`@jorcord/voice`) sets participant *attributes* for "priority speaker" and the legacy hand-raise;
  LiveKit rejects `setAttributes` without that grant. The web client now uses the REST stage API for hand raise, but priority speaker (`PRIORITY_SPEAKER`)
  cannot work until `canUpdateOwnMetadata: true` is added to `addGrant`.
* `caps.canStream` is true for non-stage voice channels whenever `Perm.STREAM` is set, which is fine, but there is no cap on stream resolution/bitrate at
  token level (`LIMITS.stream` is only enforced client-side). Consider `canPublishSources` + a LiveKit egress/room limit if this must be enforced.

## 5. (Verified: `clearVoiceAfterGrace` applies `voiceGraceMs`) Voice state cleared when the last gateway socket closes
`gateway/ws.ts` calls `clearVoiceState` in the `close` handler once `sessionDetached` reports no attached sessions. If `sessionDetached` does not apply the
5 minute resume window, a flaky network drops the user from the voice list for everyone although their LiveKit connection survives. The web client
re-announces its voice state after the next `READY`, so it recovers, but other users would see a leave+join flicker. Please confirm the grace period is applied.

## 6. (Resolved by the platform pass) Needs from the web UI work
* Discoverable guild join: `POST /discover/guilds/:id/join` exists now and the Discover page uses it (vanity code only as a fallback for older servers).
* `STICKERS_UPDATE` is consumed by the web client; membership screening (`Member.pending`, `PUT /guilds/:id/members/@me/screening`) replaces the client-only onboarding gate for screened servers.

## 7. (Resolved by the hardening pass: empty JSON bodies -> {}, poll vote events carry `count`/`totalVotes`, global command events go to installed guilds, `locked` blocks posting for non-moderators; see docs/CONTRACT.md) Found while building the platform UI (`apps/web`, `e2e/tests/*`)
* **Empty JSON bodies are rejected.** Any POST/PUT/DELETE sent with `content-type: application/json` and no body (e.g. `POST /applications/:id/bot/reset-token` from a generic HTTP client or `curl -H 'content-type: application/json'`) fails with 400 `FST_ERR_CTP_EMPTY_JSON_BODY` instead of being treated as `{}`. The web client only sets the header when it sends a body, so it is unaffected; bot libraries that always set it would not be. Suggest a content-type parser that maps an empty body to `{}` (Discord tolerates it).
* **Poll vote events do not carry `totalVotes`.** `Message.poll.totalVotes` is the number of *distinct voters* (the percent base), but `MESSAGE_POLL_VOTE_ADD|REMOVE` only name one answer, so a client cannot keep the total exact when people pick several answers. The web client applies the answer count immediately and re-reads the message ~250 ms later. Adding `totalVotes` (and ideally the answer's new `count`) to the event payload would remove that round trip.
* **`MESSAGE_UPDATE` for polls is a broadcast**, so `meVoted` in it is never the viewer's. The web client keeps its own `meVoted` marks when merging such an update (and replaces them only from the viewer's own `PUT .../votes` response). Worth documenting in CONTRACT.md.
* **Global application commands emit no gateway event** (only guild commands do), so a client cannot learn that a bot registered `/foo` globally. The composer re-reads `GET /guilds/:id/application-commands` when someone starts typing `/` and the catalog is older than 3 s.
* **`locked` only matters once a thread is archived** (non-moderators get 403 on posting/unarchiving then). The web UI follows that (Discord semantics): an open locked thread still takes messages, and the banner explains the lock.
* The 3 s acknowledge window has no event for a *successful* silent ack (callback type 6, deferred update); the web client stops the button spinner after 3.5 s on its own.

## 5. Command permissions page cannot list a non-owner manager's apps' guild commands
`GET /applications/:app/guilds/:gid/commands` requires the app's bot token or its owner, but the permissions endpoints are for guild managers
(MANAGE_GUILD + MANAGE_ROLES) on a user session. The web "Command Permissions" settings page therefore builds its command list from
`GET /guilds/:id/application-commands` (what the caller may *run*), so a command that the manager is currently denied (and is not an administrator)
does not appear and cannot be edited back. Suggested fix: allow guild managers to list the installed app's commands in that guild
(read-only), or add `?all=1` for MANAGE_GUILD+MANAGE_ROLES callers on `/guilds/:id/application-commands`. The app-wide default row ("All commands") is unaffected.

## 6. Locked thread rejects messages from non-moderators (e2e `forum.spec.ts` "thread lifecycle" fails at HEAD)
The test (and the in-app banner "This thread is locked: once it is archived only moderators can reopen it.") expects an *open* locked thread to keep
accepting messages from regular members (only unarchiving is restricted). Bob's `still talking` send fails ("Failed to send") against the current
server. Fails identically with the web changes stashed, so it is a server/test contract mismatch rather than a regression.
