# What the native wrappers need from `apps/web`

Status (as of this pass): items 1 (configurable server URL), 2 (deep links), 4 (screen-share detection), and 7 (PWA service-worker skip) are implemented in `apps/web`. Item 3 (push) is implemented end-to-end on both sides: the web client (`lib/push.ts`) and the server (`routes/push.ts` `POST /users/@me/push-devices`) both exist, and the Capacitor path (`lib/push.ts` `enableNative`) already calls `api.push.register({ platform, token })` on the `registration` event — the remaining wrapper piece is the native-side `RequestPermissions` → `Register` UI in the app's notifications settings. Items 5 (layout/safe areas) and 6 (desktop settings: autostart/updater) are partially implemented (see notes below).

The Tauri (desktop) and Capacitor (mobile) shells load the static web bundle (`apps/web/dist`) from a local origin
(`tauri://localhost` / `http://tauri.localhost`, `https://localhost` on Android, `capacitor://localhost` on iOS). The web
app must therefore not assume it is served from the same origin as the API.

## 1. Configurable server URL (required)
- On first launch inside a wrapper (detect: `window.__TAURI__`, `window.Capacitor?.isNativePlatform()`), show a
  "Connect to a server" screen; persist the URL (localStorage is fine; the wrapper origin is stable).
- All REST calls use `${serverUrl}/api/...`; the WebSocket gateway uses `wss://` derived from it; LiveKit URL comes from the
  voice token as today. Web (same-origin) keeps the empty default.
- Validate by fetching `${serverUrl}/health`. Provide "change server" in settings / on the login screen.
- Server side: `CORS_ORIGINS` must include `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`,
  `https://localhost`, `capacitor://localhost` (the wrapper origins). Do not use cookies for auth in wrappers
  (cross-origin, SameSite); bearer tokens in `Authorization` are fine.

## 2. Deep links
- `jorcord://invite/<code>` and `jorcord://open?server=<url>`. Desktop: the shell emits the Tauri event `jorcord://open`
  (payload: URL string) via `window.__TAURI__.event.listen('jorcord://open', e => ...)`; cold-start URLs are available from
  `window.__TAURI__.deepLink.getCurrent()` (plugin `deep-link`).
- Mobile: `App.addListener('appUrlOpen', ({url}) => ...)` from `@capacitor/app` (bundle it via a dynamic
  `import('@capacitor/app')` only when `Capacitor.isNativePlatform()`).
- Route `invite/<code>` to the existing `/invite/:code` page, selecting the server first when `server=` is present.

## 3. Push notifications (mobile)
- After login on native: `PushNotifications.requestPermissions()` -> `register()` -> on `registration` send
  `{ platform: 'android'|'ios', token }` to a new server endpoint (e.g. `POST /api/push/devices`); delete on logout.
  Server then sends via FCM (Android) / APNs (iOS, or FCM with APNs key). Handle `pushNotificationActionPerformed` to
  navigate to the channel. Server work is outside the wrapper scope.
- Foreground messages: show with `@capacitor/local-notifications` or in-app toast.
- Desktop: use the standard `Notification` web API; the Tauri notification plugin is registered, and
  `window.__TAURI__.notification` is available if native styling is wanted. Unread badge: `getCurrentWindow().setBadgeCount(n)`.

## 4. Calls
- Android: around a call call `Capacitor.Plugins.CallService.start({ title: 'Voice: #general', camera: false })` on join and
  `.stop()` on leave (custom plugin in `apps/mobile/android`). Without it Android may suspend the mic in background.
- Call `Haptics.impact()` on long-press/reactions (optional).
- Desktop screen share: `getDisplayMedia` works in WebView2 (Windows) and WKWebView (macOS 13+). WebKitGTK (Linux) has
  limited/no `getDisplayMedia`; the UI should hide or disable "Share screen" when `navigator.mediaDevices.getDisplayMedia`
  is undefined. Android WebView has no `getDisplayMedia`; hide screen share on Capacitor Android (iOS likewise).

## 5. Layout / safe areas
- `index.html` viewport must include `viewport-fit=cover`; use `env(safe-area-inset-*)` padding on top bar, bottom tab bar
  and composer. Keyboard plugin is set to `resize: 'body'`; the composer must stay above the keyboard
  (use `visualViewport` or the `Keyboard` events if needed).
- Status bar is `#1e1f22` (dark); if the theme changes, call `StatusBar.setStyle`/`setBackgroundColor`.
- Android hardware back: `App.addListener('backButton', ...)` to close drawers/modals before exiting.
- Desktop: window is frameless-free (native title bar). Add `-webkit-app-region: drag` only if a custom title bar is added later.

## 6. Desktop settings
- "Launch at login" toggle: `window.__TAURI__.autostart.enable()/disable()/isEnabled()`.
- Updater: `window.__TAURI__.updater.check()` then `downloadAndInstall()` and `process.relaunch()`.
- Closing the window hides to tray; offer "Quit" in tray only (already wired).

## 7. PWA service worker
- Do not register the PWA service worker inside wrappers (bundled assets are already offline); skip registration when
  `window.__TAURI__` or `Capacitor.isNativePlatform()`.
