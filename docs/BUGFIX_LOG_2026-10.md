# Bugfix log, October 2026

Each entry: bug, root cause, fix, regression test.

## 1. Private-thread access survived leaving, kicking or banning (privacy)
- **Bug:** a member who left or was removed from a server kept their `thread_members` rows. After rejoining with an invite they could open every private thread they had been in, and they were still listed as thread members.
- **Root cause:** `removeMemberFromGuild` and the self-leave route only deleted the `members` row; private-thread visibility is decided by `thread_members`.
- **Fix:** removal now deletes the user's thread memberships in that guild.
- **Test:** `apps/server/test/bugfix-2026-10-a.test.ts`.

## 3. Group-DM kick and account erasure left the person in the LiveKit room (security)
- **Bug:** removing someone from a group DM call (or erasing an account) cleared the voice state but not the LiveKit participant, so they kept hearing and talking until their token expired.
- **Root cause:** `removeGroupRecipient` and the erase path called `clearVoiceState`, which does not talk to LiveKit; `disconnectMember` does.
- **Fix:** both use `disconnectMember`.
- **Test:** `apps/server/test/bugfix-2026-10-a.test.ts` (group DM kick).

## 4. Monthly event recurrence used server-local time and drifted (wrong behaviour)
- **Bug:** `nextOccurrences` for `monthly` rules used local-time getters and JS date overflow: Jan 31 became Mar 3, then Apr 3, Apr 6... and the hour shifted with the server time zone.
- **Root cause:** each step advanced from the previous (already overflowed) date.
- **Fix:** every occurrence is computed from the start date in UTC, with the day clamped to the month length.
- **Test:** `apps/server/test/bugfix-2026-10-a.test.ts` (monthly recurrence).

## 2. Leaving a server did not disconnect voice (security)
- **Bug:** `DELETE /users/@me/guilds/:id` removed the member but left their voice state and LiveKit participant in place (kick and ban already disconnected).
- **Root cause:** the leave route duplicated a subset of `removeMemberFromGuild`.
- **Fix:** the leave route calls `removeMemberFromGuild`, so kick, ban, leave and mod tools share one cleanup path.
- **Test:** `apps/server/test/bugfix-2026-10-a.test.ts`.
