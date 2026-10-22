# Production checklist

Everything here is a **name**, never a value. Set values through your platform's secret store / environment — never commit them.
Sources of truth: `apps/server/src/config.ts`, `apps/server/.env.example`, `.env.docker.example`, `docker-compose.yml`, `.github/workflows/release.yml`.

## 1. Required server environment variables

The server refuses to start in production without these.

| Variable | Why |
|---|---|
| `NODE_ENV` | Must be exactly `production` to turn on production mode (guards, no dev defaults). |
| `JWT_SECRET` | Signs access/refresh tokens. **At least 32 characters** in production; also derives the MFA-secret encryption key (rotating it logs everyone out and invalidates enrolled authenticator secrets). |
| `LIVEKIT_API_KEY` | Must not be the dev default `devkey`. |
| `LIVEKIT_API_SECRET` | **At least 32 characters** and not the dev default `secret`. |

## 2. Production-hardening environment variables

Strongly recommended; the server runs without them but with degraded guarantees.

| Variable | Why |
|---|---|
| `PUBLIC_URL` | Public URL of the app. **Set it to an `https://` URL** so HSTS is sent (and so emailed links, VAPID subject and CORS default origin are correct). |
| `CORS_ORIGINS` | Explicit comma-separated origin allow-list. `*` is **rejected at startup in production** — list only your web origin(s). |
| `TRUST_PROXY` | Set `true` **only** when actually behind a reverse proxy, so rate limits and HSTS see the real client IP / protocol. |
| `DATABASE_URL` | Postgres connection string. Empty falls back to embedded PGlite, which is single-node only. |
| `REDIS_URL` | Enables the shared event bus, presence and voice state across nodes. Required for multi-node. |
| `REDIS_PREFIX` | Namespace for Redis keys/channels when several clusters share one Redis. |
| `SMTP_URL` | **Without it, production sends no email** (verification + password reset become unavailable). |
| `MAIL_FROM` | From-address for outgoing mail. |
| `HOST`, `PORT` | Bind address/port (defaults `0.0.0.0:3000`). |
| `LOG_LEVEL` | Log verbosity (`info` typical). |
| `DATA_DIR` | Persistent data root (local secret, uploads). |
| `WEB_DIST` | Directory of the built web client to serve the SPA from the same origin. |
| `MAX_UPLOAD_BYTES` | Upload size cap. |
| `RATE_LIMIT_ENABLED` | Default on; per-node in-memory limits. |
| `SUPER_ADMIN_USER_ID` | The single instance super admin (user id). No API can grant or change it. |
| `LIVEKIT_URL` | Signalling URL browsers use (`auto` = proxy through the app origin). |
| `LIVEKIT_API_URL` | URL the **server** uses for LiveKit RoomService; differs from `LIVEKIT_URL` in Docker. |
| `LIVEKIT_CONTROL` | `false` disables RoomService calls (mute/move/disconnect become gateway-only). |
| `STORAGE_DRIVER` | `local` or `s3`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX` | S3-compatible object storage (omit the keys to use the AWS default credential chain). |
| `SEARCH_MODE` | `auto` (default), `fts`, `ilike`. |
| `TENOR_API_KEY`, `GIPHY_API_KEY` | GIF search proxies (optional). |
| `HEARTBEAT_INTERVAL_MS`, `VOICE_GRACE_MS`, `SWEEP_INTERVAL_MS` | Lifecycle timing knobs. |
| `CLIP_MAX_SECONDS`, `STREAM_MAX_VIEWERS` | Longest shared clip (default 120 s, max 600) and the server-wide cap of viewers per Go Live stream (default 99). |

## 3. Push notification environment variables (optional)

| Variable | Why |
|---|---|
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | Web Push (VAPID). Generated into `DATA_DIR/vapid.json` when not supplied. |
| `VAPID_SUBJECT` | VAPID contact (defaults to `PUBLIC_URL` or a mailto). |
| `FCM_SERVICE_ACCOUNT`, `FCM_SERVICE_ACCOUNT_FILE` | Firebase Cloud Messaging service-account JSON (inline or file path). |
| `APNS_KEY`, `APNS_KEY_FILE` | APNs token-auth `.p8` (inline or file path). |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID` | APNs identifiers; all three plus the key are needed to enable direct APNs. |
| `APNS_PRODUCTION` | `true` to use the APNs production endpoint. |

## 4. Docker Compose variables

Read by `docker-compose.yml` (values belong in a local `.env`, copied from `.env.docker.example`).

| Variable | Why |
|---|---|
| `POSTGRES_PASSWORD` | Postgres superuser password (required). |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` | MinIO credentials when object storage is enabled (password required). |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`, `LIVEKIT_API_URL` | LiveKit wiring (also server vars above). |
| `LIVEKIT_NODE_IP`, `LIVEKIT_USE_EXTERNAL_IP` | Address LiveKit advertises for media (must be reachable from the browser). |
| `LIVEKIT_UDP_PORT`, `LIVEKIT_UDP_PUBLISH` | Single UDP media port instead of the default range. |
| `LIVEKIT_TURN_ENABLED`, `LIVEKIT_TURN_DOMAIN` | TURN relay for UDP-blocking networks. |
| `PUBLIC_URL`, `CORS_ORIGINS`, `TRUST_PROXY`, `SMTP_URL`, `MAIL_FROM`, `STORAGE_DRIVER`, `SUPER_ADMIN_USER_ID`, `TENOR_API_KEY`, `GIPHY_API_KEY` | Passed through to the server container. |

## 5. GitHub Actions secrets (`.github/workflows/release.yml`)

Configure these under repository **Settings → Secrets and variables → Actions**.

| Secret | Used for |
|---|---|
| `GITHUB_TOKEN` | Automatic token; used by the release steps and GHCR image push. Also `github.token` as `GH_TOKEN`. Needs `contents: write`; the image job needs `packages: write`. |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater signing key. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the Tauri signing key. |
| `APPLE_CERTIFICATE` | Base64 macOS/iOS signing certificate. |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the Apple certificate. |
| `APPLE_SIGNING_IDENTITY` | Apple signing identity name. |
| `APPLE_ID` | Apple ID for notarization. |
| `APPLE_PASSWORD` | Apple ID app-specific password. |
| `APPLE_TEAM_ID` | Apple Developer team id. |
| `ANDROID_KEYSTORE_B64` | Base64 Android keystore. |
| `ANDROID_KEYSTORE_PASSWORD` | Android keystore password. |
| `ANDROID_KEY_ALIAS` | Android key alias. |
| `ANDROID_KEY_PASSWORD` | Android key password. |
| `GOOGLE_SERVICES_JSON_B64` | Base64 `google-services.json` for the Android build. |

`GITHUB_TOKEN` is provided automatically; the rest must be added manually (and are only needed for the platform(s) you actually build).

## 6. Guards the server enforces

- **JWT**: production requires `JWT_SECRET` ≥ 32 chars (and ≥ 16 always).
- **LiveKit**: production rejects missing/default/`<32`-char `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`.
- **CORS**: production rejects `CORS_ORIGINS=*` at startup. The native wrapper origins and the `PUBLIC_URL` origin are always added to an explicit allow-list.
- **HSTS**: `Strict-Transport-Security` is sent only when `isProd` **and** the deployment is served over https (`PUBLIC_URL` is `https://`, or the request arrived over https). It is never sent on a plain-http deployment.
- **Errors**: unhandled 5xx responses return a generic `{ code: 'INTERNAL', message: 'Internal server error' }` body with no stack trace; only 4xx responses carry a descriptive message.
- **Logs**: `authorization`, `cookie` and `set-cookie` values, capability secrets in URLs, query strings, and database error `detail`/`parameters` are redacted/never serialized.

## 7. Pre-flight checklist

- [ ] `NODE_ENV=production`.
- [ ] `JWT_SECRET` is unique, random and ≥ 32 characters.
- [ ] `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` are non-default and the secret is ≥ 32 characters.
- [ ] `PUBLIC_URL` is your real `https://` origin.
- [ ] `CORS_ORIGINS` lists only your web origin(s) — never `*`.
- [ ] `TRUST_PROXY=true` **only** when behind a proxy that sets `X-Forwarded-*`.
- [ ] `SMTP_URL` configured (otherwise email verification / password reset are unavailable).
- [ ] Backing services configured: `DATABASE_URL`, optional `REDIS_URL`, storage (`S3_*` or local `DATA_DIR`).
- [ ] TLS terminated in front of the server so HSTS is meaningful.
- [ ] Local `pnpm typecheck && pnpm --filter @jorcord/server test` pass before deploy.
