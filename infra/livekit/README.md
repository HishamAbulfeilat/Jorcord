# Jorcord LiveKit (voice / video / streaming SFU)

## Run locally

```bash
# 1. get the binary (Linux amd64, gitignored in ./bin). Verified: v1.11.0
mkdir -p infra/livekit/bin && cd infra/livekit/bin
curl -sL https://github.com/livekit/livekit/releases/download/v1.11.0/livekit_1.11.0_linux_amd64.tar.gz | tar xz livekit-server
# other platforms: livekit_1.11.0_{linux_arm64,darwin_arm64,darwin_amd64,windows_amd64}.(tar.gz|zip)

# 2. start (dev keys devkey / secret, ws://localhost:7880)
./livekit-server --config ../livekit.yaml
# or Docker (host networking): docker compose -f infra/livekit/docker-compose.yml up
```

The server process env for Jorcord: `LIVEKIT_URL=ws://localhost:7880` (or `auto`, see below), `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`
(`/voice/token` returns `{token,url,room}`; room = channelId). The "secret is too short" log line is expected for the dev secret.

Smoke test (two headless clients, audio+video round trip): `pnpm --filter @jorcord/voice smoke` (server must be running).

## Docker Desktop / the "Connecting..." hang (read this first)

A browser needs to reach LiveKit twice: **signalling** (WebSocket) and **media** (ICE: UDP, or TCP 7881). In Docker the second one is where it breaks:
LiveKit advertises its *container* IP (172.x) as the ICE candidate, which a browser on the Docker host cannot reach, so the call never connects.

* `docker-compose.yml` therefore sets `rtc.node_ip` from `LIVEKIT_NODE_IP` (default **127.0.0.1**, right when the browser runs on the Docker host),
  publishes `7881/tcp` (ICE/TCP fallback) and the UDP range `50000-50200`.
* Browser on another device: `LIVEKIT_NODE_IP=<the Docker host's LAN IP>`. Cloud VM: `LIVEKIT_NODE_IP=` (empty) + `LIVEKIT_USE_EXTERNAL_IP=true`, or the public IP.
* Easy firewalling: `LIVEKIT_UDP_PORT=7882` + `LIVEKIT_UDP_PUBLISH=7882:7882/udp` multiplexes all media on one UDP port (then open just `7881/tcp` + `7882/udp`).
* Signalling: the Jorcord server proxies it at `/livekit` when `LIVEKIT_URL=auto` (compose default), so the browser only ever talks to the app's port.
  Only `/rtc*` is proxied, never LiveKit's admin API. Without `auto`, `LIVEKIT_URL` must be reachable from the browser (a `localhost` value is rewritten to the host the page was opened on).
* Not using Docker (this folder's `livekit.yaml`, binary on the host)? Same rule: if the browser is on another machine set `rtc.node_ip` to an address it can reach.

The web client times out after 15 s and reports which half failed (`signal-unreachable` / `ice-failed` / `token` / `permission-denied` / `insecure-context`), and the voice dock has an **Open diagnostics** panel; see docs/DEPLOY.md.

## Testing with the real compose config

`e2e/tests/stack.ts` reads `LIVEKIT_CONFIG` out of `docker-compose.yml`, resolves the `${VAR:-default}` values, remaps the ports and starts `bin/livekit-server`
with it, together with the server serving the built web app. `pnpm e2e -- tests/voice-prod.spec.ts` joins voice with two users on that stack, kills and
restarts LiveKit (the second start uses the single-UDP-port mode) and the API server mid-call, and asserts recovery, so compose changes are covered.

## Ports

| Port | Proto | Purpose |
|---|---|---|
| 7880 | TCP | signalling (WS/HTTP). Not needed from browsers with `LIVEKIT_URL=auto` (proxied by the app); otherwise put behind a TLS reverse proxy (wss) in prod |
| 7881 | TCP | ICE/TCP fallback |
| 50000-50200 | UDP | media (widen to e.g. 50000-60000 in prod), or one port via `rtc.udp_port` / `LIVEKIT_UDP_PORT` |
| 3478 | UDP | TURN |
| 5349 | TCP | TURN/TLS (enable with certs; the dev config leaves it off because LiveKit refuses to start without cert files) |
| 443 | TCP | optional: TURN/TLS on 443 via LB for locked-down corporate networks |

## Production checklist
- Replace `keys:` with a generated pair (`livekit-server generate-keys`), secret >= 32 chars; share with the Jorcord server.
- `rtc.use_external_ip: true` (or `node_ip`) on cloud VMs; open the UDP range and 7881 in the security group.
- TURN/TLS: DNS `turn.example.com` -> node, issue a cert (Let's Encrypt), set `turn.domain`, `tls_port: 5349` (or 443 with `external_tls: true` behind an LB), `cert_file`, `key_file`. Without TURN/TLS, users behind UDP-blocking firewalls cannot join.
- Terminate TLS for 7880 (Caddy/nginx/Traefik) and use `wss://voice.example.com` as the token `url`; forward upgrade headers.
- Multi-node: add `redis:`; LiveKit routes rooms across nodes. One room lives on one node (stage with 300 listeners is fine on a single node; 99-user voice also).
- Webhook: set `webhook.urls` to the Jorcord server `/voice/webhook`; keep `api_key` matching.
- Pin the image/binary version; test upgrades since `livekit.yaml` is parsed strictly (unknown keys abort startup).

## Bandwidth sizing (4K)
Per published stream (screen share, one 4K60 layer): **25-40 Mbps** up from the streamer with H264 at `LIMITS.stream.maxBitrateKbps` = 40 Mbps
(VP9/AV1 ~30-45% less for the same quality). Simulcast adds 360p/720p/1080p layers (~+1 / +3 / +8 Mbps), so budget **~45-55 Mbps** uplink for a 4K60 H264 streamer with all layers.
Viewers receive exactly one layer: 1080p60 ~8 Mbps, 1440p60 ~15 Mbps, 4K60 ~25-40 Mbps; `adaptiveStream` picks a layer from the rendered element size.

Server egress = viewers x delivered layer. Examples: 10 viewers of one 4K60 stream = 250-400 Mbps; 50 viewers at 1080p60 = 400 Mbps.
Rule of thumb: 1 Gbps NIC ~ 100 viewers at 1080p60 or ~25-30 at 4K60; use dedicated 10 Gbps nodes (and CPU: SFU forwarding costs ~1 core per ~1-2 Gbps) for large streams.
Audio: Opus 64 kbps typical, music mode up to 510 kbps stereo (negligible vs video).

## Notes for the Jorcord server agent
Use `@jorcord/voice/server` helpers (`mintToken`, `buildVideoGrant`, `promoteToSpeaker`) or equivalent. Required grants for the client features:
`canUpdateOwnMetadata: true` (hand raise / priority speaker attributes), `canPublishSources` incl. `SCREEN_SHARE` + `SCREEN_SHARE_AUDIO`,
`canPublish: false` for stage audience (promote via `RoomServiceClient.updateParticipant`). Set participant identity = userId.
