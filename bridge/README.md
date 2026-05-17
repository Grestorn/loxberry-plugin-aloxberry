# Aloxberry bridge

Stateless dispatch bridge for the [Aloxberry](../README.md) plugin. Holds
persistent WSS connections from each Loxberry plugin instance and routes
HMAC-signed Alexa directives from the AWS Lambda to the right plugin.

The bridge is the **only** component in the system that needs a public,
CA-signed TLS endpoint. End users running the plugin do not. End-to-end auth
(HMAC) is between AWS Lambda and the plugin, so the bridge sees signed
opaque bytes but cannot forge directives or eavesdrop on commands.

## Architecture

```
[AWS Lambda] ──HTTPS /dispatch──▶ [Caddy / nginx / Cloudflare Tunnel]
                                            │ (TLS terminated here)
                                            ▼ plain HTTP, loopback only
                                         [bridge]
                                            ▲
                                            │ WSS /connect (plugin-initiated)
                                            │
                                     [Loxberry plugin]
```

The bridge does not speak TLS itself. Run a TLS-terminating reverse proxy
(Caddy, nginx, Traefik, Cloudflare Tunnel, …) in front. Caddy is the path
of least resistance — point a DNS record at the host, open ports 80/443,
and Caddy obtains a Let's Encrypt cert automatically.

## Deploy with Docker Compose + Caddy (recommended)

The committed `docker-compose.yml` + `Caddyfile` give you a two-service
stack: the bridge on an internal port, and Caddy in front handling
Let's Encrypt TLS. Total operator config: one `.env` file.

### Prerequisites

- A host running Docker Engine ≥ 20 and Docker Compose v2 (Linux, Windows
  Docker Desktop, or macOS Docker Desktop all work).
- A DNS A/AAAA record pointing at the host's public IP. DynDNS hostnames
  work fine.
- **Ports 80 and 443 (TCP) open and forwarded** to the host from the public
  internet. Port 80 is required for Let's Encrypt's HTTP-01 challenge
  (issuance + ~60-day renewals); port 443 is the public HTTPS+WSS endpoint.

### First-time setup

```bash
cd bridge

# 1. Configure.
cp .env.example .env
# Edit .env: set ALOXBERRY_BRIDGE_HOSTNAME, ACME_EMAIL, BRIDGE_DISPATCH_SECRET.
# Generate the secret with:
#   openssl rand -base64 32
# or:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# 2. Launch.
docker compose up -d --build

# 3. Watch Caddy issue the cert. The first request blocks for ~30 s while
#    Let's Encrypt completes the HTTP-01 challenge.
docker compose logs -f caddy
# → look for: "certificate obtained successfully"

# 4. Verify from the public internet.
curl https://<your-hostname>/health
# → {"status":"ok","uptimeSeconds":N,"connections":0,"pendingDispatches":0}
```

### Running on a NAS / alt-port deployment

The default `docker-compose.yml` publishes Caddy on host port 443. NAS
deployments (Synology, QNAP, Unraid, TrueNAS, …) typically have a web UI
already on 443, so the bridge needs a different serving port.

Set `HTTPS_PORT` in `.env`:

```
HTTPS_PORT=8443
```

Then:

- Open **TCP 80 + TCP 8443** on your router (still keep your NAS's 443 alone).
- `docker compose up -d` — Compose recreates the Caddy container with the
  new port mapping. Your cached cert is reused (certs are keyed by hostname,
  not port).
- When you paste the bridge URL into Alexa's OAuth form, include the port:
  `https://bridge.example.com:8443`.

Verify:

```bash
curl https://<your-hostname>:8443/health
```

**If port 80 is also taken on your NAS** (common — many NAS UIs use 80 to
redirect to 443), HTTP-01 won't work. Two ways out:

1. **DNS-01 challenge.** Caddy proves domain ownership via a DNS TXT record
   instead of port 80. Requires a DNS provider with a programmable API
   (Cloudflare free tier is the common choice) and a custom Caddy build
   that includes the DNS-provider plugin. Not yet wired into this repo —
   open a request if you need it.
2. **Cloudflare Tunnel.** Cloudflare terminates TLS at its edge; an
   outbound `cloudflared` daemon brings traffic to your bridge over a
   tunnel. No inbound ports at all. Outline in the "Alternative: Cloudflare
   Tunnel" section below.

### First-time gotcha — Let's Encrypt rate limits

Production Let's Encrypt allows **5 duplicate certificates per registered
domain per week**. If you tear down and rebuild the stack a few times
during testing you can hit this limit, and Caddy will refuse to start
the public endpoint until the week resets.

While testing, uncomment the staging endpoint in `Caddyfile`:

```
acme_ca https://acme-staging-v02.api.letsencrypt.org/directory
```

Staging certs are signed by Let's Encrypt's untrusted "Fake LE" CA — your
browser will warn, and **AWS Lambda will refuse the TLS handshake**, so
flip back to production (delete the `caddy_data` volume to drop the
staging cert, then `docker compose up -d`) before account-linking.

## Alternative: Cloudflare Tunnel (no public IP / CGNAT)

If your ISP has put you behind CGNAT (common on mobile / 4G routers) or
you can't open ports 80/443, Cloudflare Tunnel lets you reach the bridge
without inbound port forwarding. Cloudflare terminates TLS at its edge
and brings traffic to your bridge over an outbound tunnel.

High-level recipe (full walkthrough out of scope here):

1. Create a Cloudflare account and add the hostname's zone to Cloudflare.
2. Install `cloudflared` on the host. `cloudflared tunnel login`.
3. `cloudflared tunnel create aloxberry-bridge`.
4. Point the hostname's CNAME at the tunnel.
5. Configure ingress: `https://<hostname>` → `http://localhost:8080`.
6. Run the bridge service only (no Caddy needed):

   ```bash
   docker compose up -d bridge
   docker compose port bridge 8080   # confirm the port is exposed
   ```

   You'll need to add a `ports: ["127.0.0.1:8080:8080"]` mapping to the
   `bridge` service so `cloudflared` running on the host can reach it.

## Alternative: bare Node (development only)

Useful only when iterating on bridge code locally — has no TLS, no public
endpoint, no real OAuth integration.

```bash
cd bridge
npm install
cp .env.example .env       # set BRIDGE_DISPATCH_SECRET; ignore hostname/email
node src/index.js
curl http://localhost:8080/health
```

## Environment variables

| Name | Required | Default | Purpose |
| --- | --- | --- | --- |
| `ALOXBERRY_BRIDGE_HOSTNAME` | yes (compose) | — | Public hostname Caddy obtains a cert for. |
| `ACME_EMAIL` | no | — | Let's Encrypt account email. Recommended (renewal-failure alerts). |
| `HTTPS_PORT` | no | `443` | HTTPS port Caddy serves on. Set to e.g. `8443` when 443 is taken on the host (NAS deployments). Port 80 is still required for HTTP-01 regardless. |
| `BRIDGE_DISPATCH_SECRET` | yes | — | Shared secret with AWS Lambda. Sent as `X-Bridge-Auth` on `/dispatch` and `/probe` inbound; also on `/event` outbound (Phase 4). Mirror in SSM at `/loxberry-alexa/bridge-dispatch-secret`. |
| `LAMBDA_EVENT_URL` | no (Phase 4) | — | Lambda's `/event` endpoint URL — `<OAuthBaseUrl>/event` from the SAM stack output. The bridge POSTs daemon-originated ChangeReports here. Empty value disables outbound forwarding gracefully (daemon still emits; bridge logs + drops). Inbound directives are unaffected. |
| `PORT` | no | `8080` | TCP port the bridge listens on inside the container. |
| `LOG_LEVEL` | no | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal`. |
| `HELLO_TIMEOUT_MS` | no | `5000` | Per-connection deadline for the first `hello` message. |
| `HEARTBEAT_INTERVAL_MS` | no | `30000` | App-layer ping cadence. Must be less than your intermediary's WS idle cap (Cloudflare = 100 s). |
| `PONG_TIMEOUT_MS` | no | `60000` | Plugin must pong within this window. Should be ≥ 2× heartbeat interval. |
| `DISPATCH_TIMEOUT_MS` | no | `10000` | Plugin must respond to a forwarded directive within this window. Alexa's own Lambda budget is 8 s. |

## HTTP surface

| Path | Method | Status | Purpose |
| --- | --- | --- | --- |
| `/health` | GET | implemented | Operator monitoring. Returns connection count, pending dispatches, uptime. |
| `/dispatch` | POST | implemented | Lambda → bridge: forward a directive to a plugin. See contract below. |
| `/probe` | GET | implemented | Lambda → bridge: is a given `userId` currently connected? See contract below. |
| `/connect` | WS upgrade | implemented | Plugin → bridge: open the persistent WSS. See protocol below. |

Outbound (Phase 4): the bridge also originates HTTPS requests *to* the Lambda
when a plugin pushes a `report` frame over WSS. The destination URL is
`LAMBDA_EVENT_URL` and the request is documented under "Phase 4 outbound"
below.

## `/dispatch` contract

The AWS Alexa handler Lambda POSTs to `https://<bridge>/dispatch`. The
bridge authenticates the request, forwards the (already HMAC-signed) payload
to the right plugin over its persistent WSS, awaits a `response`, and returns
that response to Lambda. The bridge does not parse or sign directive
contents — end-to-end auth is between Lambda and plugin.

### Request

```http
POST /dispatch HTTP/1.1
X-Bridge-Auth: <BRIDGE_DISPATCH_SECRET>
Content-Type: application/json

{
  "userId":   "<22-char base64url>",
  "directive": { /* Alexa directive envelope */ },
  "headers":   {
    "x-aloxberry-timestamp": "<unix ms>",
    "x-aloxberry-signature": "<HMAC-SHA256, base64url>"
  }
}
```

Max request body: 256 KB.

### Response

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | Plugin's Alexa response envelope | Success — forward to Alexa. |
| `400` | `{ "error": "invalid_json" \| "invalid_body" \| "invalid_userId" \| "invalid_directive" \| "invalid_headers" \| "payload_too_large" }` | Malformed request — Lambda bug. |
| `401` | `{ "error": "unauthorized" }` | Missing or wrong `X-Bridge-Auth`. |
| `503` | `{ "error": "not_configured" }` | Bridge has no `BRIDGE_DISPATCH_SECRET` env var. Fix the deployment. |
| `504` | `{ "error": "offline" }` | Plugin not currently connected, or disconnected mid-dispatch. |
| `504` | `{ "error": "timeout" }` | Plugin acknowledged the directive (connection alive) but didn't respond within `DISPATCH_TIMEOUT_MS` (default 10 s). |

Lambda should translate all 504s into Alexa's `ENDPOINT_UNREACHABLE`. 401 / 503 should page the bridge operator (or you).

## `/probe` contract

Used during OAuth account linking. After the user pastes the bridge URL +
connection credential into the Alexa `/authorize` form, Lambda calls
`/probe` to confirm the plugin on their Loxberry is actually online before
completing the link. If `connected: false`, the OAuth flow surfaces a clear
"your Loxberry isn't reachable from the bridge yet" message instead of
silently linking a dead account.

### Request

```http
GET /probe?userId=<22-char base64url> HTTP/1.1
X-Bridge-Auth: <BRIDGE_DISPATCH_SECRET>
```

### Response

| Status | Body | Meaning |
| --- | --- | --- |
| `200` | `{ "connected": true }` | A plugin with this `userId` has an open WSS to the bridge right now. |
| `200` | `{ "connected": false }` | No active connection. Either the plugin has never connected with this `userId`, or it has disconnected. The bridge cannot tell those two apart (no persistence by design). |
| `400` | `{ "error": "missing_userId" \| "invalid_userId" }` | Lambda bug. |
| `401` | `{ "error": "unauthorized" }` | Wrong or missing `X-Bridge-Auth`. |
| `503` | `{ "error": "not_configured" }` | Bridge has no `BRIDGE_DISPATCH_SECRET` env var. |

## Phase 4 outbound: bridge → Lambda `/event`

When the plugin observes a Loxone state change on an exposed device, it
emits a signed ChangeReport over the existing WSS upstream as a `report`
frame. The bridge forwards the inner payload to the Lambda's `/event`
endpoint — same end-to-end HMAC pattern as `/dispatch`, just reversed.

### WSS `report` frame (plugin → bridge)

```json
{
  "type": "report",
  "timestamp": "<unix ms, daemon clock>",
  "signature": "<HMAC-SHA256 hex>",
  "payload":   "<canonical JSON string>"
}
```

`payload` is signed as `${timestamp}\n${payload}` with the plugin's
per-pairing `skillSecret`. The bridge does **not** parse `payload` — it
forwards the exact bytes to the Lambda, preserving the signature.

The bridge does not ack the frame back to the plugin. State events are
self-resetting (the next transition replaces a missed one); a buffered
ack/retry layer would add complexity for negligible reliability gain.

### HTTP POST (bridge → Lambda)

```http
POST /event HTTP/1.1
Host: <Lambda OAuth API Gateway host>
Content-Type: application/json
X-Bridge-Auth: <BRIDGE_DISPATCH_SECRET>
X-Aloxberry-Timestamp: <timestamp from the WSS frame>
X-Aloxberry-Signature: <signature from the WSS frame>

<payload bytes from the WSS frame, verbatim>
```

The destination URL is `LAMBDA_EVENT_URL`. If unset, the bridge logs a
single `LAMBDA_EVENT_URL not set — dropping report` and discards the
frame; the rest of the bridge keeps working. Timeout: 5 s; failures log
and drop (no retry).

The Lambda's response shape (for operators reading the bridge logs):

| Status | Meaning |
| --- | --- |
| `200 { "delivered":N, "failed":M }` | Lambda fanned the event out to N+M Alexa users (some may have failed downstream at the Event Gateway). |
| `200 { "delivered":0, "reason":"no_users" }` | No matching user rows in DDB. The `bridgeUserId` in the payload doesn't have any linked Alexa accounts. |
| `401 { "error":"unauthorized" }` | `X-Bridge-Auth` didn't match the SSM secret. Bridge / Lambda are out of sync on `BRIDGE_DISPATCH_SECRET`. |
| `401 { "error":"invalid_signature" }` | `X-Aloxberry-*` didn't verify against the user's `skillSecret`. Forged report or skillSecret rotated without the plugin knowing. |
| `400 { "error":"invalid_body" }` | Bridge passed through a payload that wasn't JSON or didn't have `bridgeUserId` + `changeReport`. Plugin bug. |
| `503 { "error":"bridge_dispatch_secret_unconfigured" }` | Lambda has no `BRIDGE_DISPATCH_SECRET_PARAM` configured. Deploy issue. |

## WSS protocol (v1)

The plugin opens a long-lived WebSocket to `wss://<bridge>/connect` and keeps
it open with app-layer ping/pong. The first message must be a `hello`; until
that arrives the bridge holds the socket open for at most `HELLO_TIMEOUT_MS`
(default 5 s) then closes with code `4005`.

### Messages

| Direction | Type | Shape |
| --- | --- | --- |
| Plugin → bridge | `hello` (first) | `{ "type":"hello", "userId":"<22-char base64url>", "version":1 }` |
| Bridge → plugin | `welcome` | `{ "type":"welcome", "version":1 }` |
| Bridge → plugin | `ping` | `{ "type":"ping" }` — every `HEARTBEAT_INTERVAL_MS` (default 30 s) |
| Plugin → bridge | `pong` | `{ "type":"pong" }` — required to keep the connection alive |
| Bridge → plugin | `directive` | `{ "type":"directive", "requestId", "directive", "headers" }` |
| Plugin → bridge | `response` | `{ "type":"response", "requestId", "response" }` |
| Plugin → bridge | `report` (Phase 4) | `{ "type":"report", "timestamp", "signature", "payload" }` — see Phase 4 outbound below |

`userId` is 16 random bytes generated by the plugin on first install, encoded
base64url (exactly 22 chars in `[A-Za-z0-9_-]`). 128 bits of entropy make
collisions and hijacking computationally infeasible. The plugin combines
`userId` with the `skillSecret` (HMAC key, separate) into the opaque
"connection credential" the user pastes into the Alexa OAuth form.

### Close codes

| Code | Meaning | Plugin reaction |
| --- | --- | --- |
| `4002` | Protocol error (bad json, bad shape, bad version, bad userId, duplicate hello) | **Do not retry-storm.** Misconfiguration — log + surface to the user. |
| `4003` | Replaced — a newer connection took this `userId` | Reconnect once after short delay. Most likely the plugin was restarted on the same Loxberry. |
| `4004` | Heartbeat timeout (no pong within `PONG_TIMEOUT_MS`) | Reconnect with exponential backoff (1 s → 60 s cap). |
| `4005` | Hello timeout — handshake not received within the window | Bug in the plugin; reconnect cautiously. |

## Operating the bridge

### Watching it run

```bash
# Live log stream (bridge logs are structured JSON; Caddy logs are
# console-formatted by default).
docker compose logs -f bridge
docker compose logs -f caddy

# Health endpoint — connection count + uptime + pending dispatches.
curl https://<your-hostname>/health
```

Log lines worth watching for:

| Log message | Meaning |
| --- | --- |
| `bridge listening` | Bridge process up. |
| `plugin connected` (with `userId`, `totalConnections`) | A Loxberry just registered. `totalConnections` is the bridge's invariant. |
| `replacing existing connection` | A plugin reconnected and bumped an older socket with the same userId. Normal after a plugin restart. |
| `plugin disconnected` (with `dispatchesRejected`) | Plugin's WSS dropped. If `dispatchesRejected > 0`, in-flight dispatches were short-circuited to 504 (good — beats waiting the full timeout). |
| `heartbeat timeout` | Plugin failed to pong within `PONG_TIMEOUT_MS`. Network blip or hung plugin process. |
| `/dispatch: plugin offline` | Lambda dispatched to a userId with no active connection. Expected during plugin downtime; investigate if persistent. |

### Updating the bridge (local Caddy stack)

```bash
cd bridge
git pull
docker compose up -d --build
```

Compose recreates only the changed containers. Existing plugin connections
to the old `aloxberry-bridge` container are dropped during the swap; plugins
auto-reconnect within a few seconds (the bridge keeps no state worth
preserving across restarts).

### Updating the bridge (nginx-proxy / registry deployment)

The `bridge/nginx-proxy/` deployment pulls the image from
`ghcr.io/grestorn/aloxberry-bridge:latest` rather than building locally.
After bridge source changes, build + push a new image with:

```bash
./bridge/build-and-push.sh
```
```powershell
.\bridge\build-and-push.ps1
```

Both scripts tag the image as `latest` (rolling, what
`docker compose pull` grabs on the bridge host) **and** as
`git-<short-sha>` (immutable, your rollback target). Options:

- `--build-only` / `-BuildOnly` — build the image without pushing. Useful
  to smoke-test the Dockerfile before committing to a push.
- `--tag <name>` / `-Tag <name>` — also tag + push as `<name>`. Use for
  release tags (e.g. `--tag v0.2.0`).

One-time prerequisite:
```
docker login ghcr.io
```
Use a GitHub PAT with `write:packages` scope as the password. The
credential persists in `~/.docker/config.json`.

After a successful push, deploy on the bridge host:
```
ssh <bridge-host>
cd /opt/dockerapp/aloxberry-bridge
docker compose pull && docker compose up -d
```

To roll back, change the `image:` line in
`/opt/dockerapp/aloxberry-bridge/docker-compose.yaml` from `:latest` to a
specific `git-<sha>` tag, then `docker compose up -d` again.

### Stopping / removing

```bash
docker compose down            # stops services, keeps caddy_data volume
docker compose down -v         # also drops the volume → forces fresh cert
```

Keep `caddy_data` unless you really need a fresh cert. Letting Caddy reissue
on every `down` will burn through Let's Encrypt's rate limits fast.

## Troubleshooting

### Caddy fails to obtain a cert

Symptoms in `docker compose logs caddy`:

- `unable to bind to port 80/tcp: address already in use` — something else
  on the host owns port 80. On Windows, the usual suspects are IIS (the
  World Wide Web Publishing Service) and the `http.sys` driver reserving
  ports for other apps. Stop the offending service or change the port
  binding (but Let's Encrypt HTTP-01 *requires* port 80 publicly).
- `connection refused` during HTTP-01 challenge — your router isn't
  forwarding 80 to the host, or the host firewall is blocking inbound.
  Test from outside with `curl -v http://<your-hostname>/.well-known/acme-challenge/test`
  (any path on port 80 should reach Caddy).
- `DNS problem: NXDOMAIN looking up A for <hostname>` — the DNS record
  doesn't exist yet, or hasn't propagated. Verify with
  `dig +short <hostname>` from a public DNS resolver.
- `too many certificates already issued for exact set of domains` —
  Let's Encrypt rate limit hit. Switch to the staging endpoint until the
  weekly window resets.

### Plugin can't connect

From the bridge side, plugin connection attempts show up as `plugin connected`
log lines. If you never see those:

- TLS error in Caddy's logs (`tls handshake failed`) — your plugin trusts
  the wrong CA. If you're using Let's Encrypt staging, the plugin's TLS
  stack will reject the cert; flip Caddy to production.
- 404 from Caddy on the WSS upgrade — the request hit the wrong vhost.
  Check `Caddyfile` hostname against the plugin's configured bridge URL.
- Plugin logs show `close 4002` immediately after `open` — userId is malformed
  or protocol version mismatch. Plugin bug, not a bridge issue.

### Dispatches keep returning 504

- `{"error":"offline"}` — the plugin isn't connected. Check
  `curl https://<bridge>/health` — `connections` should be ≥ 1 once at
  least one plugin is registered.
- `{"error":"timeout"}` — connection is alive but the plugin took longer
  than `DISPATCH_TIMEOUT_MS` to respond. Likely a Loxone Miniserver call
  is blocking. Investigate the plugin daemon, not the bridge.

### Windows-specific notes

- Docker Desktop on Windows binds container ports via WSL2's networking
  stack. If `docker compose ps` shows the ports bound but external requests
  don't reach the host, run `netsh interface ipv4 show excludedportrange protocol=tcp`
  and check that 80/443 aren't in a reserved range (sometimes Hyper-V grabs
  them). Workaround: reboot, or restart the `winnat` service.
- Windows Firewall will silently drop inbound 80/443 if Docker Desktop
  didn't add a firewall rule. Allow `Docker Desktop Backend` for public
  networks, or add explicit rules.

## Operator notes

- **State is in-memory only.** A restart drops every routing entry; plugins
  reconnect within seconds. No SQLite, no Redis. Phase 4 may add optional
  persistence; not before.
- **The bridge cannot impersonate users.** HMAC keys live only with AWS
  Lambda and the plugin. If you operate a community bridge, you can refuse
  to route or observe metadata, but you cannot forge a directive or read
  command payloads in cleartext.
- **No per-user config on the bridge side.** Routing is TOFU: the first
  plugin to claim a `userId` over WSS wins until the connection drops or a
  new plugin reconnects with the same `userId` (last-write-wins).
- **Nothing to back up.** The only stateful component is `caddy_data`
  (issued cert + ACME account); losing it just triggers a one-time
  re-issue. The bridge itself is fully ephemeral.
