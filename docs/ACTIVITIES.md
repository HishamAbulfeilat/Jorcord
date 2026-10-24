# Embedded activities (third-party apps in a voice channel)

An activity is a web page **you host over https** that Jorcord shows in a sandboxed iframe in a voice channel. Built-in activities (Watch Together, Tic-Tac-Toe) are separate and unchanged.

## For app developers

1. Create an application in the developer portal and set **Activity URL** (General Information). It must be `https://` with no credentials.
2. Install the SDK: `pnpm add @jorcord/activities-sdk` (workspace package `packages/activities-sdk`, no dependencies).
3. In your page:

```ts
import { JorcordActivity } from '@jorcord/activities-sdk';
const activity = new JorcordActivity();            // reads ?jorcord_host=... that Jorcord adds to your URL
const { instance, user, participants } = await activity.ready();
activity.subscribe('VOICE_STATE_UPDATE', (people) => render(people));   // also ACTIVITY_UPDATE, PARTICIPANTS_UPDATE
await activity.setState({ score: 3 });             // shared JSON, <= 4096 bytes, last writer wins
```

API: `ready()`, `getInstance()`, `getParticipants()`, `getUser()`, `setState(state)`, `subscribe(event, fn)`, `close()`. A sample page is in `packages/activities-sdk/examples/counter`.

Launch: **Activities** button in the call controls -> *Apps* lists apps with an activity URL that are installed in the server (or are yours). The server route is `POST /channels/:id/activities {applicationId}`; the caller must be connected to the voice channel and have USE_EMBEDDED_ACTIVITIES (fallback while that permission bit is not in the build: CONNECT + SEND_MESSAGES). Bots cannot launch activities.

## Security model

- `sandbox="allow-scripts allow-same-origin allow-forms"`: no top navigation, no popups, no modals, no pointer lock; `allow="fullscreen"` is the only delegated feature (camera, microphone and screen capture are not delegated). `allow-same-origin` refers to **your** origin, not Jorcord's.
- CSP: the web app's `frame-src` is `'self'` plus the https origins of registered activity URLs (served with `index.html`, cached 60 s). Nothing else can be framed.
- The host only accepts a message when `event.source` is the frame's own window **and** `event.origin` is the registered origin; the page only accepts messages from `window.parent` at the origin given in `jorcord_host`. Responses are posted with an explicit target origin, never `*`.
- Apps only receive public data the viewer can already see (ids, usernames, display names, avatar hashes, mute state). No tokens, no e-mail. State writes go through `PATCH /activities/:id/state` as the viewing user and are size capped.
- An app with a private bot (`botPublic: false`) can only be launched by its owner.

## Not included (MVP)

No OAuth token hand-off to the activity (`authorize`), no per-activity rooms outside voice channels, no mobile layout tuning, no moderation UI to disable one app server-wide (remove the app from the server to stop it being listed).
