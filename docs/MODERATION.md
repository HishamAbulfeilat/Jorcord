# Moderation tools (package F)

Built from what moderators complain about: thin audit logs, kicks that drop roles, members who never learn why, no quiet way to flag a message, no edit history, toxic content with no way to hide it short of deleting, burnout, ban evasion. Migrations 150 and 151. Code: `services/{auditDiff,auditQuery,roleMemory,modNotices,reports,sensitive,evasion,modSettings}.ts`, `routes/modsuite.ts` (new), `routes/modtools.ts` (reports), pure logic and wire types in `packages/shared/src/moderation.ts`. Tests: `apps/server/test/moderation-suite.test.ts`, `packages/shared/src/moderation.test.ts`, web tests next to the components in `components/moderation/`.

What already existed and was kept: audit log, Mod View, warnings and notes, bulk ban/kick, prune, mod-log CSV, reports queue, ban appeals (`routes/appeals.ts`), AutoMod, message edit history storage (`message_edits`).

## Server settings

`GET /guilds/:id/mod-settings` (any moderator) and `PATCH` (MANAGE_GUILD, audited as `MOD_SETTINGS_UPDATE` with a diff). Stored in `guilds.mod_settings`, always normalised and clamped.

| Setting | Default |
| --- | --- |
| `rememberRoles { enabled, onKick, onLeave, days 1-30 }` | on, on for kicks, off for leaves, 7 days |
| `notices { enabled, showModerator, appealLink }` | on, moderator hidden, appeal link on |
| `evasion { enabled }` | off |
| `retention { auditDays 30-730 or null, editDays 1-365 or null }` | null = keep forever (nothing is deleted unless a server asks) |
| `wellbeing { blurMedia }` | on |

## 1. Audit log detail

* `audit()` takes an optional `diff = { before, after }` holding exactly the fields that changed (`audit_log.diff`). `changes` keeps the request payload as before. Covered: server settings, role create/update/delete/reorder (permission bitfields), channel update/delete, permission overwrites update/delete, member nickname, member roles, timeouts, safety settings, AutoMod rule update, emoji update, moderation settings, roles restored on rejoin, sensitive marks.
* `GET /guilds/:id/audit-logs` filters (all optional, ANDed): `actorId`, `action`, `actionType`, `targetId`, `from`, `to` (ISO), `q` (text over reason, action, changes and diff, searched in the newest 20,000 matching rows, 30/min), `before`, `limit`. Entries carry `diff`.
* `GET /guilds/:id/audit-logs.csv` takes the same filters (up to 10,000 rows, 5/min, formula-safe cells). Columns include `changes`, `before`, `after`.
* Retention: the sweeper deletes entries older than `retention.auditDays` in batches of 5,000.
* Web: Server Settings, Audit Log: filter bar, expandable diff (added/removed permission names, role names, old to new values), Load more, Export CSV.

## 2. Remember roles on rejoin

* On a kick (`DELETE /guilds/:id/members/:userId?reason=&rememberRoles=true|false&notify=true|false`) roles and any running timeout are stored in `member_role_memory` for `days`. A member who leaves while timed out has the timeout kept even when role memory is off, so leaving and rejoining does not clear a timeout. Leaves store roles only with `onLeave`.
* On join (`joinGuild`) the memory is consumed once and re-checked against the server as it is now (`restorableRoles`). A role is skipped when it no longer exists, is server-managed (booster, linked, bot), has gained permissions since it was remembered ("never escalates"), or, when a moderator removed the member, sits at or above that moderator's top role or carries permissions the moderator lacks today. If the moderator is gone or the member left on their own, privileged roles (administrator, manage-anything, kick, ban, moderate, mention everyone, view audit log) are not restored. Owner and administrator moderators may restore anything that was held.
* The audit entry `MEMBER_ROLES_RESTORED` lists what came back and what was skipped.
* Web: the kick dialog has a "Remember their roles" switch (default from the server setting), Server Settings, Moderation has the settings.

## 3. Reasons shown to the removed member

* Kick, ban (`PUT /bans/:id` accepts `notify`), timeout (`PATCH members` accepts `reason`) and bulk kick/ban create a row in `mod_notices` and send the gateway event `MOD_NOTICE` to that user. `GET /users/@me/mod-notices` lists them, `POST /users/@me/mod-notices/read` marks them read. Bans carry `appeal: true` (unless `appealLink` is off), which the web client turns into a button to Settings, Privacy & Safety, where the existing appeal flow lives.
* The moderator's identity is stored and sent only if `showModerator` is on. Limits: 3 notices per member per server per day, 60 per server per hour; refused silently, the moderation action itself always goes through. A moderator can untick "Tell them why" per action. Notices older than 90 days are deleted.

## 4. Anonymous reports

* `POST /channels/:id/messages/:mid/report { reason, description?, anonymous? }`. Any reader of a server channel may report (the web menu item is "Report to moderators" for everyone, not only moderators). `anonymous: true` hides the reporter from moderators as well: the queue returns `reporterId: null` and the audit entry uses the actor `anonymous`. Other members never see reporters. The reporter id is still stored (needed for dedupe and throttling) and is never returned to the server's staff when anonymous.
* A snapshot of the message (text and attachments) is stored with the report, so edits or deletion later do not change what was reported.
* Dedupe: further reports of a message that already has an open case fold into it (`reportCount`); the same person cannot report twice while it is open (409).
* Triage: `PATCH /guilds/:id/reports/:rid { status, action? }`, `action` is one of `delete_message`, `mark_sensitive`, `warn`, `timeout` (60 minutes) and only goes with `resolved`. Each action needs its own permission (MANAGE_MESSAGES or MODERATE_MEMBERS plus the role hierarchy) and is checked before the report changes. Resolving or dismissing applies to the whole case.
* Abuse resistance: 10 reports/hour/user as before; 5 reports/day against one member; a reporter whose last 14 days hold at least 5 dismissed reports and at least 80 percent dismissed gets 2 reports per day (`429 REPORT_THROTTLED`).
* The queue is the dashboard (the reports panel and modal). `GUILD_REPORTS_UPDATE` refreshes it live. A channel feed was not built.

## 5. Edit history and sensitive marks

* `GET /channels/:id/messages/:mid/edits` is now limited to the author and members with MANAGE_MESSAGES (it used to be anyone who could read the message). The oldest entry is the original text. A moderator reading someone else's history writes `MESSAGE_EDIT_HISTORY_VIEW`. Retention: `retention.editDays`. The "(edited)" link and a "View edit history" menu item only appear for the author and moderators.
* `PUT /channels/:id/messages/:mid/sensitive` and `DELETE` set and clear `MessageFlags.SENSITIVE` (bit 1 << 20). Moderators (MANAGE_MESSAGES) may mark any server message, authors their own; only moderators clear. Text and attachments are kept, there is no edit history row and no `editedAt`; audit `MESSAGE_SENSITIVE_SET` / `_CLEAR`. Clients blur the whole message behind "Sensitive content. Click to show".

## 6. Ban-evasion hints

Off by default (`evasion.enabled`). When a member joins, they are compared with the server's bans from the last 90 days using only what the accounts show:

| Signal | Weight |
| --- | --- |
| Name or display name identical after look-alike folding | 45 |
| Name very close (edit distance 1 or 2) | 35 |
| Same avatar | 30 |
| Account created 0 to 14 days after the ban | 20 |
| Same invite code (`members.joined_via`, copied to `bans.joined_via`) | 15 |

A hint is created at 45 or more, so an invite match or timing alone never flags anyone. **No IP address and no device fingerprint is collected or compared.** Hints go to `evasion_hints`; `GET /guilds/:id/evasion-hints?status=` and `PATCH .../:hid { status: 'dismissed' | 'confirmed' }` (any moderator). A hint refreshes the queue and pings moderators like a report; it never bans or restricts anyone. Weights and threshold are constants in `moderation.ts` and are heuristics: expect false positives for common names.

## 7. Moderator wellbeing

* Media in the report queue is blurred until clicked (server default `wellbeing.blurMedia`, per-moderator override).
* `GET/PUT /guilds/:id/mod-prefs { blurMedia, quietStart, quietEnd, tzOffset }` (minutes after local midnight; the window may wrap midnight; both ends or neither). During quiet hours the moderator does not get the content-free `MOD_REPORT_PING` (a toast in the web client); the queue still updates and the report waits.

## Known limits

* Quiet hours silence the in-app ping only; web push for reports does not exist yet.
* Audit diffs are not recorded for webhooks, voice moderation, emoji/sticker creation (a creation has no "before") or actions by other services; those entries still carry `changes`.
* Role restore does not restore nicknames.
* Sensitive marks are enforced by clients (blur); the API still returns the content, as for Discord's spoiler-style marks.
