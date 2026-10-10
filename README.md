# Jorcord

A free, open-source Discord-style chat platform: servers, channels, roles, threads, forums, DMs, bots and slash commands, polls, scheduled events, and high-quality voice, video and screen share (up to 4K60) via LiveKit. Every feature is free for everyone; there is no payment code.
Runs on web (installable PWA), desktop (Tauri) and Android/iOS (Capacitor).

| Path | What |
|---|---|
| `apps/server` | Fastify REST API + WebSocket gateway (embedded DB by default; Postgres/Redis/S3 optional) |
| `apps/web` | React + Vite client (PWA) |
| `apps/desktop`, `apps/mobile` | Tauri and Capacitor shells |
| `packages/shared` | Types, permission bits, protocol |
| `packages/voice` | LiveKit voice/video/stream client + React components |
| `infra/livekit` | LiveKit server config |
| `docs/` | `CONTRACT.md` (API), `DEPLOY.md`, `PLATFORMS.md`, `PARITY.md`, `PLAN.md` at root |

## Download

Get everything from the [latest release](https://github.com/HishamAbulfeilat/Jorcord/releases/latest) (checksums in `SHA256SUMS.txt`).

| Platform | File |
|---|---|
| Windows | `Jorcord_*_x64-setup.exe` or `.msi` |
| macOS (Apple Silicon / Intel) | `Jorcord_*_aarch64.dmg` / `Jorcord_*_x64.dmg` (unsigned: right-click > Open) |
| Linux | `.AppImage`, `.deb`, `.rpm` |
| Android | `Jorcord-*-android-universal.apk` (any phone), per-ABI APKs, `.aab` |
| iOS | `Jorcord-*-ios-unsigned.ipa` (re-sign with AltStore/Sideloadly, or TestFlight via `docs/PLATFORMS.md`) |
| Web | hosted at https://hishamabulfeilat.github.io/Jorcord/ or self-host `jorcord-web-v*.zip` |
| Server | `docker compose up` (below), image `ghcr.io/hishamabulfeilat/jorcord-server`, or `jorcord-server-v*.tar.gz` |

## Quick start (run your own server)

```
git clone https://github.com/HishamAbulfeilat/Jorcord && cd Jorcord
./scripts/init-env.sh        # writes .env with random secrets (Windows PowerShell: .\scripts\init-env.ps1)
docker compose up -d --build   # builds the server locally; starts Postgres, Redis, LiveKit (add --profile s3 for MinIO)
```
Then open **http://localhost:3000**: the server image includes the web app (same origin, no server address to enter, no CORS setup).
The desktop/mobile apps and the hosted Pages copy ask for a server address on first launch: enter `http://localhost:3000` (or your server's HTTPS address) and add that app's origin to `CORS_ORIGINS` in `.env`.
The hosted Pages site is HTTPS, so it can reach only HTTPS servers or `localhost`. Details: `docs/DEPLOY.md`; releasing: `docs/RELEASING.md`.

## Development
```
pnpm install
pnpm --filter @jorcord/server dev     # :3000, no external services needed
pnpm --filter @jorcord/web dev        # :5173
cd infra/livekit/bin && ./livekit-server --config ../livekit.yaml   # voice/video (see infra/livekit/README.md)
```
Tests: `pnpm -r test`, end-to-end: `pnpm e2e`.

Jorcord is an independent project and is not affiliated with Discord. It uses its own name, logo and assets.
