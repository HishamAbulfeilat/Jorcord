# Deploying Jorcord free (Oracle Cloud Always Free ARM + docker-compose)

One VM, one `docker compose up`, a free domain, and you have a public Jorcord instance with voice. The
published server image (`ghcr.io/hishamabulfeilat/jorcord-server`) is built for `linux/amd64` **and**
`linux/arm64`, so it runs natively on Ampere A1; Postgres, Redis, LiveKit and MinIO all publish arm64
images too. Nothing here costs money.

What you get with the Always Free tier: up to 4 Ampere A1 cores + 24 GB RAM (usable as one VM), 2
boot/200 GB block storage, a static-ish public IP per instance. Enough to run this stack and a few
dozens of users. See the [Oracle free-tier docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
for the current shape of the offer.

## 1. Create the VM

1. Create a free-tier account. Your instance gets a public IP (Oracle reserves it while the instance
   lives; you can pin it as a Reserved Public IP if you like).
2. **Compute → Instance → Create**: OS image **Ubuntu** 22.04/24.04 (Oracle Linux also works), shape
   **VM.Standard.A1.Flex**, 2–4 OCPU + 12–24 GB RAM, boot volume ~100 GB.
3. Download the SSH key. Connect: `ssh ubuntu@<public-ip>`.

Then install Docker on the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker   # re-login afterwards
```

## 2. Open the ports

Oracle VMs have **two** firewalls to punch through: the OCI security list (cloud side) and the
`iptables` rules bundled with the OS image (VM side). Both must allow the same ports:

| Port | Protocol | Purpose |
|---|---|---|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (Caddy, ACME challenge) |
| 443 | TCP | HTTPS (app + LiveKit signalling) |
| 7880 | TCP | LiveKit signalling (only used when `LIVEKIT_URL` is an explicit `ws://host:7880`) |
| 7881 | TCP | LiveKit ICE/TCP fallback (used when UDP is blocked) |
| 7882 | UDP | LiveKit media (single-port mode; see `.env` below) |
| 3478 | UDP | TURN (only used with `LIVEKIT_TURN_ENABLED=true`) |

**OCI side** (Console): your instance's **Subnet → Security List → Add Ingress Rules** — add
`0.0.0.0/0` sources for TCP 22/80/443, 7880/7881, and UDP 7882/3478 (each rule: source type CIDR,
`0.0.0.0/0`, destination port range, the right protocol).

**VM side** (Oracle's Ubuntu image ships default-DROP `iptables`; their image has no `ufw` — either
install `ufw` or insert rules). With plain `iptables` (rules persist via the `iptables-persistent`
package):

```bash
sudo apt-get -y install iptables-persistent
for p in 80 443 7880 7881; do sudo iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT; done
for p in 7882 3478;   do sudo iptables -I INPUT 5 -p udp --dport "$p" -j ACCEPT; done
sudo netfilter-persistent save
```

The `-I INPUT 5` positions the accepts **before** the stock `-j REJECT` rule of the Oracle image —
check with `sudo iptables -L INPUT --line-numbers`: the `REJECT` line must come **after** your ACCEPT lines (on Ubuntu 24.04 the stock REJECT is rule 5; inserting at 6 puts your rules behind it and they never match).

## 3. Free domain (DuckDNS)

1. Sign in at [duckdns.org](https://www.duckdns.org) (GitHub login works), add a subdomain, e.g.
   `jorcord`, set its IP to your VM's public IP. Your app will live at
   `https://jorcord.duckdns.org`.
2. Optionally add the duckdns update script (cron) so the record follows a changed public IP —
   Oracle free-tier public IPs are reserved and rarely change.
3. Any other registrar domain pointed at the VM (CNAME / A record) works too; only DuckDNS specifics
   are covered here.

## 4. Configure `.env`

On the VM, next to `docker-compose.yml`:

```bash
cp .env.docker.example .env
openssl rand -base64 48   # once per secret
```

```dotenv
# --- secrets (all random, openssl rand -base64 48) ---
JWT_SECRET=<random-1>
POSTGRES_PASSWORD=<random-2>
LIVEKIT_API_SECRET=<random-3>            # >= 32 chars
MINIO_ROOT_PASSWORD=<random-4>

# --- public address ---
PUBLIC_URL=https://jorcord.duckdns.org
TRUST_PROXY=true                          # Caddy/OCI reverse proxy in front
LIVEKIT_URL=auto                          # signalling rides on the app's own https/wss origin

# --- voice on a VM with a public IP ---
LIVEKIT_NODE_IP=                          # empty: let LiveKit discover the public IP...
LIVEKIT_USE_EXTERNAL_IP=true              # ...via STUN (this is the line that makes media work here)
LIVEKIT_UDP_PORT=7882                     # single UDP media port instead of 50000-50200
LIVEKIT_UDP_PUBLISH=7882:7882/udp         # keeps the port list tiny

# --- TURN for UDP-blocking networks (optional; UDP only, no cert needed) ---
LIVEKIT_TURN_ENABLED=true
LIVEKIT_TURN_DOMAIN=jorcord.duckdns.org
```

These are all supported by `docker-compose.yml` as-is (no compose edit needed): `LIVEKIT_NODE_IP` /
`LIVEKIT_USE_EXTERNAL_IP` map to `rtc.node_ip` / `rtc.use_external_ip`, `LIVEKIT_UDP_PORT` sets
`rtc.udp_port`, `LIVEKIT_UDP_PUBLISH` drives the published ports (switching the default
`50000-50200:50000-50200/udp` for `7882:7882/udp`), and `LIVEKIT_TURN_*` drive the embedded TURN on
3478/udp.

## 5. Start the stack

```bash
docker compose up -d                        # server + postgres + redis + livekit (+ minio only with --profile s3)
curl localhost:3000/health                  # {"status":"ok","db":"pg",...}
docker compose logs -f server               # watch migrations/first boot
```

## 6. HTTPS with Caddy (also readies LiveKit signalling)

Browsers grant microphone access only on `https://` or `localhost`, so TLS is mandatory for an
internet-facing instance. Caddy gets you automatic Let's Encrypt certs for free — a separate
container, no repo files touched:

```bash
sudo mkdir -p /etc/caddy

sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
jorcord.duckdns.org {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
EOF

docker run -d --name caddy --restart unless-stopped \
  --network host \
  -v /etc/caddy/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data -v caddy_config:/config \
  caddy caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
```

The socket-address host-network trick keeps `reverse_proxy 127.0.0.1:3000` simple: compose publishes
the server on host port 3000 (change it with `SERVER_PORT` in `.env`).

* Keep `LIVEKIT_URL=auto`: the server proxies LiveKit signalling at `/livekit` on the same
  https/wss origin, so **no extra port, DNS name or cert** for voice — media still needs the UDP/TCP
  ports from step 2.
* `http://jorcord.duckdns.org` (port 80) redirects to HTTPS automatically once the cert is issued.

## 7. Verify

1. `curl https://jorcord.duckdns.org/health` → `{"status":"ok",...}`; open the app, register
   (SMTP note: without `SMTP_URL=smtp://...` set, verification/reset emails only go to the server
   log — set `SMTP_URL` and `MAIL_FROM` for a real instance).
2. Join a voice channel from **a different device/network** (phone hotspot is the toughest test):
   the voice dock should show UDP (or TURN) as the ICE path. "Connecting…" → check `LIVEKIT_NODE_IP`
   / `LIVEKIT_USE_EXTERNAL_IP` and the 7882/udp + 7881/tcp rules; full checklist in
   [DEPLOY.md § Troubleshooting](./DEPLOY.md#troubleshooting-checklist).
3. `docker compose ps` — everything `Up`/healthy.

## Alternative: LiveKit Cloud free tier for voice

If you would rather not open *any* LiveKit media ports, or you want better voice quality than a
single small VM can provide, use [LiveKit Cloud](https://cloud.livekit.io) (free tier for small
projects; check their current pricing/terms) and keep self-hosting everything else:
the app, database, files and gateway live in the same compose stack as before.

1. Sign in at `cloud.livekit.io`, create a project, and copy from its dashboard: the **WSS URL**
   (like `wss://<project>.livekit.cloud`) and an **API key pair** (key + secret).
2. Comment out this line in `docker-compose.yml` (it hard-binds the server's LiveKit *API* to the
   in-stack container; with the line commented the server falls back to `LIVEKIT_URL` — see
   `apps/server/src/config.ts`):

   ```yaml
   # LIVEKIT_API_URL: http://livekit:7880
   ```

3. `.env` (everything else from step 4 stays):

   ```dotenv
   LIVEKIT_URL=wss://<project>.livekit.cloud   # browser signalling; CSP connect-src derives from it
   LIVEKIT_API_KEY=<cloud-project-api-key>
   LIVEKIT_API_SECRET=<cloud-project-api-secret>
   ```

   The bundled `livekit` compose service stays up but unused (compose pulls the server's
   `depends_on`), so leave it — it is harmless, and its media ports are simply never handed out.
4. In the LiveKit Cloud dashboard, configure the **webhook URL**
   `https://jorcord.duckdns.org/api/v1/voice/webhook` and add the origin `https://jorcord.duckdns.org`
   (**CORS + CSP domains**). The webhook is what clears a vanished client's voice state; the server
   uses RoomService (same key pair) for mute/move — both ride on `LIVEKIT_URL` now.
5. `docker compose up -d` — voice now terminates at Cloud's anycast edge: no 7880/7881/7882/3478
   rules in OCI or iptables, no self-managed UDP. Server-side mute/deafen/move/disconnect, tokens and
   webhook-driven state all keep working because they are driven by the paired
   key/secret above.

Notes:

* Signalling goes browser → Cloud directly (`wss://<project>.livekit.cloud`); it does **not** use
  the app's `/livekit` proxy — that proxy only exists for `LIVEKIT_URL=auto`. Keep 443 TCP open for
  API/gateway/UI.
* Tokens are always minted by *your* server with `LIVEKIT_API_KEY/SECRET` (trusted credentials), so
  cloud keys live only in the VM env.
* E2E-video settings (free-tier analytics, recording) are outside this doc; the app doesn't need
  them for voice/screen share.

## Security & hygiene checklist

- [ ] All four secrets are unique random values (`openssl rand -base64 48`).
- [ ] `TRUST_PROXY=true` because Caddy reverse-proxies; Postgres/Redis/MinIO never published.
- [ ] `CORS_ORIGINS` unset is fine here (same-origin web app); add it only if you host the web
      client elsewhere.
- [ ] Backups: `docker compose exec postgres pg_dump -U jorcord jorcord > backup.sql`, plus the
      `server-data` volume (files) — small `crontab -e` job or snapshot the boot volume.
- [ ] Free-tier caution: keep snapshots of `pg-data` before `docker compose up -d` upgrades.

## Quick reference: what runs where

| Component | Service in compose | Exposed |
|---|---|---|
| Web app / API / gateway | `server` (serves `/`, `/api`, `/gateway`) | 443 TCP via Caddy → host port `${SERVER_PORT:-3000}` |
| Postgres / Redis | `postgres` / `redis` | container network only |
| LiveKit signalling | `livekit` | `/livekit` proxy (auto), or 7880 TCP, or LiveKit Cloud |
| LiveKit media | `livekit` | 7882 UDP (single-port), 7881 TCP fallback, HTTP-443 when Cloud |
| TURN | `livekit` (embedded) | 3478 UDP, optional |
| MinIO admin console | `minio` (profile `s3`) | `127.0.0.1:9001`, local only |
