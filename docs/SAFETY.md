# Safety and anti-abuse protections

What Jorcord does about the most common abuse (scam DMs, look-alike accounts and servers, bots scraping members, raids). Everything below is enforced on the server; the web app only displays it. Nothing calls an external reputation service.

## Where the code lives

| Protection | Server | Shared (pure, also used by the web app) | Tests |
| --- | --- | --- | --- |
| Raid protection, verification levels, media filter, invite pause | `services/safety.ts`, `routes/safety.ts` | | `test/parity-safety.test.ts` |
| Member DM policy | `services/memberDms.ts`, `routes/safety.ts`, `routes/users.ts`, `services/dms.ts` | | `test/trust-safety.test.ts` |
| Scam / phishing link scoring | `services/linkrisk.ts`, `services/automod.ts`, `services/serializers.ts` | `packages/shared/src/trust.ts` | `trust.test.ts`, `test/trust-safety.test.ts` |
| Impersonation guard | `services/impersonation.ts`, `routes/safety.ts`, `routes/modtools.ts` | `trust.ts` | `test/trust-safety.test.ts` |
| Mass-DM detection | `services/massdm.ts`, `services/messages.ts`, `routes/admin.ts` | `trust.ts` | `test/trust-safety.test.ts` |
| Account-age hint | | `accountAge()` in `trust.ts`, `components/ui/TrustBits.tsx` | `TrustBits.test.tsx` |

Migrations 080 to 083 add the columns and tables (`guilds.member_dms_restricted_at`, `members.dm_optin`, `guilds.link_allow/link_deny`, `guilds.impersonation_guard`, `members.impersonation_flag/safety_hold`, `users.dm_limited_until`, `dm_request_events`, `mass_dm_incidents`).

## 1. Members may DM each other (per server)

Server Settings, Safety Setup, "Direct messages between members".

* Default is open, which is the old behaviour. Switching it to opt-in sets `member_dms_restricted_at = now()`: everyone who joined before stays reachable, everyone who joins afterwards is not reachable through this server until they switch it on in User Settings, Privacy and Safety ("Allow DMs from members of X"). "Apply to everyone" sets the timestamp to the epoch, so existing members must opt in too.
* Enforced when a DM or group DM is created and when someone is added to a group DM (`POST /users/@me/channels`, `addGroupRecipient`). Two people who are not friends may DM only if at least one shared server permits it for that pair; otherwise the API answers 403 `SERVER_DMS_DISABLED`. Friends are never affected. An existing DM keeps working.
* The server owner is always reachable and anyone can write to the owner (a way to ask for help); the owner reaches only members who opted in.
* The user-level switches (`allowDmsFromServerMembers`, message requests, ignores, blocks) still apply on top.
* API: `PATCH /guilds/:id/safety { memberDms: 'open' | 'optin', memberDmsApplyToExisting }` (MANAGE_GUILD); `GET|PUT /guilds/:id/members/@me/dms { allow }` for the member's own choice. `Guild.memberDms` is part of the guild payload so clients know which servers ask.

## 2. Scam and phishing link protection

`assessLink` / `assessMessageLinks` in `packages/shared/src/trust.ts` give every link a 0 to 100 score with machine-readable reasons. At 50 or more a link is `suspicious`, at 80 or more `dangerous`. Signals:

* look-alike of discord, steam, roblox, epicgames, paypal, metamask, coinbase, binance, twitch (homoglyph, leet and one-edit typos, brand inside the registrable domain, brand used as a subdomain of someone else's domain)
* punycode / IDN domains that mix alphabets or consist only of look-alike letters (legitimate single-script IDNs are not flagged)
* `https://discord.com@evil.example` style userinfo tricks, raw IP hosts
* known URL shorteners (a hint only: 30 points, never enough alone) and risky TLDs (15 points)
* "free Nitro", gift, airdrop, claim-your-reward bait in the URL or in the message text around a link
* markdown links whose visible text names another domain than the target
* per-server deny list (always 100) and allow list (always 0); deny wins

Where it shows up:

* Every message payload carries `linkWarnings: [{ host, level, score, reasons }]` when something scored 50 or more (channels and DMs alike). It is computed when the message is serialised, so list changes apply to old messages too. The web client draws a warning banner under the message.
* AutoMod trigger `suspicious_links` with the usual actions (block, warn, timeout, alert, test mode). `options.linkMinScore` (20 to 100, default 50) tunes sensitivity. The rule's own allowed list and keywords extend the server allow and deny lists. `POST /guilds/:id/automod/test` evaluates it.
* Lists: `PATCH /guilds/:id/safety { linkAllow: string[], linkDeny: string[] }` (hostnames, at most 100 each; subdomains included).

## 3. Impersonation guard

Safety Setup, "Impersonation guard" (`impersonationGuard: { enabled, action: 'flag' | 'hold' }`).

* On join, on a display-name change and on a self-set nickname, the member's username, display name and nickname are compared with the owner, members whose roles carry moderation permissions (administrator, manage server, moderate, kick, ban; up to 40) and the server name.
* Comparison is on a folded skeleton (accents and combining marks removed, Cyrillic and Greek look-alikes mapped to Latin, leet digits, `i`/`l`/`1`/`|` equal), then edit distance 1 (names of 5 to 9 letters) or 2 (10 or more); `owner_support` style prefixes and suffixes also match. Names under 4 letters are not compared. The owner and staff themselves are never flagged.
* A match is stored on the member (`impersonation_flag`), written to the audit log (`IMPERSONATION_FLAGGED`), shows as the `impersonation` flag in Mod View and in the review queue (`GET /guilds/:id/safety/impersonation`). With `hold` the member is read-only (like a pending screening member) until a moderator runs `POST /guilds/:id/members/:userId/impersonation/clear` ("Not an impersonator").

## 4. Mass-DM spam detection

`services/massdm.ts`, run before a message is stored in a 1:1 DM. It only looks at first contact: the recipient is not a friend and has never written in that conversation (message requests included). Established conversations are never touched, bots are skipped.

* Each such first message is fingerprinted (lower-cased, links, numbers and mentions collapsed) and logged in `dm_request_events` for two days.
* Within 30 minutes: the same fingerprint to 5 different people, or to 3 when the text contains a suspicious link, or any text to 15 different people, limits the sender for 24 hours.
* A limited sender gets 403 `DM_LIMITED` (with `until`) when they open new conversations with non-friends or message strangers who have not answered; everything else works.
* Each trip writes a `mass_dm_incidents` row and a server log warning. Instance operators (the super admin) read them with `GET /admin/mass-dm` and can lift a limit with `POST /admin/users/:id/clear-dm-limit`.
* The thresholds are the `MASS_DM` constants in `services/massdm.ts` (defaults in `MASS_DM_DEFAULTS` in the shared package).

## 5. New-account hint

`accountAge()` classifies accounts younger than 7 days as new. The web client shows a "New account" chip with the account age on profile popouts and in the message request banner, and in the impersonation review queue. Moderators additionally have the `new_account` flag in Mod View.

## Already in place (unchanged)

Message requests and ignores, raid protection with invite pause, verification levels, explicit-media filter, membership screening, AutoMod (keywords, regex, spam, mentions, invites, caps), timeouts, bans with appeals, reports, passkeys and MFA, the web LinkGuard confirmation for external links, per-user privacy (`allowDmsFromServerMembers`, friend-request sources).

## Limits

* Scoring is heuristic and local. New scam domains that look nothing like a known brand and carry no bait text will pass; the deny list and a reported-link workflow are the answer to those.
* Only brands in the built-in list are protected from look-alikes. Add your own domain to the allow list if it trips a rule.
* The server name and staff names are the only impersonation targets; role names and emoji are not compared.
