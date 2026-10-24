# @jorcord/activities-sdk

Embedded App SDK for Jorcord activities: a dependency-free `postMessage` client for a page that Jorcord shows in a sandboxed iframe in a voice channel.

```ts
import { JorcordActivity } from '@jorcord/activities-sdk';
const activity = new JorcordActivity();
const { instance, user, participants } = await activity.ready();
activity.subscribe('VOICE_STATE_UPDATE', (people) => console.log(people));
await activity.setState({ clicks: 1 });
```

Full guide, security model and launch flow: [docs/ACTIVITIES.md](../../docs/ACTIVITIES.md). Sample: [examples/counter](examples/counter/index.html) (`pnpm build` first and copy `dist/index.js` next to the page).
