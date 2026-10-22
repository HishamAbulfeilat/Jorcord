# Web client coverage of the platform pass

Originally a to-do list of web work needed to expose the server's platform pass (`docs/CONTRACT.md` "Platform pass"). Re-checked against `apps/web/src` on 2026-10-22: every item below is implemented, so this file is now a map from feature to client code. Anything still open is listed at the end.

| # | Platform feature | Where it lives in the web client |
|---|---|---|
| 1 | Slash commands in the composer (picker, `POST /interactions`, autocomplete, modals, `INTERACTION_FAILED`) | `lib/api.ts` (`application-commands`), `lib/interactions.ts`, `stores/ui.ts`, `components/modals/ModalHost.tsx` |
| 2 | Message rendering: components, ephemeral and loading flags, interaction header, `poll_result` | `components/chat/MessageExtras.tsx`, `MessageItem.tsx`, `lib/interactions.ts` |
| 3 | Polls: composer attachment (hidden without `SEND_POLLS`), card, vote, end early, voters list, live vote events | `components/chat/Composer.tsx`, `components/modals/PlatformModals.tsx`, `lib/polls.ts`, `stores/messages.ts` |
| 4 | Scheduled events: list and create UI, interested toggle, recurrence, `GUILD_SCHEDULED_EVENT_*` | `components/modals/PlatformModals.tsx`, `lib/events.ts`, `lib/api.ts` |
| 5 | Stage topic and `STAGE_INSTANCE_*` events | `components/modals/PlatformModals.tsx`, `voice/StageBar.tsx`, `lib/session.ts` |
| 6 | Voice-channel text chat panel | `components/chat/VoiceChat.tsx`, `voice/views.tsx` |
| 7 | Forum tags, sort and layout, thread lock/auto-archive, `THREAD_DELETE` | `components/chat/ForumView.tsx`, `components/settings/ChannelSettings.tsx`, `components/modals/PlatformModals.tsx`, `stores/data.ts` |
| 8 | Developer portal and OAuth2 authorize page (add-bot link) | `pages/DeveloperPortal.tsx`, `pages/OAuthAuthorize.tsx`, `lib/oauth.ts` |
| 9 | Command permissions in server settings | `components/settings/CommandPermissions.tsx`, `BotsAppsTab.tsx` |
| 10 | Member screening, discover join, `STICKERS_UPDATE`, `themeColors`, `customStatus.expiresAt` | `components/modals/PlatformModals.tsx`, `lib/session.ts`, `components/settings/UserSettings.tsx` |
| 11 | Audit-log viewer by `actionType`, `errorCode` toasts, `X-RateLimit-*` / `retry_after` back-off | `lib/audit.ts`, `lib/transport.ts`, `lib/ratelimit.ts` |
| 12 | Permission names `SEND_POLLS`, `USE_EXTERNAL_APPS` in the role editor | `lib/perms.ts`, `components/settings/PermGrid.tsx` |

## Still open on the web side

- Clips (`routes/clips.ts`, migration 040): no recorder or clips-channel view yet. The server only accepts clips in a channel marked `isClipsChannel`, so the UI must create or flag such a channel first and send a `durationSeconds` (or an MP4 whose header carries it).
- Components V2 layout containers (the server does not implement them either).
- A persistent moderator-report side panel (the modal queue exists).
