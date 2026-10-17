# What the web client needs to expose the platform pass (server side is done; see docs/CONTRACT.md "Platform pass")

No `apps/web` file was touched by this pass. Suggested web work, in priority order:

1. **Slash commands in the composer**: `GET /guilds/:id/application-commands?channelId=` for the picker; send `POST /interactions {type:2,...}`; handle `INTERACTION_FAILED` ("application did not respond"), `INTERACTION_AUTOCOMPLETE_RESULT` (send `type:4` while typing a focused option) and `INTERACTION_MODAL` (render `modal`, submit `type:5` with `interactionId`).
2. **Message rendering**: `Message.components` (buttons incl. link, selects; press = `POST /interactions {type:3}`), `flags & 64` ephemeral ("Only you can see this", never refetched), `flags & 128` LOADING ("is thinking..."), `interaction` header ("X used /name"), `type 'poll_result'`.
3. **Polls**: composer attachment (`poll` in send body, hide without SEND_POLLS), `Message.poll` card with vote (`PUT .../polls/:mid/votes`), results, "end poll", voters list; handle `MESSAGE_POLL_VOTE_ADD|REMOVE` and `MESSAGE_UPDATE`.
4. **Scheduled events**: guild events list/creation UI, interested toggle, `GUILD_SCHEDULED_EVENT_*` events; permission bits `CREATE_EVENTS`/`MANAGE_EVENTS` are new (Jorcord positions 39/38).
5. **Stage topic**: `STAGE_INSTANCE_*` events, "Start stage" with topic.
6. **Voice-channel text chat panel**: server already accepts messages in voice/stage channels.
7. **Forum tags / thread lifecycle**: tag picker on forum posts (`appliedTags`), tag editor in channel settings (`availableTags`), `locked`/`autoArchiveDuration` in thread settings, `THREAD_DELETE`.
8. **Developer portal**: application list/create (show the token ONCE), reset token/secret, redirect URIs, interactions endpoint URL, OAuth2 authorize page (`GET/POST /oauth2/authorize`, guild picker, permission checklist) used for the "add bot" invite link.
9. **Command permissions UI** in server settings (Integrations): `.../commands/:cid/permissions`.
10. **Member screening**: pending badge, rules accept flow (`PUT /guilds/:id/members/@me/screening`), `memberScreening` toggle; discover join via `POST /discover/guilds/:id/join`; consume `STICKERS_UPDATE`; render `User.themeColors`; send `customStatus.expiresAt` instead of client-side expiry.
11. Audit-log viewer: use `actionType` for filtering/labels; error toasts can key off `errorCode`; read `X-RateLimit-*` / `retry_after` for backoff.
12. Optional: `Perm` bit names `SEND_POLLS`, `USE_EXTERNAL_APPS` in the role editor.
