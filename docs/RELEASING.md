# Releasing Jorcord

One tag produces one published GitHub Release containing every platform build.

## Cut a release

1. Bump the version everywhere to the same value (the workflow refuses to run if they differ):
   `package.json` (root, `apps/web`, `apps/server`, `apps/desktop`, `apps/mobile`) and
   `apps/desktop/src-tauri/tauri.conf.json` (+ `Cargo.toml`). Android `versionName` and iOS `MARKETING_VERSION`
   are set from the tag by CI; Android `versionCode` is the workflow run number.
2. Commit, then `git tag vX.Y.Z && git push origin vX.Y.Z` (X.Y.Z = the version you set in step 1; the root `package.json` is the reference).
   Every build reads `apps/web/.env.production`, so the apps ship pointing at the fixed server (`VITE_SERVER_URL`, see `docs/WRAPPER_WEB_NEEDS.md` section 1); override it with a `VITE_SERVER_URL` env var in the workflow to build for another server.
3. `.github/workflows/release.yml` builds in parallel: desktop (Windows, macOS arm64 + Intel, Linux), Android, iOS, web,
   server tarball + LiveKit config, Docker image. The final `release` job downloads every artifact, writes
   `SHA256SUMS.txt`, and creates the (non-draft) release `Jorcord vX.Y.Z` with generated notes in a single call, so there is no
   half-uploaded draft and no race between jobs.
4. Dry run: Actions > Release > Run workflow (needs the workflow file on the default branch). It builds everything and
   uploads the would-be release files as the `release-preview` artifact; nothing is published.

If the iOS job fails the release is still published (the notes say so). Any other failed build blocks publishing.

## Assets

| Asset | From |
|---|---|
| `Jorcord_X_x64-setup.exe`, `Jorcord_X_x64_en-US.msi` | Tauri, Windows |
| `Jorcord_X_aarch64.dmg`, `Jorcord_X_x64.dmg` | Tauri, macOS (Apple Silicon / Intel) |
| `.AppImage`, `.deb`, `.rpm` | Tauri, Linux |
| `Jorcord-X-android-{universal,arm64-v8a,armeabi-v7a,x86_64}.apk`, `Jorcord-X-android.aab` | Capacitor / Gradle |
| `Jorcord-X-ios-unsigned.ipa` | `xcodebuild archive` with signing off, zipped as `Payload/App.app` |
| `jorcord-web-vX.zip` | static web build for a domain root (also deployed to GitHub Pages under `/Jorcord/`) |
| `jorcord-server-vX.tar.gz` | `pnpm deploy --prod` of the server, `run.sh`, `.env.example`, `docker-compose.yml`, migrations |
| `jorcord-livekit-config-vX.tar.gz` | `infra/livekit` without the binary |
| `SHA256SUMS.txt` | checksums of all of the above |
| `ghcr.io/hishamabulfeilat/jorcord-server:X` | multi-arch (amd64, arm64) Docker image |

## One-time repository setup

- **GitHub Pages**: Settings > Pages > Build and deployment > Source: **GitHub Actions**. The `pages` job tries to enable it
  itself but a workflow token usually cannot; the job is `continue-on-error`, so the release is unaffected either way.
  The site lives at `https://<owner>.github.io/Jorcord/`.
- **Docker image visibility**: the first push creates a private package. Open it under your profile > Packages >
  jorcord-server > Package settings > Change visibility > Public, so `docker compose up` can pull it anonymously.
- Workflow permissions: Settings > Actions > General > Workflow permissions can stay read-only; the workflow requests what it needs.

## Secrets (all optional)

| Secret | Effect when set | When missing |
|---|---|---|
| `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | APKs/AAB signed with your release key (base64 of the `.jks`) | an ephemeral keystore is generated per run: APKs install fine, but a later release signed with a different key cannot upgrade it (uninstall first). Not acceptable for Play Store |
| `GOOGLE_SERVICES_JSON_B64` | Android push (FCM) enabled | app builds, push disabled |
| `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` | desktop updater artifacts are produced and `latest.json` is published. The matching public key is already committed in `apps/desktop/src-tauri/tauri.conf.json` (`plugins.updater.pubkey`, endpoint `releases/latest/download/latest.json`); the secret must be the private half of that key pair, otherwise installed apps reject the update | the build switches to `tauri.noupdater.conf.json`, updater artifacts and `latest.json` are skipped, installed apps get no update |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS builds are signed + notarized | unsigned `.dmg` (right-click > Open, or `xattr -cr`) |

Create the Android key once and keep it forever:
`keytool -genkeypair -v -keystore release.jks -alias jorcord -keyalg RSA -keysize 2048 -validity 10000` then
`base64 -w0 release.jks` into the secret.

## iOS

Apple only runs signed apps, so CI produces an unsigned `.ipa`. Users re-sign it with their own Apple ID via AltStore,
Sideloadly or similar (free accounts: 7-day certificates). For TestFlight/App Store, archive from a Mac with your team
(`docs/PLATFORMS.md`, section iOS) or add certificates + provisioning profiles as secrets and replace the unsigned archive step with a signed
`xcodebuild archive` + `-exportArchive`.

## Web hosting notes

- `VITE_BASE` sets the public path (`/Jorcord/` for Pages, `/` otherwise); the router basename, PWA scope/start URL, service worker fallback and
  icons follow it. `VITE_STATIC_HOST=1` makes the app show the "Connect to a server" screen first, because a static host has no API on its own origin.
- GitHub Pages is HTTPS, so browsers block it from talking to plain `http://` servers, except `http://localhost` which browsers treat as secure.
  Use an HTTPS server (reverse proxy such as Caddy) for remote use, and add the Pages origin (`https://<owner>.github.io`) to the server's `CORS_ORIGINS`.
- Deep links on Pages work through `404.html` (a copy of `index.html`).
