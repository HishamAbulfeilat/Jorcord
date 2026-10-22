# Clips: what the web recorder needs from the API

The web clip recorder (`apps/web/src/voice/ClipRecorder.tsx`, `clipBuffer.ts`, `ClipModals.tsx`) keeps a rolling buffer of the
user's own camera or screen share on their device and offers Save / Download / Share. Sharing uses the existing
`POST /channels/:id/clips` and `GET /channels/:id/clips`.

## Status of the requested API changes

1. **Longer clips: done.** The server shared-clip limit is now 120 s and configurable. `CLIP_MAX_SECONDS` (default `LIMITS.maxClipSeconds`
   = 120, clamped to 5-600) replaces the old hard-coded `MAX_CLIP_SECONDS = 30` in `apps/server/src/routes/clips.ts`; `MAX_CLIP_BYTES`
   (100 MB) stays as the size guard (the recorder caps video at 2.5 Mbit/s, so 2 minutes is about 40 MB). `GET /clips/limits` ->
   `{maxSeconds, maxBytes}` lets the web read the cap (`voice/clipLimits.ts`); the web falls back to `LIMITS.maxClipSeconds` when it
   cannot. All three recorder windows (30 s, 1 min, 2 min) can now be shared. A longer claim or file is refused with
   `400 CLIP_TOO_LONG {details:{maxSeconds}}` before the upload is claimed, so it stays usable. Migration `057_clip_duration.sql`
   widens the `clips.duration_seconds` check from 30 to 600.
2. **WebM duration: done.** Browsers' `MediaRecorder` writes WebM without a duration, so the server now reads what is there: the Info
   `Duration` when present and the timecode of the last Cluster in the last 4 MB of the file (`webmDuration` in `routes/clips.ts`).
   MP4 still uses `mvhd`. If the file proves a longer length than the claim, the claim is corrected upwards (so a client cannot dodge the
   cap by under-reporting); with 0.5 s of slack for the unknown length of the final cluster. A file with nothing readable keeps the
   claim. Covered by `apps/server/test/clips.test.ts` (synthetic EBML files, cap, config override, `/clips/limits`).
3. **Discoverability (optional): unchanged.** The `isClipsChannel` flag on channels is enough for the share dialog.

## Web changes that go with it

- `SHARE_MAX_SECONDS` is now the default cap (120 = `LIMITS.maxClipSeconds`); the live cap comes from `GET /clips/limits`
  (`getShareMax()` / `setShareMaxSeconds()` in `clipBuffer.ts`). `canShareClip` and `shareDurationSeconds` use it.
- `lifetimeFor(window)`: a window equal to the cap records 1 s less so the saved clip never exceeds it (the 2 minute window records 119 s
  with the default cap, 30 s and 1 min record their full length). When an operator lowers the cap to 30 s, the 30 s window records 29 s
  and the 1 and 2 minute windows can still be downloaded but not shared (the preview says so).

## Behaviour notes

- Recording is opt-in per session (Clips button > "Start recording buffer", or the "Start automatically" toggle) and nothing is
  uploaded until the user shares.
- The buffer is two staggered `MediaRecorder`s (a single recorder cannot drop its start and stay playable), so a saved clip holds the
  most recent half to full window, e.g. 15 to 30 s for the 30 s option and 60 to 119 s for the 2 minute option.
