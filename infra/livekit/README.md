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

The server process env for Jorcord: `LIVEKIT_URL=ws://localhost:7880`, `LIVEKIT_API_KEY=devkey`, `LIVEKIT_API_SECRET=secret`
(`/voice/token` returns `{token,url,room}`; room = channelId). The "secret is too short" log line is expected for the dev secret.

Smoke test (two headless clients, audio+video round trip): `pnpm --filter @jorcord/voice smoke` (server must be running).

## Ports

| Port | Proto | Purpose |
|---|---|---|
| 7880 | TCP | signalling (WS/HTTP) - put behind TLS reverse proxy (wss) in prod |
| 7881 | TCP | ICE/TCP fallback |
| 50000-50200 | UDP | media (widen to e.g. 50000-60000 in prod) |
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
