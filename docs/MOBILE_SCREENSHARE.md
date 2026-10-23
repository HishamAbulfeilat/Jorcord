# Mobile screen sharing (Android + iOS)

Status: **implemented but never compiled or run on a device** (written without Android Studio / Xcode). Treat the first device test as the real review. See "Unverified" at the bottom.

## Why a native plugin

Capacitor webviews (Android WebView, iOS WKWebView) have no working `getDisplayMedia`, so the web layer cannot capture the screen itself. The web layer also owns the LiveKit `Room`, so publishing from native code (livekit client-sdk-android / client-sdk-swift) would need a second room connection with its own token and identity. That is a much bigger change, so we do **not** do it.

Chosen design (least moving parts): native code only *captures*; the existing web `VoiceClient` *publishes*.

```
Android: MediaProjection -> VirtualDisplay -> ImageReader -> JPEG -+
iOS:     ReplayKit broadcast extension -> JPEG in app group -------+--> plugin event "frame" (base64)
                                                                   +--> packages/voice nativeScreen.ts: decode -> <canvas>
                                                                        -> canvas.captureStream(0) track
                                                                   +--> VoiceClient.publishTrack(source = ScreenShare)
```

Trade-offs: low frame rate (about 8 fps, max 1280 px long edge, JPEG q60), no system audio, base64 over the Capacitor bridge (about 0.5-1 MB/s). Fine for sharing an app/slides/map; not for games or video. A faster transport (local WebSocket, or WebRTC inside the plugin) is a possible later step; the JS contract (`NativeScreenSource`) would not change.

## Pieces

| Where | What |
| --- | --- |
| `packages/voice/src/nativeScreen.ts` | `createNativeScreenSource(plugin)`: frames -> canvas -> `MediaStreamTrack`; 1 s heartbeat repaint so a static screen still produces frames; keeps only the newest queued frame; maps plugin error codes to DOM error names |
| `packages/voice/src/client.ts` | `VoiceClient.setNativeScreenSource()` (turns on `platform.canScreenShare` + `platform.nativeScreenShare` only if the plugin says it is supported), `startNativeScreenShare()`, teardown on stop / leave / unpublish; after a reconnect it shows "Resume sharing" instead of re-prompting without a gesture |
| `apps/web/src/lib/native.ts`, `voice/controller.ts` | looks up the `JorcordScreenShare` plugin and registers it with the client |
| `apps/web/src/voice/controls.tsx`, `Room.tsx` | existing share button (hidden unless supported), popover without the audio toggle on mobile, red "You are sharing your screen / Stop sharing" banner |
| `apps/mobile/android/.../ScreenSharePlugin.java`, `ScreenShareService.java` | consent dialog, `mediaProjection` foreground service, capture |
| `apps/mobile/ios/App/App/ScreenSharePlugin.swift`, `JorcordBridgeViewController.swift` | picker, Darwin-notification listener, forwards frames; storyboard now uses `JorcordBridgeViewController` to register the in-app plugin |
| `apps/mobile/ios/App/BroadcastExtension/` | ReplayKit Broadcast Upload Extension target (`SampleHandler.swift`, `Info.plist`, entitlements) |

Plugin API (`Capacitor.Plugins.JorcordScreenShare`): `isSupported() -> {supported}`, `start({maxDimension, fps, quality})`, `stop()`, events `frame {data, width?, height?}` and `stopped {reason}`. If `isSupported()` is false or the plugin is absent, the button is simply not shown.

## Android

- `AndroidManifest.xml`: new `<service android:name=".ScreenShareService" android:foregroundServiceType="mediaProjection">`. `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MEDIA_PROJECTION` were already declared.
- Order matters (checked against developer.android.com/media/grow/media-projection): user consent via `createScreenCaptureIntent()` -> start the service -> `startForeground(type MEDIA_PROJECTION)` -> `getMediaProjection()` -> `registerCallback()` -> `createVirtualDisplay()`. The service never calls `createVirtualDisplay` twice and never reuses a consent result (Android 14 throws `SecurityException`).
- **Android 14+: the consent dialog is shown for every share**, and the user may pick "a single app" instead of the whole screen. Android 15 also lets the user stop from the status bar chip; that arrives as `MediaProjection.Callback.onStop` and ends the share cleanly.
- The existing `CallForegroundService` keeps mic/WebRTC alive; the share has its own notification with a Stop action.
- Rotating the device is not handled: the virtual display keeps its initial size, so the content is scaled into it.

## iOS

- New app extension target `BroadcastExtension` (bundle id `<app id>.broadcast`, `com.apple.broadcast-services-upload`, `RPBroadcastProcessModeSampleBuffer`), embedded via "Embed App Extensions". Both targets carry the app group `group.app.jorcord.mobile` (entitlements + `JorcordAppGroup` key in each Info.plist).
- The user taps Share, the app opens `RPSystemBroadcastPickerView` (programmatic tap on its inner button), the user picks "Jorcord Screen Share" and "Start Broadcast". The extension writes `screenshare-frame.jpg` into the app-group container (about 8 fps, scaled, JPEG) and posts a Darwin notification; the app reads the file and emits `frame`. Stop from the app posts a "stop" Darwin notification that makes the extension call `finishBroadcastWithError` (iOS shows a short "Screen sharing stopped" message; this is how a broadcast is ended programmatically).
- The app must stay alive in the background to forward frames. It does while in a call (`UIBackgroundModes` already has `audio` and `voip`), which is the same assumption the voice call makes.
- **Apple developer setup** (needed for real devices, not for CI): register the app group `group.app.jorcord.mobile`, enable it on both App IDs (`app.jorcord.mobile` and `app.jorcord.mobile.broadcast`), and make sure the provisioning profiles include it. If you change the bundle id, change the group id in both entitlements files and both Info.plists.
- Without the app-group entitlement (e.g. unsigned build) `containerURL(forSecurityApplicationGroupIdentifier:)` returns nil, `isSupported()` returns false and the button stays hidden. Sideloaders that strip app groups (free Apple IDs) get the same graceful fallback.

### iOS CI (`.github/workflows/release.yml`)

No workflow change. Reasoning: the job archives with `CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""` as xcodebuild arguments, which apply to every target, including the extension, so it builds unsigned. The extension is a target dependency of `App`, so `-scheme App` builds it and the "Embed App Extensions" phase copies `BroadcastExtension.appex` into `App.app/PlugIns` of the archive. `Products/Applications/App.app` (what the packaging step zips) therefore now contains the extension. The extension has `SKIP_INSTALL=YES` so it does not create a second archive product, and `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` overrides apply to both targets so the versions match. The extension needs no CocoaPods, so `cap sync ios` / `pod install` are unaffected. Whoever re-signs the unsigned `.ipa` must sign the `.appex` too (most sideloading tools do) and provide the app group, otherwise screen sharing is just hidden.

## How to test on a device

1. `pnpm --filter @jorcord/web build && pnpm --filter @jorcord/mobile exec cap sync`.
2. Android: `pnpm --filter @jorcord/mobile run:android` (device or emulator API 29+; use a real device for Android 14+ behaviour). iOS: `pnpm --filter @jorcord/mobile open:ios`, select both targets, set your team, add the App Groups capability to both if Xcode asks, run on a physical device (the simulator has no ReplayKit broadcast).
3. Join a voice channel on the phone, a second client (desktop/web) in the same channel.
4. Tap the share button. Android: accept the system dialog. iOS: pick "Jorcord Screen Share", Start Broadcast.
5. Check: the other client sees the phone screen; the red "You are sharing your screen" banner shows; Stop (banner, button, Android notification, system status chip) ends it on both sides; declining the dialog shows no error toast; switching to another app keeps the share going; a static screen still shows up for a client that joins late; leaving the call stops the share.

## Known limits

- iOS broadcast extension memory cap is about 50 MB; the handler only holds one frame at a time. Do not add heavier processing.
- Android 14+ asks for consent every time and cannot be skipped.
- No system or app audio (the popover hides "Share audio" on mobile).
- About 8 fps and a 1280 px long edge; the quality presets only affect the publish bitrate cap (at most 2.5 Mbps, 10 fps).
- iOS gives no event when the picker is dismissed; the start call is rejected as "cancelled" after 45 s.
- A connection drop ends the share (the web layer shows "Resume sharing", which needs a tap).
- Frames cross the bridge as base64; heavy use will warm the phone.
- Android rotation is not tracked; Android 15+ partial-screen sharing is untested.

## Unverified (never compiled or run)

Everything native: the Java classes, the Swift plugin and extension, the hand-edited `project.pbxproj` (only parsed with the npm `xcode` library, which found all object references consistent), storyboard change, entitlements. Specific risks to look at first:

- `Capacitor.Plugins.JorcordScreenShare` lookup on both platforms (we fall back to `Capacitor.registerPlugin`).
- iOS: programmatic tap on `RPSystemBroadcastPickerView`'s inner button (works in practice, not an official API), `CIContext.jpegRepresentation` signature, Darwin notifications waking the app in the background, app group provisioning.
- Android: `getRealMetrics` sizing on foldables/cutouts, `copyPixelsFromBuffer` with row padding, foreground-service start from the activity-result callback on Android 14/15.
- WebView/WKWebView behaviour of `canvas.captureStream(0)` + `requestFrame()` while the app is backgrounded (JS timers/decoding may be throttled), and the encoder emitting keyframes for repainted identical frames.
- The JS side is covered by unit tests with a mocked plugin and canvas (`packages/voice/test/nativeScreen.test.ts`, `apps/web/src/voice/nativeshare.test.tsx`), but `VoiceClient.startNativeScreenShare` itself (publishTrack of the canvas track) has no automated test.
