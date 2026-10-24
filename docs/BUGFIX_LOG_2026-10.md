# Bugfix log, October 2026

Each entry: bug, root cause, fix, regression test.

## 1. Private-thread access survived leaving, kicking or banning (privacy)
- **Bug:** a member who left or was removed from a server kept their `thread_members` rows. After rejoining with an invite they could open every private thread they had been in, and they were still listed as thread members.
- **Root cause:** `removeMemberFromGuild` and the self-leave route only deleted the `members` row; private-thread visibility is decided by `thread_members`.
- **Fix:** removal now deletes the user's thread memberships in that guild.
- **Test:** `apps/server/test/bugfix-2026-10-a.test.ts`.

## 2. Leaving a server did not disconnect voice (security)
- **Bug:** `DELETE /users/@me/guilds/:id` removed the member but left their voice state and LiveKit participant in place (kick and ban already disconnected).
- **Root cause:** the leave route duplicated a subset of `removeMemberFromGuild`.
- **Fix:** the leave route calls `removeMemberFromGuild`, so kick, ban, leave and mod tools share one cleanup path.
- **Test:** `apps/server/test/bugfix-2026-10-a.test.ts`.
