# Platforms: desktop and mobile builds

| Target | Dir | Tech | Built here? |
|---|---|---|---|
| Windows / macOS / Linux | `apps/desktop` | Tauri v2 (Rust) | `cargo check` verified on Linux |
| Android | `apps/mobile/android` | Capacitor 6 | project generated, `cap sync` verified; Gradle build needs Android SDK |
| iOS | `apps/mobile/ios` | Capacitor 6 | project generated; building needs a Mac with Xcode |

Both wrappers embed `apps/web/dist`, built with the fixed server URL from `apps/web/.env.production` (`VITE_SERVER_URL`, currently `https://jorcord.duckdns.org`): the apps connect to that one server and show no server picker. Set `VITE_SERVER_URL` to something else (or empty to get the "Connect to a server" screen back) when building for another deployment. See `docs/WRAPPER_WEB_NEEDS.md` for the web-side details, and add the wrapper origins to the server's `CORS_ORIGINS`.

Common first step: `pnpm install && pnpm --filter @jorcord/web build`.

## Desktop (Tauri v2)

Prerequisites: Rust stable (rustup). Linux: `sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf build-essential`. Windows: WebView2 + MSVC build tools. macOS: Xcode CLT.

```bash
pnpm --filter @jorcord/desktop dev            # runs web dev server on :5173 and the shell
pnpm --filter @jorcord/desktop build          # builds web, then bundles for the host OS (src-tauri/target/release/bundle)
pnpm --filter @jorcord/desktop icons          # regenerate icons from apps/desktop/assets/logo.svg
cd apps/desktop/src-tauri && cargo check      # fast compile check
```

Bundles: Windows NSIS + MSI, macOS .app + .dmg, Linux .deb + .rpm + AppImage. Cross-compiling is not supported; use the
release workflow's OS matrix.

Features: tray (left click opens, menu Open/Quit; closing the window hides to tray), native notifications, opt-in
auto-start (`--minimized` into tray), single instance, `jorcord://` deep links, window size/position persistence,
updater, CSP restricting scripts to the bundle (https/wss/localhost for connections and media), mic/camera entitlements on macOS.

Updater setup (placeholder in `tauri.conf.json`):
```bash
pnpm --filter @jorcord/desktop tauri signer generate -w ~/.tauri/jorcord.key
```
Put the public key in `plugins.updater.pubkey`, replace `REPLACE_OWNER` in `endpoints`, and store the private key as the
repo secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Until then `tauri build` will fail on
the placeholder key; for local unsigned builds set `"createUpdaterArtifacts": false` and `"updater": {"active": false}`.

Screen sharing: works via the web app's `getDisplayMedia` on Windows (WebView2) and macOS 13+ (grant Screen Recording in System
Settings). WebKitGTK on Linux has limited support (Wayland portals); document or hide the button there.

Code signing (optional): macOS needs `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`; Windows takes a PFX certificate or Azure Trusted Signing; iOS takes a distribution certificate and provisioning profile. All are wired in the release workflow and skipped when the secrets are absent. See `docs/CODE_SIGNING.md` for the secrets and how to create them.

## Android (Capacitor)

Prerequisites: JDK 17, Android SDK (platform 34, build-tools), `ANDROID_HOME` set.

```bash
pnpm --filter @jorcord/mobile sync            # build web + cap sync
pnpm --filter @jorcord/mobile run open:android   # Android Studio
pnpm --filter @jorcord/mobile run run:android    # device/emulator
cd apps/mobile/android && ./gradlew assembleDebug             # debug APK
pnpm --filter @jorcord/mobile run build:apk   # release APK (unsigned unless keystore env set)
pnpm --filter @jorcord/mobile run build:aab   # Play Store bundle
pnpm --filter @jorcord/mobile run icons       # regenerate mipmaps/splash/notification icon from the logo
```

Live-server mode (web updates without rebuilding the app): `CAP_SERVER_URL=https://chat.example.com pnpm --filter @jorcord/mobile exec cap sync android`.

Signing: create a keystore (`keytool -genkeypair -v -keystore release.jks -alias jorcord -keyalg RSA -keysize 2048 -validity 10000`) and export
`ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. In CI: secrets `ANDROID_KEYSTORE_B64` (base64 of the jks) and the three passwords/alias.

Push: create a Firebase project, add the Android app `app.jorcord.mobile`, download `google-services.json` to
`apps/mobile/android/app/` (gitignored; CI secret `GOOGLE_SERVICES_JSON_B64`). Without it the app builds but push is disabled.

Permissions declared: INTERNET, CAMERA, RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, POST_NOTIFICATIONS (runtime prompt on Android 13+),
BLUETOOTH_CONNECT, VIBRATE, WAKE_LOCK, FOREGROUND_SERVICE(+MICROPHONE/CAMERA/MEDIA_PROJECTION). `CallForegroundService` (type
microphone/camera) keeps a call alive in the background; start/stop it from JS with the in-app `CallService` plugin.
Screen capture: Android WebView does not implement `getDisplayMedia`. Sharing a screen from Android needs a native
MediaProjection plugin (not included; the `mediaProjection` service type and permission are already declared). Viewing
others' screens works.

## iOS (needs a Mac)

Prerequisites: macOS, Xcode 15+, CocoaPods, an Apple Developer account (push, TestFlight, device installs).

```bash
pnpm install && pnpm --filter @jorcord/web build
pnpm --filter @jorcord/mobile exec cap sync ios     # runs pod install
pnpm --filter @jorcord/mobile run open:ios          # Xcode: set Team under Signing & Capabilities
```
In Xcode: select your Team, confirm bundle id `app.jorcord.mobile`, enable capabilities Push Notifications and Background Modes
(audio, voip, remote-notification already in Info.plist; `App.entitlements` already linked, switch `aps-environment` to `production` for
release). Upload the APNs key to Firebase (or your push sender). Then Product > Archive > Distribute (TestFlight/App Store).
CI (`release.yml` job `ios`) only produces an unsigned `.xcarchive` to prove it compiles; re-sign it on your Mac or add
certificates/profiles for fastlane. Info.plist already has mic/camera/photo/local-network usage strings and the `jorcord://` scheme.
iOS WKWebView supports `getUserMedia` (iOS 14.3+) but not screen capture initiation; broadcast sharing needs a ReplayKit extension (not included).

## CI / releases

- `.github/workflows/ci.yml`: install, typecheck, test, build shared+web+server, `cargo check` desktop, `cap sync android`.
- `.github/workflows/release.yml` (tag `v*` or manual): Tauri bundles (Linux, Windows, macOS arm64 + x64, draft GitHub release with updater JSON),
  Android APK+AAB, iOS unsigned archive, Docker image `ghcr.io/<owner>/jorcord-server` (amd64+arm64).

Secrets (Apple/Android ones are optional and just skip signing; the Tauri updater key is required while `createUpdaterArtifacts` is true): `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)`, `APPLE_*`, `ANDROID_KEYSTORE_B64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `GOOGLE_SERVICES_JSON_B64`.
