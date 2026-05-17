# The bridge

[← Dev index](README.md) · Operational detail: [`bridge/README.md`](../../bridge/README.md)

## Why it exists

Alexa Smart Home skills must point at an **AWS Lambda**. The Lambda then needs
to reach *this specific user's* LoxBerry to execute a directive. Three ways to
bridge that gap:

1. **Inbound to the LoxBerry** — the user opens a port + provides public TLS.
   Rejected: puts the home box on the internet, needs DynDNS/cert per user,
   fails behind CGNAT.
2. **Lambda holds connections** — Lambda is request‑scoped and stateless; it
   cannot hold a persistent socket to thousands of homes.
3. **A thin always‑on relay the plugin dials out to** — chosen.

The bridge is that relay. It is the **only component that needs a public,
CA‑signed TLS endpoint**, and it exists so the user does not.

## What it does

- Accepts **plugin‑initiated** WSS connections at `/connect`. The plugin sends
  a `hello {userId}`; the bridge keeps the socket in an in‑memory map
  `userId → socket`.
- Accepts **Lambda → bridge** `POST /dispatch` (authenticated with a shared
  `X-Bridge-Auth` secret). It looks up the `userId`, forwards the
  already‑signed directive frame down that socket, awaits the `response`, and
  returns it to the Lambda.
- `GET /probe` — used during account linking to confirm a plugin is online.
- `GET /pair?code=…` — one‑shot pair‑code lookup (the plugin publishes the
  code→identity mapping over WSS; the bridge holds it with a TTL and deletes on
  first read).
- `POST /event` direction (outbound): forwards signed ChangeReport frames from
  plugins up to the Lambda's `/event`.
- App‑layer ping/pong heartbeat; close codes drive the plugin's reconnect
  policy.

## What it deliberately does NOT do

- **It does not parse or sign directive/response payloads.** End‑to‑end HMAC is
  between Lambda and plugin. The bridge sees opaque, signed bytes — it cannot
  forge a directive or read what is being controlled.
- **It keeps no database.** Routing state is in memory only; a restart drops it
  and plugins reconnect within seconds. Nothing to back up or leak.
- **No per‑user config.** Routing is trust‑on‑first‑use: the latest plugin to
  claim a `userId` over WSS wins (last‑write‑wins).

This is what "the bridge is blind" means concretely — see
[security-model.md](security-model.md).

## Running your own (basics)

You only need this if you want full independence from the project's shared
bridge. (Because of end‑to‑end HMAC, self‑hosting is about *control*, not
closing a security hole.)

The bridge does **not** speak TLS itself — run a TLS‑terminating reverse proxy
in front. The committed `bridge/docker-compose.yml` + `Caddyfile` give a
two‑service stack (bridge + Caddy with automatic Let's Encrypt):

```bash
cd bridge
cp .env.example .env          # set ALOXBERRY_BRIDGE_HOSTNAME, ACME_EMAIL,
                              # BRIDGE_DISPATCH_SECRET (openssl rand -base64 32)
docker compose up -d --build
curl https://<your-hostname>/health
```

Requirements: a host with Docker, a DNS record at its public IP, and TCP 80
(Let's Encrypt HTTP‑01) + 443 open. NAS/alt‑port and **Cloudflare Tunnel**
(for CGNAT / no public IP) are supported. Then point the plugin's
**Bridge URL** (Setup tab) at your hostname, and configure the same
`BRIDGE_DISPATCH_SECRET` on your Lambda side ([aws-backend.md](aws-backend.md)).

Full operator guide — env vars, HTTP/WSS contracts, close codes,
troubleshooting, image build/push — is in
[`bridge/README.md`](../../bridge/README.md).
