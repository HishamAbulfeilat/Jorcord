# Clips: what the web recorder needs from the API

The web clip recorder (`apps/web/src/voice/ClipRecorder.tsx`, `clipBuffer.ts`, `ClipModals.tsx`) keeps a rolling buffer of the
user's own camera or screen share on their device and offers Save / Download / Share. Sharing uses the existing
`POST /channels/:id/clips` and `GET /channels/:id/clips`. No server change was required for the 30 s case.

## Requested API changes (owner of `routes/clips.ts`)

1. **Longer clips.** The recorder offers 30 s, 1 min and 2 min windows, but `MAX_CLIP_SECONDS = 30` rejects anything longer, so the
   web UI only enables "Share to clips channel" for clips of 30 s or less (longer ones can be downloaded). To share 1 and 2 minute
   clips, raise the limit (suggested: 120 s, configurable) and keep `MAX_CLIP_BYTES` as the size guard (the recorder caps video at
   2.5 Mbit/s, so 2 minutes is about 40 MB). The web constant is `SHARE_MAX_SECONDS` in `clipBuffer.ts`.
2. **WebM duration.** Browsers' `MediaRecorder` writes WebM without a duration, so the server can only trust the client's
   `durationSeconds` for WebM (it can read MP4 `mvhd`). If the claim must be verified, parse the last WebM Cluster timecodes.
3. **Discoverability (optional).** A `GET /guilds/:id/clips-channels` or the `isClipsChannel` flag on channels (already present) is
   enough for the share dialog today; nothing needed.

## Behaviour notes

- Recording is opt-in per session (Clips button > "Start recording buffer", or the "Start automatically" toggle) and nothing is
  uploaded until the user shares.
- The buffer is two staggered `MediaRecorder`s (a single recorder cannot drop its start and stay playable), so a saved clip holds the
  most recent half to full window, e.g. 15 to 29 s for the 30 s option. The 30 s option records 29 s so that the claimed duration is
  always within the API limit.
