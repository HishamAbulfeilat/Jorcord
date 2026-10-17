# Deploying Jorcord

The backend is one Node process (`apps/server`) plus the services it talks to. Everything except Postgres has a
zero-config fallback, so the same code runs on a laptop (embedded database, in-memory bus) and on a cluster.

| Concern | Dev default | Production |
|---|---|---|
| Database | embedded PGlite in `DATA_DIR/db` | Postgres 14+ (`DATABASE_URL`) |
| Event bus, presence, voice state | in-process | Redis (`REDIS_URL`) - required for more than one server node |
| File storage | `DATA_DIR/files` | S3-compatible bucket (`STORAGE_DRIVER=s3`) |
| Voice/video | LiveKit on `ws://localhost:7880` | LiveKit with TLS + UDP ports open |
| Email | printed to the server log | SMTP (`SMTP_URL`) |
| Message search | `ILIKE` substring | Postgres full-text search (automatic on pg) |

## Quick start (Docker Compose)

```bash
cp .env.docker.example .env      # then fill in the four secrets (openssl rand -base64 48)
docker compose up -d --build
curl localhost:3000/health       # {"status":"ok","db":"pg",...}
```

This starts `server`, `postgres:16`, `redis:7`, `livekit`, `minio` (+ a one-shot job that creates the private bucket).
The server runs migrations on boot. Compose refuses to start if a required secret is missing.

Ports: `3000` API + WebSocket gateway, `7880` LiveKit signalling, `7881/tcp` and `50000-50200/udp` LiveKit media,
`127.0.0.1:9001` MinIO console. Postgres, Redis and MinIO are not published.

**The web app is served by the server itself.** The Docker image builds `apps/web` (`VITE_BASE=/`) into `/app/web` and sets
`WEB_DIST=/app/web`, so `http://localhost:3000/` is the app (same origin: it talks to `/api/v1` and `/gateway` on the page's own
origin, with no server-address screen and no CORS setup). Unknown browser navigations (deep links such as `/channels/x/y`) get
`index.html`; API paths (`/api`, `/gateway`, `/files`, `/health`, `/voice`, `/oauth2`, `/interactions`, `/webhooks`, `/push`)
keep their JSON 404s. Hashed assets are cached immutably; `index.html` and `sw.js` are always revalidated.
Without Docker, run `VITE_BASE=/ pnpm --filter @jorcord/web build` and start the server with `WEB_DIST=apps/web/dist`
(unset by default, so `pnpm dev` stays API-only; the release tarball ships the build in `web/` and `run.sh` sets it).
To host the web client elsewhere (CDN, GitHub Pages: build with `VITE_STATIC_HOST=1`), add its origin to `CORS_ORIGINS`.

## Without Docker

```bash
pnpm install
cd apps/server
NODE_ENV=production JWT_SECRET=... DATABASE_URL=postgres://... REDIS_URL=redis://... pnpm start
```

Build the image yourself with `docker build -f apps/server/Dockerfile -t jorcord-server .` (context = repo root).

## Configuration

All settings are environment variables (`apps/server/.env.example` lists them with comments).

| Variable | Notes |
|---|---|
| `JWT_SECRET` | **Required in production**, >= 16 chars (use 48+ random bytes). Also derives the MFA-secret encryption key: rotating it logs everyone out *and* invalidates enrolled authenticator secrets. |
| `DATABASE_URL` | Postgres connection string. Empty = PGlite (single node only). |
| `REDIS_URL` | Enables the Redis event bus, shared presence and shared voice state. |
| `PUBLIC_URL` | Used in emailed links (`/verify-email?token=`, `/reset-password?token=`). |
| `CORS_ORIGINS` | Comma-separated origins. `*` is fine in dev, not in production. |
| `TRUST_PROXY` | `true` behind a reverse proxy so rate limits use the real client IP. |
| `LIVEKIT_URL` | Signalling URL **browsers** connect to (handed out in voice tokens). `auto` (compose default) = the server proxies LiveKit signalling at `/livekit` on the app's own origin, so one port/host/TLS cert is enough and it works for `localhost`, a LAN IP or a domain. An explicit `ws(s)://host:port` bypasses the proxy; a `localhost`/`127.0.0.1` value is rewritten to the host the browser used (same port), so opening the app via a LAN IP still works. |
| `LIVEKIT_API_URL` | URL the **server** uses for RoomService calls (mute/move/disconnect) and for the `/livekit` signalling proxy. Defaults to `LIVEKIT_URL` (or `ws://localhost:7880` when that is `auto`); in Docker it is `http://livekit:7880`. |
| `LIVEKIT_API_KEY/SECRET` | Must match LiveKit's `keys:`. |
| `STORAGE_DRIVER` | `local` or `s3`. With `S3_BUCKET` set it defaults to `s3`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `S3_PREFIX` | Any S3-compatible service. MinIO/R2: set `S3_ENDPOINT`; MinIO also needs `S3_FORCE_PATH_STYLE=true`. Omit the keys to use the AWS default credential chain (instance role etc.). |
| `SMTP_URL`, `MAIL_FROM` | `smtp://user:pass@host:587` (`smtps://` for implicit TLS). |
| `SEARCH_MODE` | `auto` (default), `fts`, `ilike`. |
| `RATE_LIMIT_ENABLED` | Default on. Limits are per node (in memory). |

### Files
Uploads stream through the server into the bucket and are served back through `GET /api/v1/files/:key/:filename`
(unguessable key, range requests, forced download for non-media types). The bucket should stay **private**; the
server is the only client. Moving existing local files to S3: copy `DATA_DIR/files/<aa>/<key>` to `<prefix><aa>/<key>`
in the bucket (same two-character shard layout) and switch `STORAGE_DRIVER`.

### Email
Email verification (sent at sign-up, resend via `POST /auth/verify-email/send`) and password reset
(`POST /auth/password/forgot`) need working SMTP. In development the message, including the link, is logged to the
console. **In production without `SMTP_URL` nothing is sent** (a warning is logged) - the tokens are credentials and
are never logged outside development.

### Search
On Postgres, migration `003_search.pg.sql` builds a GIN index and searches match **word prefixes** ("kube" finds
"Kubernetes"; punctuation splits words so "example.com" matches "docs.example.com"). On PGlite, or when a query has no
searchable word, search is a case-insensitive substring match. Creating the index on a very large existing `messages`
table takes a write lock for the duration; for big installs run
`CREATE INDEX CONCURRENTLY messages_content_fts_idx ON messages USING GIN (to_tsvector('simple', regexp_replace(content, '[^[:alnum:]]+', ' ', 'g')));`
by hand *before* deploying (the migration then no-ops via `IF NOT EXISTS`).

## LiveKit (voice / video)

Voice needs **two** things to work from a browser: *signalling* (a WebSocket, handled by `LIVEKIT_URL`) and *media* (WebRTC/ICE over UDP, or TCP 7881 as fallback). Both must be reachable from **the browser's machine**, not from inside Docker.

### Quick start (Docker Desktop on Windows / macOS / Linux, browser on the same machine)
```bash
docker compose up -d --build        # then open http://localhost:3000
```
Nothing else to configure: `LIVEKIT_URL=auto` (signalling through the app port) and `LIVEKIT_NODE_IP=127.0.0.1` (the address LiveKit advertises for media; Docker Desktop forwards the published `7881/tcp` and `50000-50200/udp` ports to localhost).

**Why voice used to hang on "Connecting..."**: inside a container LiveKit advertises its *container* IP (172.x) as the ICE candidate, which a browser on the host cannot reach, so the media connection never came up. Compose now sets `rtc.node_ip` (default `127.0.0.1`), and the client gives up after 15 s with the real reason (signalling blocked, ICE failed, token refused, mic permission, insecure context) and a Retry / Troubleshoot panel instead of spinning.

### Reaching it from other devices
| Setup | What to set in `.env` |
|---|---|
| Phone / other PC on your **LAN** opening `http://192.168.1.20:3000` | `LIVEKIT_NODE_IP=192.168.1.20` (the Docker host's LAN IP) and open `7881/tcp` + the UDP range in the host firewall. Browsers only allow the microphone on `https://` or `localhost`, so for LAN use put TLS in front (see below) or use a tunnel. |
| **VPS / public IP** | `LIVEKIT_NODE_IP=` (empty) and `LIVEKIT_USE_EXTERNAL_IP=true` (LiveKit discovers its public IP via STUN), or set `LIVEKIT_NODE_IP=<public ip>`. Open `7881/tcp` and `50000-50200/udp` in the security group. |
| **Domain + TLS** | `PUBLIC_URL=https://chat.example.com`, `TRUST_PROXY=true`, keep `LIVEKIT_URL=auto` (signalling rides on the same https/wss origin; no extra DNS name or cert). Media still needs the ports above. |
| Separate LiveKit host (`wss://livekit.example.com`) | `LIVEKIT_URL=wss://livekit.example.com` and a reverse proxy for 7880 (example below). |

### Firewalling: fewer ports
* **Single UDP port**: `LIVEKIT_UDP_PORT=7882` and `LIVEKIT_UDP_PUBLISH=7882:7882/udp` (all media multiplexed on one UDP port; then only `7881/tcp` + `7882/udp` need to be open; the range mapping is no longer used).
* **TCP only**: if UDP is blocked entirely, clients automatically fall back to `7881/tcp` (slower, higher latency). The voice dock's connection details show the path in use (UDP / TCP / TURN relay).
* Signalling needs no extra port with `LIVEKIT_URL=auto`; you may then remove the `7880:7880` mapping from compose.

### TURN (strict corporate networks, UDP-blocking firewalls)
`LIVEKIT_TURN_ENABLED=true` and `LIVEKIT_TURN_DOMAIN=turn.example.com` enable LiveKit's embedded TURN on `3478/udp` (published by compose). To pass firewalls that only allow 443/tcp you need TURN/TLS: edit the `turn:` block in `docker-compose.yml` (or `infra/livekit/livekit.yaml`) with `tls_port: 5349` (or `443` + `external_tls: true` behind a TLS-terminating L4 proxy), `cert_file`, `key_file`, mount the certificates into the container and publish the port. LiveKit refuses to start with `tls_port` set but no certificate, so test with `docker compose logs livekit`.

### Voice reconnection
The web client recovers by itself: LiveKit resumes short network blips; if that fails the client rejoins with a **fresh token** using exponential backoff (1 s doubling to 15 s, 20 attempts), showing "Reconnecting..." with the attempt count, a countdown and "Retry now". It also retries immediately when the browser comes back online or the tab wakes from sleep. Mute / deafen / devices are kept, the camera is restored, a screen share asks for one click (browsers require a user gesture). After a rejoin or an API-server restart the client re-announces its voice state over the gateway so nobody shows as stale. If every attempt fails the client leaves the channel (clearing the gateway voice state) and shows a Troubleshoot panel. The voice dock shows ping / packet loss and links to a diagnostics panel with a self-test and a copyable report.

### Troubleshooting checklist
1. `docker compose ps` / `docker compose logs livekit`: is LiveKit up? Is `LIVEKIT_API_SECRET` the same for both services (>= 32 chars)?
2. Open the voice dock -> **Connection details -> Open diagnostics**: it shows the signalling URL, whether it answers from *your browser*, secure-context / microphone permission, and the selected ICE path.
3. "Voice server unreachable" -> signalling blocked: check `LIVEKIT_URL` (use `auto`), VPN / proxy / extension blocking WebSockets.
4. "ICE failed" (signalling OK, media not) -> `LIVEKIT_NODE_IP` is not an address your browser can reach, or UDP 50000-50200 / TCP 7881 are not published / firewalled.
5. Microphone prompt never appears -> the page is not `https://` or `http://localhost`.
6. LiveKit must be able to POST webhooks to `http://server:3000/api/v1/voice/webhook` (configured in compose); the server uses them to clear voice state when a client vanishes without leaving.
7. Server-side mute / deafen / move / disconnect and stage speaker changes call LiveKit's RoomService with the server's API key. If LiveKit's API is unreachable the gateway state still changes and future tokens are issued correctly (muted users get tokens without a microphone grant); only the live session keeps its old permissions until it reconnects.

### Content-Security-Policy
The server sends the web app a CSP whose `connect-src` is derived from your config: `'self'` (API, gateway, `/livekit` proxy), the same-origin `ws(s)://` variant, and the origin(s) of an explicit `LIVEKIT_URL` (ws/wss/http/https; for a `localhost` URL also the same port on the host the page was opened with). `worker-src 'self' blob:` (noise-suppression worker / audio worklet) and `media-src`/`img-src` with `blob:` are allowed; there is no blanket `https:`/`ws:` connect allowance. If you embed a different LiveKit origin, set `LIVEKIT_URL` accordingly; nothing else needs editing.

## Scaling to several server nodes

1. Set `DATABASE_URL` (shared Postgres) and `REDIS_URL` (shared Redis).
2. Start **one** node first (it applies migrations), then the others.
3. Put a load balancer in front. WebSocket gateway sessions are held in memory on the node that accepted them, so the
   balancer should use **sticky connections** (e.g. by client IP or cookie) for `/gateway` if you want `RESUME` to
   replay missed events after a reconnect; without stickiness a reconnect to a different node simply gets a fresh `READY`.
4. Events fan out through Redis pub/sub; presence is a lease per gateway session (45 s, refreshed every 10 s) so a
   crashed node's users go offline within a minute; voice state lives in Redis (6 h safety TTL).
5. Rate limits and the unfurl/GIF caches are per node.

Redis does not need persistence (`--save ""`); losing it only drops transient presence/voice state, and clients re-identify.

## Reverse proxy (Caddy example)

```
api.example.com {
  encode zstd gzip
  reverse_proxy server:3000      # WebSocket upgrade on /gateway works out of the box
}
```
Then `PUBLIC_URL=https://api.example.com` (users open this URL: it serves the web app too), `TRUST_PROXY=true`, and leave
`LIVEKIT_URL=auto` (signalling is proxied by the app at `/livekit`, so no second host is needed). For a dedicated LiveKit host add
`livekit.example.com { reverse_proxy livekit:7880 }` and set `LIVEKIT_URL=wss://livekit.example.com`. `CORS_ORIGINS` is only needed for web clients hosted on another origin.

## Operations

* **Health**: `GET /health` (200 `{status:"ok",db,...}` / 503). The image has a Docker `HEALTHCHECK`.
* **Backups**: `pg_dump` the `jorcord` database and back up the bucket. `DATA_DIR` holds only the dev JWT secret and (without
  S3) uploaded files.
* **Upgrades**: pull, rebuild, `docker compose up -d`. Migrations are forward-only and run at boot.
* **Logs**: JSON via pino on stdout; `authorization`/`cookie` headers are redacted.
* **Account deletion** anonymises the user row (username `deleted_<id>`, no email/password) and keeps their messages
  attributed to "Deleted User"; `GET /users/@me/export` returns a JSON export of the caller's data.

## Security checklist

- [ ] `JWT_SECRET`, `POSTGRES_PASSWORD`, `LIVEKIT_API_SECRET`, `MINIO_ROOT_PASSWORD` are unique random values.
- [ ] `CORS_ORIGINS` lists only your web origin(s); `TRUST_PROXY=true` only when actually behind a proxy.
- [ ] TLS on the API and LiveKit endpoints.
- [ ] Postgres, Redis and MinIO are not reachable from the internet (compose does not publish them).
- [ ] The S3 bucket has no public policy.
- [ ] SMTP configured, otherwise password reset and email verification cannot work.
