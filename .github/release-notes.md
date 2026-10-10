## Downloads

| Platform | File |
|---|---|
| Windows | `Jorcord_VERSION_x64-setup.exe` (installer) or `Jorcord_VERSION_x64_en-US.msi` |
| macOS, Apple Silicon (M1+) | `Jorcord_VERSION_aarch64.dmg` |
| macOS, Intel | `Jorcord_VERSION_x64.dmg` |
| Linux | `.AppImage` (any distro), `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE) |
| Android | `Jorcord-VERSION-android-universal.apk` (installs on any phone); per-ABI APKs (`arm64-v8a`, `armeabi-v7a`, `x86_64`) are smaller; `.aab` for Play Store |
| iOS | `Jorcord-VERSION-ios-unsigned.ipa` (must be re-signed, see below) |
| Web (self-host) | `jorcord-web-vVERSION.zip`, static files for any web server, or use the hosted copy at https://hishamabulfeilat.github.io/Jorcord/ |
| Server | `jorcord-server-vVERSION.tar.gz`, or Docker: `docker pull ghcr.io/hishamabulfeilat/jorcord-server:VERSION` |
| Voice (LiveKit) config | `jorcord-livekit-config-vVERSION.tar.gz` |

Verify downloads with `SHA256SUMS.txt` (`sha256sum -c SHA256SUMS.txt --ignore-missing`).

## How it fits together

Every app (web, desktop, Android, iOS) is a client. On first launch it asks for **the address of a Jorcord server**
(for example `https://chat.example.com`, or `http://localhost:3000` for a server on the same machine). Run your own server:

```bash
git clone https://github.com/HishamAbulfeilat/Jorcord && cd Jorcord
./scripts/init-env.sh && docker compose up -d     # server + Postgres + Redis + LiveKit + MinIO
```

The hosted web app on GitHub Pages is served over HTTPS, so it can only talk to an HTTPS (or `localhost`) server.
Add the web app's origin to the server's `CORS_ORIGINS`.

## Install notes

- **macOS**: builds are not notarized. If macOS says the app is damaged or from an unidentified developer, right-click the app and choose Open, or run `xattr -cr /Applications/Jorcord.app`.
- **Windows**: builds are unsigned, so SmartScreen shows a warning (More info, Run anyway).
- **Android**: allow "install unknown apps" for your browser/file manager. If this release was signed with a throw-away CI keystore (see the signing line at the end of these notes), a later release cannot be installed over it: uninstall first, or configure the `ANDROID_KEYSTORE_B64` secrets so every release uses the same key.
- **iOS**: Apple does not allow installing unsigned apps. The `.ipa` must be re-signed with your own Apple ID using AltStore, Sideloadly or similar (free accounts: 7-day certificates), or build and ship via TestFlight yourself (`docs/PLATFORMS.md`).
