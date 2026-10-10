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

## Quick start
```
pnpm install
pnpm --filter @jorcord/server dev     # :3000, no external services needed
pnpm --filter @jorcord/web dev        # :5173
cd infra/livekit/bin && ./livekit-server --config ../livekit.yaml   # voice/video (see infra/livekit/README.md)
```
Tests: `pnpm -r test`, end-to-end: `pnpm e2e`. Production: `docker compose up` (see `docs/DEPLOY.md`).

Jorcord is an independent project and is not affiliated with Discord. It uses its own name, logo and assets.
