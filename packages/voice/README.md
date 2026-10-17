# @jorcord/voice

Framework-agnostic `VoiceClient` (livekit-client) + React layer. Import core from `@jorcord/voice`, React from `@jorcord/voice/react`, styles from `@jorcord/voice/styles.css`, Node helpers from `src/server.ts`.

```tsx
import '@jorcord/voice/styles.css';
import { VoiceProvider, useVoiceChannel, useParticipants, VoiceControls, ParticipantList, ScreenShareView, StageView, AudioUnlockBanner, ErrorBanner } from '@jorcord/voice/react';

<VoiceProvider apiBase="/api" getAuthToken={() => token}>   {/* POST {apiBase}/voice/token {channelId} */}
  <Room channelId={id} />
</VoiceProvider>

function Room({ channelId }) {
  const { join, leave, joined } = useVoiceChannel(channelId);   // {autoJoin:true} optional; auto re-join w/ fresh token on server drop
  const people = useParticipants();
  ...
  <VoiceControls />  <ParticipantList />  {people.filter(p => p.screenOn).map(p => <ScreenShareView key={p.identity} identity={p.identity} />)}
}
```
Headless: `<VoiceControls>{(api) => ...}</VoiceControls>`, `useVoiceClient()` (all actions), `useVoiceSnapshot()`, `useVideoTrack`, `useStreamStats`. Mirror state to the gateway yourself with `VOICE_STATE_UPDATE` from `snapshot.muted/deafened/cameraOn/screenOn`.
E2EE: `const e2ee = createE2EE(); <VoiceProvider e2ee={e2ee}>; await e2ee.setPassphrase(secret); client.setE2EE(true)`.
Tests: `pnpm --filter @jorcord/voice test`. Smoke: see `infra/livekit/README.md`.
