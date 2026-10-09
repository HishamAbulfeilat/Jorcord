# Jorcord API contract (source of truth for server + clients)

Base: `/api/v1`. JSON. Auth: `Authorization: Bearer <accessToken>`. Types live in `@jorcord/shared` (`types.ts`, `protocol.ts`).
Errors: HTTP status + `ApiError {code,message,details?}`. Pagination: `?limit=` (default 50, max 100) with `?before=<id>`/`?after=<id>`; lists of messages return newest-first arrays.
Permissions always enforced server-side via `computePermissions` (shared). Permission values are decimal strings on the wire.
All features are free: LIMITS in `shared/limits.ts` apply to everyone. There is NO payment/Nitro checkout.

## Auth
POST /auth/register {email,username,password,displayName?} -> {user,accessToken,refreshToken}
POST /auth/login {email,password,totp?} -> same (or 401 `MFA_REQUIRED`)
POST /auth/refresh {refreshToken} -> rotated tokens ; POST /auth/logout
GET/POST /auth/sessions (list/revoke) ; POST /auth/mfa/setup|enable|disable ; POST /auth/password

## Users
GET /users/@me ; PATCH /users/@me {displayName,bio,pronouns,avatar,banner,accentColor,customStatus,theme,settings}
GET /users/:id (profile + mutualGuilds) ; PUT /users/@me/presence {presence}
GET /users/@me/guilds ; DELETE /users/@me/guilds/:guildId (leave)
POST /users/@me/channels {recipientIds[]} -> DM/group DM ; GET /users/@me/channels
GET /users/@me/relationships ; PUT /users/@me/relationships/:userId {type:'friend'|'blocked'} ; DELETE same
GET /users/@me/read-states ; POST /channels/:id/ack {messageId}

## Guilds
POST /guilds {name,icon?,template?} ; GET/PATCH/DELETE /guilds/:id ; GET /guilds/:id/preview
GET/POST /guilds/:id/channels ; PATCH /guilds/:id/channels (reorder) ; PATCH/DELETE /channels/:id
PUT /channels/:id/permissions/:overwriteId ; DELETE same
GET/POST /guilds/:id/roles ; PATCH/DELETE /guilds/:id/roles/:roleId ; PATCH /guilds/:id/roles (reorder)
GET /guilds/:id/members?limit&after ; GET /guilds/:id/members/search?q= ; PATCH /guilds/:id/members/:userId {nick,roles,timeoutUntil}
DELETE /guilds/:id/members/:userId (kick) ; PUT /guilds/:id/bans/:userId {reason,deleteMessageSeconds} ; DELETE same ; GET /guilds/:id/bans
GET/POST /guilds/:id/invites ; GET /invites/:code ; POST /invites/:code (join) ; DELETE /invites/:code
GET /guilds/:id/audit-logs ; GET/POST/PATCH/DELETE /guilds/:id/emojis , /stickers ; GET/POST/PATCH/DELETE /guilds/:id/automod/rules
GET/POST/DELETE /channels/:id/webhooks ; POST /webhooks/:id/:token (execute)
POST /guilds/:id/boosts (free, unlimited: grants boost; tiers by count) ; GET /discover/guilds

## Messages
GET /channels/:id/messages?limit&before&after&around ; POST /channels/:id/messages (JSON or multipart with files[])
PATCH/DELETE /channels/:id/messages/:mid ; POST /channels/:id/messages/bulk-delete
PUT/DELETE /channels/:id/messages/:mid/reactions/:emoji/@me ; GET .../reactions/:emoji
PUT/DELETE /channels/:id/pins/:mid ; GET /channels/:id/pins
POST /channels/:id/typing ; POST /channels/:id/messages/:mid/threads {name} ; PATCH /channels/:threadId (archive)
POST /channels/:id/forum/posts {name,content}
GET /guilds/:id/messages/search?q&authorId&channelId&has=&before=
GET /gifs/search?q , /gifs/trending (proxy to Tenor/Giphy if key configured, else bundled/empty)
GET /unfurl?url= (link embed) — SSRF-safe

## Files
POST /uploads (multipart, resumable-friendly, limit LIMITS.maxUploadBytes) -> Attachment ; GET /files/:id/:filename (range requests)

## Voice (LiveKit)
POST /voice/token {channelId} -> VoiceToken (permission-checked; room = channelId; metadata carries userId)
Voice state is mirrored through gateway op VOICE_STATE_UPDATE + dispatch VOICE_STATE_UPDATE. Server also exposes LiveKit webhook receiver `/voice/webhook`.
Quality: Opus up to 510kbps stereo + DTX/RED; screenshare/camera up to 3840x2160@60 (simulcast + VP9/AV1 SVC, H264 fallback).

## Gateway
WS /gateway. Server sends HELLO{heartbeatInterval}; client sends IDENTIFY{token} -> DISPATCH READY, then DISPATCH events (see `Events`). Heartbeat op 1/ack 11. RESUME with sessionId+seq replays missed events (buffer ≥ 5 min). Presence/typing via Redis (or in-memory) pub/sub, so multiple server nodes can scale horizontally.
