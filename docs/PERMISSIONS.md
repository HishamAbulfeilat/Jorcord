# Permissions

Jorcord asks for an OS/browser permission only when the user does something that needs it (just in time), explains why first, and explains every outcome. Nothing is requested at startup or first load (`syncPush()` after login only re-registers a device that already had push on and never prompts).

## Flow (web code)

* `apps/web/src/lib/permissions.ts` – pure helpers: `queryPermission`, `watchPermission` (Permissions API `change` events, plus a re-check when the tab/app regains focus for names a browser cannot query), `requestPermission`, `classifyMediaError`, `failureMessage`, `fixSteps`, `settingsDeepLink`, `openSystemSettings`.
* `apps/web/src/lib/permissionFlow.ts` – `ensurePermission(kind)` (call it on the click that needs the device) and `reportPermissionFailure` / `reportFailure` (call it from the `catch` of the real capture).
* `apps/web/src/components/ui/PermissionHost.tsx` – the one dialog (mounted in `App`): explainer (what/why, `Continue` / `Not now`), then the real prompt; blocked view with per-platform steps, `Open settings` where the platform supports it, and `Retry`. It closes itself when the live state turns granted.
* Settings > Permissions (`PermissionsPanel.tsx`) shows the live state of microphone, camera, screen sharing, notifications and clipboard with Allow / How to fix / Open settings / Check again.

Error wording: `NotAllowedError` = blocked (steps shown), `NotFoundError` = no device, `NotReadableError`/`AbortError` = device busy, `OverconstrainedError` = unsupported settings, insecure context = needs https, "Permission dismissed" = closed the prompt (not blocked). Safari/Firefox cannot query some names: state is `unknown`, the explainer is skipped, the browser prompts directly, and the capture error is mapped as above (device labels from `enumerateDevices` count as a "granted" hint).

## Inventory

| Capability | Where it is used | When requested | Native config |
| --- | --- | --- | --- |
| Microphone | voice join (`joinVoice`), voice messages (Composer), clips/RNNoise (same stream), Voice settings test | On join click / first press of the record button / Allow button. Declining still joins muted. | Android `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS`; iOS `NSMicrophoneUsageDescription`; macOS `audio-input` entitlement + `NSMicrophoneUsageDescription` |
| Camera | camera toggle / video DM call (`setCameraOn`), QR login scan, camera preview | On the toggle / scan click | Android `CAMERA`; iOS `NSCameraUsageDescription`; macOS `camera` entitlement |
| Screen capture | `getDisplayMedia` (web/desktop); native MediaProjection (Android `ScreenShareService`) and ReplayKit broadcast extension (iOS) | Explainer once, then the browser/OS picker each share. macOS desktop: Screen Recording (TCC) | Android `FOREGROUND_SERVICE_MEDIA_PROJECTION`; macOS `NSScreenCaptureUsageDescription` |
| Notifications | Web Push / `Notification` (web, desktop webview), Capacitor `PushNotifications` | Enabling desktop/push notifications in Settings (explainer first) | Android 13+ `POST_NOTIFICATIONS` (runtime, via the plugin); iOS `aps-environment`, `remote-notification` |
| Clipboard | write: no permission (user gesture / Tauri plugin). Read (paste of codes): Chromium prompts | On the paste action | Tauri `clipboard-manager:allow-read-text/write-text` |
| Foreground service (Android) | `CallForegroundService` keeps mic/camera alive in a call | Started after the mic is granted (`CallServicePlugin.start` refuses otherwise; API 34 would throw) | `FOREGROUND_SERVICE`, `_MICROPHONE`, `_CAMERA`; service type `microphone|camera` only (`phoneCall` removed, it is not used) |
| Background audio (iOS) | call audio session | n/a | `UIBackgroundModes`: `audio`, `remote-notification` (`voip` removed: no PushKit/CallKit) |
| Bluetooth headsets | audio routing by the OS | n/a (no scanning) | Android `BLUETOOTH_CONNECT` (API 31+ runtime; only needed for headset routing) |
| Local network | iOS only, self-hosted servers on a LAN | iOS prompts on first LAN connection | `NSLocalNetworkUsageDescription` |
| Idle detection, autostart, global shortcut (PTT) | desktop only; no OS permission dialog | Opt-in toggles in Settings > Desktop App | Tauri `autostart:*`; PTT is a custom command (Wayland without a portal may refuse; window keys still work) |
| Geolocation, USB, payment | not used | – | `Permissions-Policy` denies them; the desktop webview denies geolocation |

## Desktop (Tauri v2)

* `on_permission_request` in `apps/desktop/src-tauri/src/lib.rs` answers webview requests: microphone, camera, display capture, notifications and clipboard-read are allowed for the `main` window only (everything else on `overlay` is denied; geolocation/MIDI/sensors denied). **Why:** WebKitGTK (Linux) denies `getUserMedia` silently when no handler answers, so no prompt ever appeared; wry's macOS/Windows handlers otherwise show a second, per-origin prompt before the OS one. Our explainer comes first and on macOS the real TCC prompt still follows.
* Capabilities are split: `default.json` (main window only) and `overlay.json` (events + show/hide only). `opener:allow-open-url` additionally allows only `ms-settings:*` and `x-apple.systempreferences:*` for the Open settings button.
* `Entitlements.plist`: `audio-input`, `camera`, `network.client` (all needed). `Info.plist`: microphone, camera, screen capture strings.
* Open-settings deep links: macOS `x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone|Privacy_Camera|Privacy_ScreenCapture`, Windows `ms-settings:privacy-microphone|privacy-webcam|notifications`. Linux has no universal link; the written steps are shown.

## Mobile (Capacitor)

* `CallService` exposes `checkPermissions` / `requestPermissions` (aliases `microphone`, `camera`) and `openAppSettings` (Android app-details page). iOS: `JorcordScreenShare.openAppSettings` opens the app's page in Settings. Android no longer shows the runtime dialog after two refusals, so the blocked view sends people to settings.
* Notification state uses `PushNotifications.checkPermissions()` / `requestPermissions()`.

## Tests

`apps/web/src/lib/permissions.test.ts` (error classification, platform help, query/watch/request with mocked `navigator.permissions` and `mediaDevices`) and `apps/web/src/components/settings/PermissionsPanel.test.tsx` (live panel, explainer, blocked view, Retry, no prompt on open).

## Not verifiable without real devices

Real OS prompts and TCC/Android/iOS behaviour, WebKitGTK/WebView2/WKWebView permission delivery (the Rust handler type-checks with `cargo check`), Android API 33/34 notification and foreground-service behaviour, iOS Settings deep link, Safari/Firefox prompt behaviour, macOS "restart required" after granting Screen Recording.
