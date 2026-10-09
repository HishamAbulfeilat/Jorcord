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
