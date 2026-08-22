# Project: Aloxberry — Loxberry Alexa Smart Home Plugin

## Goal
Build an open-source Alexa Smart Home Skill integration for the Loxone home automation
system, running on a Loxberry (Raspberry Pi). The solution must be multi-tenant: a single
shared AWS backend serves many independent Loxberry installations.

---

## Architecture Overview

[Alexa+]
│  Smart Home Directives
▼
[AWS Lambda: alexa-handler]
│  Lookup user → Loxberry URL
▼
[DynamoDB: users table]
│
▼
[HTTPS call to user's Loxberry]
│  REST
▼
[Loxberry Plugin: local HTTP endpoint]
│  Loxone HTTP API
▼
[Loxone Miniserver]

Account Linking OAuth flow:
[Alexa App] → [API Gateway] → [Lambda: oauth-handler] → [DynamoDB] → redirect back to Alexa

---

## Repository Structure

Create a monorepo with two top-level packages:

/aws/
lambda/
alexa-handler/     # Smart Home Skill dispatcher
oauth-handler/     # OAuth2 Authorization Code Grant server
shared/            # Shared DynamoDB client, token utils
infrastructure/
template.yaml      # AWS SAM template (all resources declared here)
scripts/
deploy.sh

/loxberry-plugin/
LOXBERRY/
SYSTEM/
plugin.cfg       # Loxberry plugin manifest
WEBFRONTEND/
config/          # Plugin config UI (HTML/JS)
BIN/
server.js        # Local HTTP server (the Alexa endpoint)
TEMPLATES/
device-mapping.json.example

---

## Tech Stack

- AWS Lambda: Node.js 20.x
- AWS SAM for infrastructure-as-code
- DynamoDB for persistence
- Loxberry plugin: Node.js (already available on Loxberry)
- No external frameworks beyond AWS SDK v3

---

## Component 1: AWS SAM Template

Define in template.yaml:

Resources:
- AlexaHandlerFunction (Lambda, trigger: Alexa Smart Home)
- OAuthHandlerFunction (Lambda, trigger: API Gateway HTTP API)
- UsersTable (DynamoDB, PK: userId)
- AuthCodesTable (DynamoDB, PK: code, TTL: 600 seconds)

Outputs:
- OAuthBaseUrl (API Gateway URL, needed for Alexa skill configuration)
- AlexaHandlerArn (needed for Alexa skill configuration)

---

## Component 2: OAuth Handler (oauth-handler/index.js)

Implement Authorization Code Grant flow as required by Alexa Account Linking.

Routes (all handled by one Lambda via API Gateway path routing):

GET  /authorize
- Render an HTML registration page (inline, no S3 needed)
- Fields: Loxberry URL, Loxberry username, Loxberry password
- On load: pass through state and redirect_uri as hidden form fields

POST /authorize
- Validate form input
- Test connectivity: make a GET request to {loxberryUrl}/alexa/ping
- If reachable: generate userId (UUID v4), store in UsersTable
- Generate authCode (UUID v4), store in AuthCodesTable with TTL
- Redirect to: {redirect_uri}?code={authCode}&state={state}

POST /token
- Exchange authCode for accessToken + refreshToken
- accessToken = JWT signed with a secret (payload: userId, exp: 1h)
- refreshToken = opaque UUID stored in UsersTable
- Return standard OAuth token response JSON

---

## Component 3: Alexa Handler (alexa-handler/index.js)

Entry point: receives all Alexa Smart Home directives.

Flow for every directive:
1. Extract Bearer token from directive.endpoint.scope.token
2. Verify JWT → extract userId
3. Look up userId in UsersTable → get loxberryUrl
4. Forward directive to Loxberry: POST {loxberryUrl}/alexa/directive
5. Return Loxberry's response to Alexa

Handle these directive namespaces:
- Alexa.Discovery          → forward, return discovery response
- Alexa.PowerController    → TurnOn / TurnOff
- Alexa.BrightnessController → SetBrightness / AdjustBrightness
- Alexa.ColorTemperatureController → SetColorTemperature
- Alexa.ThermostatController → SetTargetSetpoint / AdjustTargetSetpoint
- Alexa.RangeController    → SetRangeValue / AdjustRangeValue (blinds)
- Alexa.SceneController    → Activate (for Loxone moods)
- Alexa.PlaybackController → Play / Pause / Stop / Next / Previous
- Alexa.Speaker            → SetVolume / AdjustVolume / SetMute
- Alexa.ReportState        → forward, return current device state
- Alexa.Authorization.AcceptGrant → store Alexa event gateway token

Error handling:
- Loxberry unreachable → return Alexa ENDPOINT_UNREACHABLE error response
- Invalid token → return INVALID_AUTHORIZATION_CREDENTIAL

---

## Component 4: Loxberry Plugin

The plugin runs a local Express HTTP server on a configurable port (default: 3088).
Nginx on the Loxberry must proxy this to HTTPS (document the nginx config snippet).

### Endpoints:

GET  /alexa/ping
- Returns 200 OK, used during registration to verify connectivity

POST /alexa/directive
- Authenticated with a shared secret (set during plugin setup, stored in plugin config)
- Parses the Alexa directive
- Routes to the appropriate Loxone handler (see Device Mapping below)
- Returns Alexa-formatted response

GET  /webfrontend/config
- Serves the plugin configuration UI
- Shows: plugin status, device mapping table, Loxberry public URL setting

### Device Mapping:

Users configure a mapping from Loxone object UUIDs to Alexa endpoints.
Stored in TEMPLATES/device-mapping.json

Schema per device:
{
"endpointId": "lox-light-wohnzimmer",
"friendlyName": "Wohnzimmer Licht",
"displayCategory": "LIGHT",
"loxoneUuid": "0fb34b23-...",
"loxoneRoom": "Wohnzimmer",
"capabilities": ["PowerController", "BrightnessController"]
}

Supported displayCategories (implement these first):
LIGHT, THERMOSTAT, INTERIOR_BLIND, EXTERIOR_BLIND, SCENE_TRIGGER,
SPEAKER, SWITCH, TEMPERATURE_SENSOR

### Loxone API Integration:

Use the Loxone Miniserver HTTP API.
Base URL from plugin config: http://{miniserverIp}/

Key endpoints:
- GET  /jdev/sps/io/{uuid}/On       → turn on
- GET  /jdev/sps/io/{uuid}/Off      → turn off
- GET  /jdev/sps/io/{uuid}/{value}  → set value (0-100 for dimmer)
- GET  /jdev/cfg/api                → test connectivity
- GET  /jdev/sps/status             → get all current states

Audio Server (Loxone Multiroom):
- GET /audio/cfg/all                → list zones and sources
- GET /audio/{zone}/play            → start playback
- GET /audio/{zone}/pause           → pause
- GET /audio/{zone}/volume/{val}    → set volume
- GET /audio/{zone}/next            → skip track
- GET /audio/{zone}/prev            → previous track

---

## DynamoDB Schema

Table: alexa-loxberry-users
PK: userId (String)
Attributes:
loxberryUrl: String         # https://martin.example.com
sharedSecret: String        # HMAC secret for Lambda↔Loxberry auth
refreshToken: String
alexaEventToken: String     # for proactive state updates (future)
createdAt: String (ISO)

Table: alexa-loxberry-authcodes
PK: code (String)
Attributes:
userId: String
redirectUri: String
createdAt: String (ISO)
ttl: Number                 # Unix timestamp, DynamoDB TTL attribute

---

## Security Requirements

- Lambda ↔ Loxberry communication: HMAC-SHA256 request signing
  (Lambda signs each request with the user's sharedSecret,
  Loxberry plugin verifies the signature)
- Loxberry must be reachable via HTTPS with a valid certificate
  (Let's Encrypt / DynDNS setup is user's responsibility; document this)
- JWT access tokens: HS256, 1-hour expiry
- Refresh tokens: opaque, stored server-side, rotated on each use
- All secrets in AWS Systems Manager Parameter Store (not hardcoded)

---

## Implementation Order

Phase 1 – AWS Infrastructure
1. SAM template with all resources
2. OAuth handler (authorize + token endpoints)
3. Alexa handler (Discovery + PowerController only)
4. Deploy and verify with Alexa Developer Console

Phase 2 – Loxberry Plugin Core
5. Plugin scaffold (plugin.cfg, Express server)
6. /alexa/ping and /alexa/directive endpoints
7. Loxone API client module
8. PowerController → Loxone on/off
9. BrightnessController → Loxone dimmer
10. Basic config UI (enter Miniserver IP, credentials)

Phase 3 – Full Device Support
11. ThermostatController
12. RangeController (blinds/shading)
13. SceneController (Loxone moods)
14. PlaybackController + Speaker (Loxone Audio Server)

Phase 4 – Polish
15. Device mapping UI (visual editor in Loxberry web frontend)
16. ReportState (proactive state updates to Alexa)
17. Error handling, logging, retry logic
18. README with complete setup guide

---

## Key Constraints

- The Lambda function must be deployed in eu-west-1 (Ireland) for German/EU Alexa skills
- Alexa requires the OAuth redirect to be HTTPS with a valid certificate (API Gateway handles this)
- Smart Home Skills do NOT require an invocation name (no "Alexa, open XYZ")
- Maximum 300 endpoints per user (Alexa API limit)
- The plugin must work offline (Loxone local network) if the Loxberry loses internet;
  in that case Alexa simply returns an error – gracefully handle this in the Lambda

---

## Start Here

Begin with Phase 1. Create the SAM template first, then implement the OAuth handler,
then the Alexa handler skeleton. Provide all code in JavaScript (Node.js 20.x).
Use AWS SDK v3 (@aws-sdk/client-dynamodb, @aws-sdk/util-dynamodb).
Do not use any web framework in Lambda — use plain HTTP parsing.
Use the 'jose' library for JWT handling.

---

## Phase 1 — Outcome (verified 2026-05-09)

Phase 1 is deployed in eu-west-1 under stack name `loxberry-alexa`, account
`686404584210`, and successfully exercises the full OAuth + AcceptGrant flow.
The skill is registered as **"Aloxberry"** in the Alexa Developer Console
(skill ID `amzn1.ask.skill.37227f9d-0003-4054-be97-3123db79149f`).

### What's deployed
- Two Lambdas: `loxberry-alexa-oauth-prod`, `loxberry-alexa-directive-prod` (Node.js 24 on arm64).
- Two DynamoDB tables: `alexa-loxberry-users-prod`, `alexa-loxberry-authcodes-prod`.
- HTTP API Gateway (OAuth base URL output by stack).
- SSM SecureString at `/loxberry-alexa/jwt-secret`.

### Diversions from the original plan
- **Runtime bumped** from `nodejs20.x` → `nodejs24.x` (20.x deprecated in AWS).
- **Smart Home Lambda permission** is declared manually (`alexa-connectedhome.amazon.com` principal) instead of SAM's `Type: AlexaSkill` event source, which uses the wrong principal (`alexa-appkit.amazon.com`, for Custom skills).
- **SSM IAM** uses an inline `Statement` with explicit ARN construction; SAM's `SSMParameterReadPolicy` template assumes the parameter name has no leading slash and produces a malformed ARN otherwise.
- **Aloxberry rebrand**: top-level repo and plugin identity renamed to `loxberry-plugin-aloxberry` / `alexa-aloxberry` / "Aloxberry"; npm scope `@loxberry-alexa/*` → `@aloxberry/*`. **AWS resource names retained** (rename would require stack recreation + re-link).

### Verified flows
- OAuth /authorize → Loxberry HMAC probe (currently uses httpbin.org/anything as a stand-in for the real plugin) → user.registered → /token issued JWT.
- Alexa AcceptGrant directive reaches Smart Home Lambda; JWT round-trips successfully.
- Account linking completes in the Alexa mobile app.

### Known follow-ups
- PKCE not yet implemented in OAuth.
- client_id/secret validation not enforced in /token (currently accepts any).
- Refresh-token grant relies on a DDB Scan (no GSI yet).
- AcceptGrant code is acknowledged but not exchanged for an Alexa Event Gateway token (Phase 4 will add LWA token exchange against `api.amazon.com/auth/o2/token`).

---

## Phase 2 — Basic Configuration Page Specification

The first config page covers everything needed for the skill to reach a Loxone
Miniserver. Decisions agreed 2026-05-10. **NOTE:** the original spec had a
"Public reachability" section with a public URL field and CGNAT detection;
those are eliminated by the Phase 2.5 bridge architecture (the plugin no
longer needs an inbound HTTP path — it dials *out* to the bridge). The
revised page has three sections:

### Section 1 — Bridge connection
- **Bridge URL** (text input, default = community bridge URL TBD, e.g.
  `https://bridge.aloxberry.example.com`). User can override to self-hosted.
- **Connection credential** — auto-generated `base64url(userId|skillSecret)`,
  shown with a "Copy connection credential" button. Regenerate button with
  explicit warning ("This invalidates your current Alexa link; you'll need
  to re-link in the Alexa app").
- **Connection status** (live indicator):
  - "Connected to bridge — last heartbeat Ns ago" (green)
  - "Reconnecting — last attempt Ns ago" (yellow)
  - "Disconnected — see logs" (red)
- Last successful directive timestamp ("Last directive received: 30s ago"
  or "Never").

### Section 2 — Skill linking instructions
- Step-by-step Alexa-app walkthrough with screenshots (filled in after we
  test the flow).
- Two values to paste in Alexa OAuth /authorize form:
  - Bridge URL (prefilled or quoted from Section 1).
  - Connection credential (one-click copy from Section 1).
- "Test skill connection" button — sends a round-trip through AWS Lambda
  via a new `/test-skill-connection` endpoint that pushes a synthetic
  Discovery directive back through the bridge to the plugin.

### Section 3 — Miniserver
- Dropdown populated from `LoxBerry::System::get_miniservers()`.
- If empty: plugin disables itself; banner CTA links to LoxBerry's Miniserver settings page.
- "Test connection" button — calls `/jdev/cfg/api` via `LoxBerry::IO::mshttp_call`; shows firmware version on success.
- Status indicator: "Last Miniserver call: ✓ Ns ago" or "✗ Last error".
- **No credential fields. No token storage.** LoxBerry handles all of that.

### Decisions deferred
- Encrypting plugin local config: moot. We don't store Miniserver
  credentials (LoxBerry does). `skillSecret` is HMAC-only — losing it
  invalidates an Alexa link, doesn't expose any user data. Standard
  LoxBerry config storage is fine.
- HTTPS on the plugin: **out of scope.** Plugin doesn't accept inbound
  HTTPS at all in the new architecture; only outbound WSS to the bridge.
- DynDNS section in original spec: **removed.** Not needed; bridge has
  the public endpoint, plugin doesn't.

### AWS-side additions implied
- `POST /test-skill-connection` (HMAC-signed by plugin) — Lambda pushes a
  synthetic Discovery directive via the bridge to the plugin to round-trip
  an active connection test.

(The original spec also called for `GET /probe?url=` for outbound URL
validation + CGNAT detection; not needed in the bridge architecture.)

---

## Phase 2.5 — Bridge component (shipped 2026-05-12)

The original plan assumed `Alexa → Lambda → [user's public Loxberry endpoint]`. That
forces every end user to operate a public CA-signed TLS endpoint, which is the
single biggest UX barrier (DynDNS, port-forward, Let's Encrypt, no usable
LoxBerry plugin in 2026 to automate it). Pivoted to a **bridge component**,
which now ships in `bridge/` and is running publicly at `grestorn.dyndns.org`.

### New top-level architecture

```
[Alexa Cloud]
     │
     ▼
[AWS Lambda] ──HTTPS──▶ [Bridge: stateless dispatch via routing map]
                              ▲                ▲
                              │ WSS (persistent, plugin-initiated)
                              │
                        [Loxberry plugin]   [Loxberry plugin]   ...
                              │                 │
                              ▼                 ▼
                        [Miniserver]      [Miniserver]
```

### Requirements (user, 2026-05-10)
- Open-source friendly: no dependency on Martin-operated infrastructure.
- Source in this repo; Docker image built from public base images (`node:24-alpine`).
- Bridge is **passive** — no per-user configuration on the bridge side. Routing
  map self-populates as plugins connect.
- End-to-end: bridge cannot impersonate users or eavesdrop on commands. HMAC
  shared only between Lambda and plugin; bridge sees opaque payloads.

### Connection model (proposed, pending confirmation)
- Persistent WebSocket from plugin to bridge (`wss://bridge/connect`).
- App-layer ping/pong every 30–60s.
- Reconnect on drop with exponential backoff (1s, 2s, 4s, ..., 60s cap).
- Single connection per userId; new connect replaces old.

### Components to be added
- `bridge/src/index.js` — Node.js HTTP+WSS server.
- `bridge/Dockerfile`, `bridge/docker-compose.yml.example` (Caddy in front for TLS).
- `bridge/README.md` — operator guide.

### Surfaces
- **WSS `/connect`** — plugin opens, sends `{userId}` handshake, awaits directives.
- **HTTPS `/dispatch`** — Lambda POSTs HMAC-signed directive, bridge routes to the WebSocket for that userId, awaits response, returns it.
- **HTTPS `/probe?userId=X`** — Lambda asks "is X currently connected?", used during OAuth account linking.
- **HTTPS `/health`** — monitoring.

### DDB schema impact (when Phase 2.5 lands)
- `loxberryUrl` field replaced by `bridgeUrl` + `bridgeUserId`.
- `sharedSecret` field unchanged.

### Decisions (confirmed 2026-05-10)

**Hosting model.** Community bridge + self-host option. Martin operates a default
public bridge instance (TBD URL, e.g. `bridge.aloxberry.example.com`). Plugin's
basic-config page pre-fills this as the bridge URL. Users can override to any
self-hosted bridge they deploy from this repo's Docker image.

**OAuth token UX.** Two fields in the Alexa `/authorize` form:
1. **Bridge URL** — recognizable as a URL, separate field.
2. **Connection credential** — single opaque string `base64url(userId|skillSecret)`,
   generated by the plugin and shown in the basic-config page with a
   "Copy connection credential" button.

The plugin auto-generates `userId` (16 random bytes) and `skillSecret`
(32 random bytes) on first install; both are encoded into the credential
together with a small version byte for future format evolution.

**Bridge ↔ Lambda auth.** Env-var shared secret. Both the AWS Lambda and the
bridge are deployed with `BRIDGE_DISPATCH_SECRET` (random 32+ bytes). Lambda
includes it as a request header on every `/dispatch` call. Bridge rejects
without it. Stored on AWS in SSM SecureString at
`/loxberry-alexa/bridge-dispatch-secret` (parallel to JWT secret).

**Bridge persistence.** In-memory only; TOFU userId binding. Routing state is
`Map<userId, WebSocket>`; restart triggers reconnect within seconds for all
plugins. 16-byte-random userIds make hijacking computationally infeasible
without leaks; if a userId leaks, the legitimate plugin's reconnect kicks
the impostor (last-write-wins). Optional SQLite persistence is Phase 4
hardening, not Phase 2.5.

**Cryptography.** Phase 2.5 ships HMAC-SHA256 only (Lambda signs, plugin
verifies; bridge sees signed plaintext but cannot forge). AES-GCM on top
is deferred until there's a concrete threat model that requires it
(commands like "turn on living room light" are not high-stakes; the
property protected is *forgery*, not *confidentiality*, and HMAC handles
forgery alone).

### Component split that lands in this repo

```
bridge/
├── src/
│   ├── index.js          # Express HTTP server + WSS server
│   ├── routing.js        # in-memory Map<userId, WebSocket> + helpers
│   ├── ws-handlers.js    # connect, ping/pong, disconnect lifecycle
│   └── http-handlers.js  # /dispatch, /probe, /health
├── package.json          # ws, express, pino (or just plain http)
├── Dockerfile            # node:24-alpine, multi-stage build
├── docker-compose.yml.example  # bridge + Caddy for TLS
├── README.md             # operator guide (deployment, env vars, observability)
└── .env.example          # PORT, BRIDGE_DISPATCH_SECRET
```

### What actually shipped (2026-05-12)

The implementation lives entirely under `bridge/`. Layout:

```
bridge/
├── src/
│   ├── index.js          # HTTP server + WSS upgrade routing
│   ├── routing.js        # Map<userId, WebSocket> with replace-on-collision
│   ├── ws-handlers.js    # hello/welcome/ping/pong, close codes 4002-4005
│   └── http-handlers.js  # /health, /dispatch, /probe (HMAC-signed by Lambda)
├── package.json          # ws, pino
├── Dockerfile            # node:24-alpine, multi-stage, USER node, HEALTHCHECK
├── .dockerignore
├── docker-compose.yml    # bridge + Caddy (auto-TLS via Let's Encrypt)
├── Caddyfile             # reverse-proxy to bridge:8080, ACME on hostname
├── .env.example          # BRIDGE_DISPATCH_SECRET, ALOXBERRY_BRIDGE_HOSTNAME, HTTPS_PORT
└── README.md             # operator guide (deploy, NAS alt-port, troubleshooting)
```

**Configurable HTTPS port (NAS deployments).** Caddy serves on port 443 by
default, but operators on NAS boxes whose web UI already owns 443 can set
`HTTPS_PORT=8443` in `.env`. Port 80 is still always required for the ACME
HTTP-01 challenge. When `HTTPS_PORT≠443`, the bridge URL pasted into Alexa
account-linking must include the port (e.g. `https://bridge.example.com:8443`).

**Cert persistence.** Named volume `caddy_data` holds the issued Let's Encrypt
cert + ACME account key + renewal metadata. Restarts and `docker compose up -d`
recreations reuse the cert; only `docker compose down -v` destroys it.

**Verified end-to-end.** WSS lifecycle (hello → welcome → ping/pong) tested with
a scratch client against the running bridge. /dispatch and /probe verified.
HEALTHCHECK using Node 24's built-in `fetch` against `/health` confirmed.

### Wire formats (sketch)

**Plugin → bridge handshake (over WSS):**
```json
{ "type": "hello", "userId": "<16-byte-base64url>", "version": 1 }
```

**Bridge → plugin (push directive):**
```json
{ "type": "directive",
  "requestId": "<uuid>",
  "directive": { /* signed Alexa directive envelope */ },
  "headers": { "x-aloxberry-timestamp": "...", "x-aloxberry-signature": "..." } }
```

**Plugin → bridge (response):**
```json
{ "type": "response", "requestId": "<uuid>",
  "response": { /* Alexa response envelope */ } }
```

**Lambda → bridge `/dispatch`:**
```http
POST /dispatch HTTP/1.1
X-Bridge-Auth: <BRIDGE_DISPATCH_SECRET>
Content-Type: application/json

{ "userId": "<...>", "directive": {...}, "headers": {...} }
```
Bridge response is the plugin's response envelope, or `{"error":"offline"}` with HTTP 504.

### DDB schema deltas (when Phase 2.5 lands)

- `loxberryUrl` field is removed.
- New fields: `bridgeUrl` (string), `bridgeUserId` (string).
- `sharedSecret` field unchanged (still used for HMAC end-to-end).

---

## Phase 2 — Plugin implementation language (decided 2026-05-10)

**Hybrid: Node.js daemon + Perl CGI for the web frontend.**

### Long-running daemon: Node.js

Lives at `bin/aloxberry-daemon.js`. Holds the persistent WSS connection to the
bridge, processes incoming directives, calls Loxone, returns responses.
Reasons:

- One runtime across all three Node services (Lambda, bridge, plugin daemon).
  Shared `@aloxberry/protocol` package for HMAC, directive shapes, retry logic,
  reconnect semantics. Bridge and plugin daemon share ~70% of WS-handling code.
- `ws` is the de-facto WebSocket library; `AnyEvent::WebSocket::Client` (Perl)
  is workable but less mature.
- `Promise.all([...])` for parallel Loxone calls is ergonomic; AnyEvent
  condvars are not.

Loxone access from the daemon **(revised 2026-05-12):**

- **Outbound commands** (Alexa → Miniserver): Node daemon spawns a one-shot
  Perl helper (`bin/lox-send.pl`) which uses `LoxBerry::IO::mshttp_send`.
  This gets token auth, token caching, and Miniserver-version quirks for free
  via the community-maintained LoxBerry stack — the slipperiest part of the
  Loxone wire protocol that we'd otherwise have to own.
  - Cost: ~10–30 ms process startup per command. Alexa traffic is single-digit
    commands per minute peak, so the cost is invisible.
  - Migration path if a long-running Perl daemon ever becomes warranted: only
    the body of `sendToMiniserver()` in the Node daemon changes — from
    `execFile()` to `fetch('http://127.0.0.1:7799/command')`. The same Perl
    helper script wraps in a 15-line Mojolicious handler.
- **Inbound events** (state changes): Node daemon opens a WebSocket directly
  to the Miniserver at `ws://<ms>/ws/rfc6455` (LAN-local, no TLS needed),
  authenticates with a token obtained via the documented `getkey2` → `gettoken`
  handshake, subscribes via `jdev/sps/enablebinstatusupdate`, decodes the
  binary event tables, maintains a UUID→value state cache.
  - Why not `LoxBerry::IO`: it's a request/response helper. No WS client,
    no binary event-table decoder. We'd be writing the WS subscription code
    in *some* language regardless.
  - Why not Loxone Virtual HTTP Outputs (the "configure each block in Loxone
    Config" alternative): would force end users to manually wire every
    Alexa-exposed device on the Loxone side. Unacceptable UX for a Smart
    Home plugin.
  - Why not the `node-lox-ws-api` npm library: last master commit 2020,
    "official" `Loxone/lxcommunicator` is archived and deprecated. We're
    going to own the protocol code either way; better to own a slim version
    than maintain a fork.
  - AES+RSA command encryption (the trickiest part of the Loxone spec) is
    deferred — LAN-local communication doesn't require it; token auth +
    plain WS frames suffice.
  - Realistic LOC budget: ~600–800 for the full client (token handshake,
    WS lifecycle, event-table decoder, reconnect).
- **Token-handling responsibility split**: Miniserver tokens used by the
  outbound command path live wherever `LoxBerry::IO` caches them (currently
  `/dev/shm`/temp). Tokens used by the inbound WS subscription are managed
  inside the Node daemon (cached in `data/`). Two independent token caches;
  refresh on each side is independent. This avoids the Perl/Node IPC tax
  on every command.

### Web frontend: Perl CGI

Lives at `webfrontend/htmlauth/index.cgi` per LoxBerry convention.

- Uses `LoxBerry::Web::lbheader/lbfooter`, `readlanguage`, the standard
  `/admin/plugins/<name>/` URL pattern that LoxBerry's Apache provides.
- Short-lived synchronous request handling — Perl's strong suit.
- Reads daemon state from `data/state.json`, writes config changes to
  `data/config.json` for the daemon to pick up.

### IPC contract (CGI ↔ daemon)

Shared JSON files in `data/`:

- `data/state.json` — daemon writes, CGI reads. Connection status, last-seen
  timestamps, current bridge URL, recent errors.
- `data/config.json` — CGI writes, daemon watches for change (chokidar) and
  hot-reloads. Bridge URL, chosen Miniserver number, log level.
- `data/commands/<uuid>.json` — CGI drops a request, daemon processes,
  writes result, both sides clean up. Used for synchronous "Test connection"
  buttons.

Same pattern as the BMW reference plugin (which uses Perl on both sides),
just substituting Node for the daemon language.

### File layout

```
loxberry-plugin-aloxberry/
├── plugin.cfg
├── pre/postinstall.sh, pre/postupgrade.sh
├── bin/
│   ├── aloxberry-daemon.js              # Node.js daemon (long-running WSS client)
│   ├── aloxberry-control.sh             # start/stop/restart/status wrapper
│   ├── package.json                   # ws, chokidar, pino, ...
│   └── node_modules/                  # gitignored; installed in postinstall.sh
├── webfrontend/htmlauth/
│   └── index.cgi                      # Perl CGI for config UI
├── templates/
│   ├── index.html
│   └── lang/{language_de,language_en}.ini
├── cron/cron.reboot                   # starts the daemon
├── data/                              # state.json, config.json, commands/
└── icons/
```

### Install-time responsibilities

**`preinstall.sh`** verifies runtime prerequisites before any files are
copied (exit 2 here aborts cleanly, no half-installed state):

- `node -v` returns ≥24 → otherwise `<FAIL>` + exit 2.
- `npm -v` succeeds → otherwise `<FAIL>` + exit 2.
- Soft check: registry.npmjs.org reachable → otherwise `<WARNING>` + exit 1
  (continue, but warn user that postinstall may fail).

Uses `<INFO>` / `<OK>` / `<WARNING>` / `<FAIL>` colorized log tags so the
LoxBerry plugin manager renders the output correctly.

**`postinstall.sh`** runs `npm install --omit=dev --prefix bin/` to fetch
the daemon's runtime dependencies (`ws`, `chokidar`, `pino`). Network
access required (BMW plugin uses the same pattern with `cpanm`).

### Node version

**LoxBerry ships Node.js 24 by default** (verified on user's installation
2026-05-10). This matches the Lambda runtime (`nodejs24.x`) — same language
features available in both environments, no transpile/polyfill mismatch.

`bin/package.json` pins `engines.node` to `>=24`. Plugin's `LB_MINIMUM`
will be set to whichever LoxBerry version first shipped Node 24 (TBD;
verify before first release).

---

## Phase 2 — Plugin implementation order (decided 2026-05-12)

Ordered to keep each step independently testable against components that
already work, so bugs are localised to the slice currently under hand.

1. **Daemon scaffold** — `bin/{package.json,src/index.js,src/config.js,src/state.js}`.
   Boots, parses env vars, writes initial `data/state.json`, structured JSON
   logs via pino, graceful SIGTERM/SIGINT. No bridge or Miniserver code yet.
2. **Bridge WSS client** — connect to the bridge (which already ships and
   runs), send `hello`, handle `welcome`, app-layer ping/pong, exponential
   backoff reconnect. End-to-end testable against the deployed bridge.
3. **Perl `lox-send.pl` helper** — ~30 lines, takes `(ms, name, value)`,
   uses `LoxBerry::IO::mshttp_send`, returns `ok|fail`. Smoke-tested by
   hand against a real Miniserver.
4. **Node → Perl spawn wrapper** — `sendToMiniserver()` in the daemon with
   timeout + error mapping. Wraps Node's `child_process.execFile` (NOT the
   shell-invoking variant — argv array, no shell interpolation).
5. **Miniserver WS client** — token handshake, WS open, event-table decoder,
   state cache. Staged: get token → open WS → log raw binary frames → add
   decoder behind `LOG_RAW_EVENTS=1` flag → wire to state cache.
6. **End-to-end Alexa command path** — Lambda /dispatch → bridge → daemon
   receives `TurnOn` directive → `sendToMiniserver()` → reply. Verify with
   an actual Alexa utterance.
7. **State proactive reports** — when state cache changes, push `ChangeReport`
   upstream via the bridge so Alexa can answer "is the light on?". Optional
   for an MVP; Alexa works without it (just no state queries).

---

## Phase 2 — Second config page: Skill Control & Device Exposure (sketch)

This page exists to **give the user a strong sense of being in control** of
what Alexa can see and do in their home. Captured 2026-05-10; details to be
fleshed out later.

### Section 1 — Master Off switch (prominent, top of page)

- Big toggle / labeled button. Immediate effect.
- Off means: plugin actively refuses to execute Alexa commands.
- **Open: implementation choice** —
  - (a) Daemon drops WSS connection → Alexa sees devices as unreachable.
  - (b) Daemon stays connected but rejects directives with `ENDPOINT_UNREACHABLE` → devices visible-but-unreachable.
  - Likely (b): keeps state coherent, fastest to re-enable, no Discovery dance on toggle.

### Section 2 — Conditional disable via Loxone Betriebszustand

- Plugin auto-disables itself when a configured Loxone Betriebszustand is active.
- **Default: "Abwesend"** — leverages a state nearly every Loxone install already has set up correctly.
- User can pick a different Betriebszustand (dropdown populated from `LoxApp3.json` operating-state list) or disable the gate entirely.
- UI shows the *reason* when disabled: e.g. "Plugin is currently paused — Betriebszustand 'Abwesend' is active."
- **Open: manual-Off vs Betriebszustand-Off precedence.** Lean toward *manual override wins* (user can force-enable even during Abwesend), but confirm.
- Implementation: daemon polls Miniserver state for the configured operating-state UUID at a small interval (5–15 s), or subscribes via Loxone WebSocket once token auth is in (Phase 4).

### Section 3 — Component picker

Two-panel UI driven by the Miniserver's `LoxApp3.json` structure file:

- **Left panel — candidates.**
  - All controls Loxone reports, grouped or filtered by type / room / category.
  - Search-by-name input.
  - Each entry shows name, room, category, type.
- **Right panel — actively exposed.**
  - User-curated list. Add via button or drag.
  - Per-entry config:
    - Alexa `displayCategory` (LIGHT, SWITCH, THERMOSTAT, INTERIOR_BLIND, EXTERIOR_BLIND, SCENE_TRIGGER, SPEAKER, TEMPERATURE_SENSOR, ...)
    - Friendly-name override (default = Loxone control name).
    - Capability subset toggles where meaningful (e.g. dimmer can be exposed as PowerController only, or PowerController + BrightnessController).
- Bulk operations later: "expose all in room X", "expose all of type Dimmer", etc.

### Open questions to flesh out later

- Does the master-Off switch mean Discovery returns empty, or directives get `ENDPOINT_UNREACHABLE`?
- Manual-Off vs Betriebszustand-Off precedence (override vs subordinate).
- Does Off-state persist Alexa device removals or just hide them temporarily?
- Per-component capability subset toggles — necessary in Phase 2 or defer to Phase 3?
- How does the picker handle Loxone room/category UUIDs that have non-ASCII characters (umlauts in German names)? Search/filter must be locale-aware.
- What about Loxone scenes (Stimmungen)? Same picker or separate section?
- Should the page show a live preview ("These N devices will appear in Alexa")?

---

## Phase 2 — Third config page: Logs (note only)

A third page surfaces the plugin's log files using the **standard LoxBerry
log handling scheme**. No custom log viewer; reuse what the LoxBerry plugin
manager already knows how to render. Reference implementation: the BMW
plugin at `D:\Development\git\loxberry-bmw-cardata`.

### What "standard LoxBerry log handling" means here

- Daemon and CGI both use `LoxBerry::Log` (Perl) / the equivalent Node helper
  that writes to `$lbplogdir` (= `REPLACELBPLOGDIR` at install time, typically
  on the ramdisk so flash wear is bounded).
- Log session pattern: `LOGSTART` / `LOGINF` / `LOGOK` / `LOGWARN` / `LOGERR`
  / `LOGCRIT` / `LOGDEB` / `LOGEND`. Levels are the LoxBerry-standard set so
  the log viewer's filtering UI works out of the box.
- The Node daemon writes log lines in the same on-disk format (or pipes
  through a thin Perl wrapper) so a single viewer covers both runtimes.
- The config page itself is small: it calls
  `LoxBerry::Web::plugin_logs_html_page()` (the same helper BMW's
  `index.cgi` uses) to render the integrated log list + viewer with
  download links.

### What goes on the page

- List of available log files (current + rotated), each with timestamp,
  size, severity-color preview.
- Inline viewer (the LoxBerry-provided one — don't roll our own).
- Log-level selector for the daemon (writes to `data/config.json`; daemon
  hot-reloads).
- "Clear logs" button (with a confirm) — useful when testing.

### Why a separate page (not just a panel on page 1 or 2)

- Logs are diagnostic / forensic, not configuration. Mixing them with
  Off-switches and Miniserver pickers blurs the page's purpose.
- The BMW plugin's pattern of a dedicated log page is what LoxBerry users
  already expect; following it lowers the cognitive load.

Implementation details (CGI route, log rotation policy, level mapping
between Node's `pino` levels and the LoxBerry severity vocabulary) deferred
to when we build the page itself.

## Deferred — Picker UX polish: info tooltips for every setting

Every per-device setting in the picker (Category dropdown, Capabilities
checkboxes, the "Settings" row toggles + number inputs, plus per-device
options like `rangeAxisInverted`, `thermostatUseOverride`,
`thermostatOverrideHours`, `audioVolumeStep`) should get a small blue
**(i)** info icon next to its label. Hovering / tapping the icon should
reveal a short tooltip explaining what the setting does and the user
impact of changing it.

This is a non-trivial UX project — it touches the picker UI for almost
every form control, plus translations for the tooltip strings (both
`language_en.ini` and `language_de.ini`). Expect new i18n keys per
setting, an accessible tooltip component (CSS+JS or library), and
careful copywriting per setting.

Acceptance criteria:

- Every setting that has more than a literal-name explanation gets a
  tooltip (Category, Capabilities, Reverse axis, Temporary override,
  Override hours, Volume step, etc.)
- Tooltips are localized in DE + EN
- Tooltips are keyboard- and screen-reader-accessible (not hover-only)
- The picker layout doesn't break on narrow viewports

Out of scope for this entry: tooltips on filter controls (search / room /
type / category / hide-checkboxes). Those are picker-side UX, not
device-level settings.

## Implementation status snapshot (2026-05-15)

A cross-cut "what's done, what's open" view across all the phases above
and the recent capability work, so we don't lose track between long
sessions.

### State-sync audit (2026-05-16)

Triggered by a user report that a discovered Switch showed stale on/off
until manually toggled once. Root cause: Alexa has two state channels —
the **pull** path (`Alexa.ReportState` → `_handleReportState`, sent right
after Discovery) and the **push** path (proactive `ChangeReport`,
state-reporter.js, fired on Loxone state change). Any type wired for push
but not pull shows "stale until first change"; the push event then
self-corrects it, masking the gap.

Audited every type for pull/push symmetry:

- **Switch / TimedSwitch** — the only true pull/push asymmetry. Pull was
  hard-stubbed to `OFF`. Fixed: added `_resolveSwitchPower` (reads live
  `active`), wired into the ReportState PowerController else-chain.
- **Dimmer** — worse: listed as Shipped but not actually functional.
  `_handleSetBrightness` fell through to the ColorPickerV2 `temp()`/`hsv()`
  grammar (a plain Dimmer can't parse it), AND it had *no* state on either
  path. Fully wired: native `{pos}`/`off` write path scaled onto the live
  `[min,max]` (Structure File V17 p.59), `_resolveDimmerState` pull
  resolver, state-reporter `position` push mapping, shared
  `dimmerToBrightness` helper as the single source of truth so push and
  pull can't drift. +15 regression tests.
- **All other types** (ColorPickerV2, Slider, IRoomControllerV2, ACControl,
  Ventilation, Radio, Sequential, ValueSelector, PresenceDetector,
  InfoOnlyDigital/Analog, WindowMonitor, LightController v1/v2) — already
  symmetric; verified, no change.

Both fixes are daemon-side only (no AWS/SAM redeploy, no Alexa
re-discovery — capabilities unchanged); restart the daemon and Alexa
self-corrects on its next `ReportState` poll.

### Daemon reliability + crash observability (2026-05-16)

Triggered by a field report: the daemon "stopped responding" right after
a `devices.json` reload, with the index-rebuild dump as the last log line
and **no error recorded**. Could not be root-caused from logs because the
post-reload path had zero instrumentation and the crash logger was
self-defeating. Hardened in three layers (all daemon-side only):

- **Crash logger fixed (the "no error logged" cause).** The
  `uncaughtException` / `unhandledRejection` / startup-catch handlers did
  `log.fatal()` then a *synchronous* `process.exit(1)`. The logger writes
  via `process.stdout.write`, which is **async when stdout is a pipe/file**
  (always, under the LoxBerry log redirect) — so `exit()` truncated the
  unflushed buffer and the fatal line was lost. Replaced with a single
  `fatalExit()`: a synchronous `fs.writeSync(2, …)` forensic line that
  cannot be buffered away, plus the structured `log.fatal`, plus a 100 ms
  `unref()`'d drain delay before exit. Added `normalizeError()` so a
  non-Error reject (string/object/undefined) still yields name/message/
  stack instead of a useless `{ reason }`.
- **Throw containment.** `_onCacheChange` runs as a `stateCache` 'change'
  EventEmitter listener; an uncaught throw there unwinds through `emit()`
  into the WS binary-event parser — the silent-death path. Split into a
  guarded wrapper + `_onCacheChangeInner`; per-state `try/catch` in
  `_currentPropertiesForDevice` and per-device in `dispatchSnapshot`, each
  logging the exact `(uuid, type, stateName)`. A latent bad mapping among
  the now-larger enabled set degrades to one skipped state, not a dead
  daemon.
- **Boundary instrumentation + heartbeat.** DEBUG enter/exit lines bracket
  the `devices.json` change handler (`toEndpoints` / `setEndpoints` /
  `setEnabled`), `_buildIndex`, and `_dispatch`'s `sendReport` call, so the
  last surviving line localizes a hang. The per-event cache log was
  replaced with a once-a-minute aggregate heartbeat
  (`{ total, matched, windowSec:60 }`, `unref()`'d, reset each window) —
  a `total=0` window after a reload is the smoking gun without per-event
  spam.

Net effect: the next reload-hang is self-diagnosing — a guaranteed
`[FATAL]` stderr line, or the last `devices change handler:` boundary, or
a named throwing `(type, stateName)`, or a silent heartbeat — instead of
nothing. Deploy `index.js` + `state-reporter.js`, restart.

### OAuth hardening — PKCE + client authentication (2026-05-16)

Closed the long-standing Phase-1 follow-up. Server-side only
(`aws/lambda/oauth-handler/index.js` + SAM params) — no Alexa skill
config change beyond setting Account-Linking client credentials, no
LoxBerry/daemon change, no data migration (auth codes are ephemeral).

- **PKCE (RFC 7636), S256-only.** `/authorize` captures `code_challenge`
  (+ rejects non-S256 method up front), stores it on the auth-code item,
  and carries it through every form re-render. `/token` enforces the
  verifier **iff a challenge was stored** — a server-side decision keyed
  off our own record, so an intercepted code can't downgrade out of it.
  Failed verification invalidates the code (anti-brute-force). Verified
  against the RFC 7636 Appendix B interop vector.
- **Token-endpoint client authentication (RFC 6749 §2.3).** Enforced on
  **both** grants, before any grant logic. Accepts HTTP Basic *or* body
  credentials (Basic wins per §2.3.1), constant-time-compared against SSM
  SecureStrings. **Fails CLOSED**: if the creds aren't configured the
  endpoint returns 503, never "accept any client".
- **Auth-code → client binding (RFC 6749 §4.1.3).** The authenticated
  client redeeming a code must match the `client_id` recorded at
  `/authorize`; mismatch invalidates the code.
- 28 pure-unit tests (`npm test` in `oauth-handler/`); SAM template
  validates.

> **Deployment prerequisite (manual, blocking).** Two new SSM
> SecureStrings must exist *before* deploying this, or the token endpoint
> fails closed and account-linking breaks:
> ```
> aws ssm put-parameter --name /loxberry-alexa/oauth-client-id \
>   --type SecureString --value "<Client ID set on the skill's Account Linking page>"
> aws ssm put-parameter --name /loxberry-alexa/oauth-client-secret \
>   --type SecureString --value "$(openssl rand -hex 32)"
> ```
> The same Client ID / Secret must be entered on the Alexa skill's
> Account Linking page. Order: create SSM params → set them in Account
> Linking → `sam deploy` → re-link the skill once.

### Shipped and verified

**Phase 1 — AWS backend & OAuth** (✓ deployed eu-west-1)
- Two Lambdas (`loxberry-alexa-oauth-prod`, `loxberry-alexa-directive-prod`)
  on Node.js 24 / arm64.
- Two DynamoDB tables (users + auth codes).
- HTTP API Gateway + SSM SecureString config (`/loxberry-alexa/jwt-secret`,
  `/loxberry-alexa/bridge-dispatch-secret`).
- LWA token exchange for AcceptGrant + Event Gateway delivery wired
  (the original Phase-1 "follow-up" is closed).

**Phase 2.5 — Bridge** (✓ shipped 2026-05-12)
- WSS-only persistent bridge at `loxhome-bridge.net`.
- Dumb pass-through routing; HMAC + bearer split keeps it privacy-safe.

**Phase 2 — Daemon implementation steps 1–7** (✓ all shipped)
- Daemon scaffold, bridge WSS client, Perl `lox-*.pl` helpers,
  Node→Perl spawn wrapper, Miniserver WS client with token+binary decode,
  Alexa end-to-end command path, proactive state ChangeReports.

**Phase 2 — Configuration pages 1, 2, 3** (✓ shipped)
- Setup (Bridge connection + skill linking + Miniserver picker).
- Devices (picker + globals + capabilities + per-device settings rows).
- Logs (LoxBerry log-session integration via `log-session-create.pl`).

**Phase 3 — Capability handlers** (✓ shipped, see
`IMPLEMENTED_CAPABILITIES` in `directive-router.js`)
- PowerController, BrightnessController, ColorController,
  ColorTemperatureController, ModeController, RangeController,
  SceneController, ThermostatController, TemperatureSensor, Speaker,
  PlaybackController, PlaybackStateReporter, ToggleController,
  MotionSensor, ContactSensor, HumiditySensor.
- EndpointHealth always emitted alongside.
- Read-only sensor types (PresenceDetector, WindowMonitor,
  InfoOnlyDigital, InfoOnlyAnalog) shipped; InfoOnly types use the
  dual-role `optionalCapabilities` pattern so one control can be Motion
  *or* Contact (digital) / Temperature *or* Humidity (analog).

**Phase 4 — Proactive state** (✓ shipped)
- `state-reporter.js` maps state-cache change events to ChangeReports.
- Snapshot dispatch (`POST /resync-state`) bootstraps Alexa's view for
  rarely-changing properties (thermostat mode, audio source slot, etc.).
- Audio power state emits both `PowerController.powerState` AND
  `Speaker.muted` so either capability advertised lights up correctly.

**Cross-cutting infrastructure** (✓ shipped)
- Vacation gate (per-device + global), master enable toggle,
  per-device capability opt-out (Speaker / PowerController / etc.).
- Per-device settings: `rangeAxisInverted` (blinds), `thermostatUseOverride` /
  `thermostatOverrideHours` (thermostat), `audioVolumeStep` (speakers).
- Per-control-type `allowedCategories` filter narrows the picker's
  category dropdown to sensible options per Loxone type.
- LWA-token refresh + grace-window race handling in oauth-handler.
- LOG_LEVEL parameter (deploy-time DEBUG|INFO|WARN|ERROR) gates per-request
  Lambda log volume to keep CloudWatch ingestion bounded at scale.
- `alexa.dispatch.statereport`-style diagnostic logging in the directive
  Lambda (verbose at DEBUG; slow-dispatch auto-promoted to WARN at INFO).
- Discovery schema audit against Amazon docs — `properties: {}` on
  PlaybackController, `muted` in Speaker.supported, version bumps to 3.1
  (EndpointHealth) and 3.2 (ThermostatController).

### Open from earlier phases

- **OAuth — refresh-token grant uses a DDB `Scan`** (no GSI on
  `refreshToken`/`prevRefreshToken`). Works, but O(table) per refresh;
  add a GSI before meaningful user growth. The only OAuth item still
  open — PKCE + client auth shipped 2026-05-16 (see below).
- **Picker UX polish**: info tooltips per setting (see "Deferred — Picker
  UX polish" section above).
- **Live preview in picker** ("These N devices will appear in Alexa"):
  unimplemented, deferred from Phase 2 open-questions list.
- **`/test-skill-connection` endpoint** (synthetic Discovery via bridge):
  unimplemented, deferred from Phase 2 first config page section.

### Known limits we've accepted (not bugs)

- Voice commands for media playback (`Play`/`Pause`/`Stop`/`Next`/`Previous`)
  on AudioZone are silently intercepted by Alexa's Music service and
  never reach our skill. Documented in `## Deferred — Capability semantics
  blocks` and the README. A future Multi-Capability Skill (Custom + Smart
  Home) could fix this; not in scope today.
- Alexa app tile UI for SPEAKER / STREAMING_DEVICE displayCategories is
  minimal by design (metadata + activate-toggle only). Not addressable
  daemon-side.
- **SceneController endpoints are invisible in the Alexa app device list.**
  Anything we map to a `*_TRIGGER` displayCategory (`SCENE_TRIGGER`,
  `ACTIVITY_TRIGGER`) — i.e. Pushbutton, Sequential, Irrigation, and any
  SceneController-only endpoint — is classified by Alexa as a *scene*, not
  a *device*. Consequence: it works by voice ("Alexa, turn on <name>") and
  is selectable in the Routine builder, but it has **no device tile**, so
  the user **cannot see, rename, or delete it from the Alexa app**. To
  retire one: remove it in our picker + re-run "discover devices" (Alexa
  prunes scenes whose Discovery no longer reports them), or delete the
  whole skill link. This is Alexa platform behavior, not a bug, and not
  fixable daemon-side. **TODO (doc): call this out explicitly in the
  README's troubleshooting/FAQ section** — confirmed in the field by the
  user with the "Diavolo Starten" Pushbutton (worked by voice, never
  appeared as a tile). Confirmed wrong place to look: the app's *Devices*
  list; correct place is *More → Routines* (and voice).

## Loxone control type mapping catalog

Index of Loxone v17 Structure-File control types mapped to Alexa
capabilities + displayCategories. Inclusive of unlikely matches per the
"rather an unlikely match than a missing mapping" rule. Three buckets:
**Shipped** (end-to-end), **Not yet implemented** (clean fits + specialty
— implement on user request), and **No mapping** (replaced or no Alexa
fit). There is no "recommended next" queue — the formerly-tracked T2 is
retired because everything in it shipped.

### Coverage at a glance (2026-05-16)

- **Shipped & end-to-end: 23 control types** (table below). Every one has
  Discovery + directive handling + **both** state paths (pull
  `ReportState` and push `ChangeReport`) — verified symmetric in the
  2026-05-16 state-sync audit.
- **Not yet implemented — clean fits: ~10.** LightsceneRGB,
  Intercom/IntercomV2, MailBox, Irrigation, Heatmixer, Sauna,
  PoolController, SolarPumpController, UpDownLeftRight (digital + analog).
  Each is a self-contained add following the acceptance criteria below.
- **Not yet implemented — specialty: ~12.** ClimateController(US),
  Alarm/AlarmChain/SmokeAlarm (SecurityPanelController), Aal* family,
  AlarmClock, SteakThermo, CarCharger/Wallbox (no Alexa EV category),
  Remote, NFC Code Touch.
- **No mapping — replaced:** ColorPicker v1, IRoomController v1,
  Intercom v1 — map like their successors; skip unless asked.
- **No mapping — no Alexa fit:** energy/metering, diagnostics, and
  pure-config control types — explicit list below.

Caveat carried from "Known limits": shipped types mapped to a `*_TRIGGER`
displayCategory (Pushbutton, Sequential) are *working* but appear under
Alexa **Routines/voice, not the Devices list** — an Alexa classification
behavior, not a coverage gap.

### Shipped (in `TYPE_MAP`; daemon handles directives + both state paths end-to-end)

| Loxone type | Capabilities | displayCategory |
|---|---|---|
| Switch | PowerController | SWITCH |
| TimedSwitch | PowerController | SWITCH |
| Pushbutton | SceneController | SCENE_TRIGGER |
| Dimmer | PowerController + BrightnessController (native `{pos}`/`off`, [min,max]-scaled) | LIGHT |
| LightController (v1) | PowerController + ModeController (scenes; instance Aloxberry.LightScene) | LIGHT |
| LightControllerV2 | PowerController + ModeController | LIGHT |
| ColorPickerV2 | BrightnessController + ColorController + ColorTemperatureController | LIGHT |
| Jalousie | RangeController (`ManualPosition`, axis-invertable) | INTERIOR_BLIND |
| Window | RangeController (`moveToPosition`) | INTERIOR_BLIND |
| Gate | RangeController (snap to `open`/`close`/`PartiallyOpen`) | DOOR |
| Gate (opt-in) | ModeController (instance `GarageDoor.Position`, Up/Down + semantics) — Alexa prompts for the user's voice code before `open` | GARAGE_DOOR |
| Slider | RangeController (native min/max/step from `details`) | OTHER |
| IRoomControllerV2 | ThermostatController + TemperatureSensor | THERMOSTAT |
| ACControl | PowerController + ThermostatController + TemperatureSensor + ModeController(fan) | AIR_CONDITIONER |
| Ventilation | PowerController + RangeController(speed) + ModeController(mode) + optional TempSensor + HumiditySensor | FAN |
| Radio | ModeController(scenes from details.outputs + optional All Off) | OTHER |
| ValueSelector | RangeController(bounds from live state; increaseOnly enforced) | OTHER |
| Sequential | ModeController(programs from details.sequences + synthesized None) | SCENE_TRIGGER |
| AudioZone | PowerController + Speaker + PlaybackController + PlaybackStateReporter + ToggleController(Shuffle) + ModeController(Repeat,Source) | STREAMING_DEVICE |
| AudioZoneV2 | (same as AudioZone, `playZoneFav` instead of `source`, `Pause` instead of `off`) | STREAMING_DEVICE |
| PresenceDetector | MotionSensor | MOTION_SENSOR |
| WindowMonitor | ContactSensor (aggregated; DETECTED iff all windows fully closed) | CONTACT_SENSOR |
| InfoOnlyDigital | ContactSensor *and/or* MotionSensor (user picks via `optionalCapabilities`) | CONTACT_SENSOR / MOTION_SENSOR |
| InfoOnlyAnalog | TemperatureSensor *and/or* HumiditySensor (user picks; °C/°F from `details.format`) | TEMPERATURE_SENSOR / HUMIDITY_SENSOR |

### Not yet implemented — clean fits

Clean Alexa mapping, lower user value or niche; implement on request.

| Loxone type | Capabilities | displayCategory | Notes |
|---|---|---|---|
| LightsceneRGB | ModeController (scenes) | LIGHT | Older scene-set RGB picker; ModeController for scene selection. |
| Intercom / IntercomV2 | Alexa.DoorbellEventSource (event-only) | DOORBELL or CAMERA | Triggers on doorbell press; complex because video routing differs. |
| MailBox | ContactSensor (mail received state) | CONTACT_SENSOR | Niche but a clean ContactSensor mapping. |
| Irrigation | SceneController per zone | ACTIVITY_TRIGGER | Each watering zone as an activity trigger. |
| Heatmixer | RangeController (read-only) | OTHER | Analog mixer valve position; usually controlled by climate, not Alexa. |
| Sauna | PowerController + RangeController (temperature) | OTHER | Specialty: niche-but-clean fit. |
| PoolController | PowerController + ModeController (modes) | OTHER | Pool pump + heater + mode picker. |
| SolarPumpController | PowerController | OTHER | Solar circulation pump on/off. |
| UpDownLeftRight digital | ToggleController × 4 (one per direction) | OTHER | 4-way directional; exposed as four toggles. |
| UpDownLeftRight analog | RangeController × 2 (X/Y axes) | OTHER | 2-axis analog; X+Y as two RangeController instances. |

### Not yet implemented — specialty (real-world fit only for specific setups)

| Loxone type | Capabilities | displayCategory | Notes |
|---|---|---|---|
| ClimateController | ThermostatController | THERMOSTAT | Multi-zone HVAC; overlaps with IRoomControllerV2 but supervisory. |
| ClimateControllerUS | ThermostatController | THERMOSTAT | US-locale variant. |
| Alarm | SecurityPanelController | SECURITY_PANEL | Burglar alarm panel; arm/disarm semantics complex. |
| AlarmChain | SecurityPanelController | SECURITY_PANEL | Composite alarm flow. |
| SmokeAlarm | SecurityPanelController *or* ContactSensor (alarm triggered) | SECURITY_PANEL / CONTACT_SENSOR | Fire + water alarms. |
| AalEmergency | SceneController (panic button) | OTHER | Ambient Assisted Living emergency call. |
| AalSmartAlarm | ContactSensor (alarm-active) | CONTACT_SENSOR | Same family as AalEmergency, broader sensing. |
| AlarmClock | SceneController (alarm trigger) | OTHER | Wake-up alarm; could expose as a "wake the house" trigger. |
| NFC Code Touch | SmartLock-adjacent; no clean Alexa fit | OTHER | Access control; security model doesn't match Alexa SmartLock semantics. |
| SteakThermo | TemperatureSensor | TEMPERATURE_SENSOR | Meat thermometer; very specific but clean read-only mapping. |
| CarCharger | PowerController + RangeController (charge limit) | OTHER (no Alexa EV category yet) | Loxone-side info exists; Alexa lacks an EV interface. |
| Wallbox2 / WallboxManager | Same as CarCharger | OTHER | Newer wallbox generations. |
| Remote | Custom (no Alexa fit — IR-style remotes) | OTHER | IR remote control; abstracts to user-defined buttons. |

### No mapping — replaced (older versions of mapped types)

| Loxone type | Maps like | Notes |
|---|---|---|
| ColorPicker (v1) | ColorPickerV2 | Older; same state shape, slightly different commands. Skip unless user asks. |
| Intelligent Room Controller (v1) | IRoomControllerV2 | Older; different state names + command verbs. |
| Intercom (v1) | IntercomV2 | Older. |

### No mapping — no Alexa fit

These exist in the Loxone catalog but have no semantically reasonable
Alexa Smart Home capability mapping. Listed for completeness so we don't
forget we considered them.

- **Energy + metering**: EnergyManager, EnergyManager2, EnergyFlowMonitor,
  Meter, Hourcounter, PowerUnit, Fronius (PV inverter), PVProductionForecast,
  SpotPriceOptimizer, LoadManager. Alexa has no consumption-data interface.
- **Internal config**: Application (embedded web URLs in Loxone's own UI —
  no directives, no state to control via voice), Daytimer (scheduler
  internals), SystemScheme, Central Objects, StatusMonitor.
- **Inter-Miniserver navigation**: MsShortcut (Trust-link entity that
  points at another Miniserver — `localUrl`/`remoteUrl`/`serialNr`
  metadata only, no controllable state).
- **Display only**: TextState, TextInput, InfoOnlyText, Webpage.
- **Control logic blocks**: PulseAt, Tracker.

### Acceptance criteria for adding a new type to the Shipped list

When implementing any of the above:
1. Add to `TYPE_MAP` in `bin/src/structure.js` with `category`,
   `capabilities`, `allowedCategories`, and any per-type defaults.
2. Add the new type to `V1_IMPLEMENTED_TYPES` if it's the primary
   non-greyed-out picker entry.
3. Add capability handlers in `bin/src/directive-router.js` (Discovery
   block + dispatch case + handler method + ReportState additions).
4. Add state-reporter mappings in `bin/src/state-reporter.js` for any
   readable properties.
5. Add tests in `bin/test/test-directive-router.cjs` (test env helper +
   coverage for Discovery, write directives, ReportState, vacation gate).
6. Update `IMPLEMENTED_CAPABILITIES` if a new Alexa interface was added.
7. Verify the picker UI renders the new type with the right capability
   checkboxes + Settings-row options.

## Deferred — Capability semantics blocks

Most of our `RangeController`/`ToggleController`/`ModeController`
declarations could optionally include a **`semantics`** sub-object that
maps Alexa's abstract user-action vocabulary onto our specific capability.
We don't use this today; presets + explicit voice phrases cover the most
common case. But adding semantics blocks would expand the natural voice
surface significantly — worth a future polish pass.

### What semantics actually does

`semantics` has two halves:

- **`actionMappings`** — when the user says a generic phrase (`open`,
  `close`, `raise`, `lower`, `enable`, `disable`), which specific
  directive should fire on this capability?
- **`stateMappings`** — when this capability has value X, which abstract
  state (`Open`, `Closed`) should Alexa infer for questions like
  "is the bedroom blind open?"

### Example — RangeController for blinds

```json
{
  "semantics": {
    "actionMappings": [
      {
        "@type": "ActionsToDirective",
        "actions": ["Alexa.Actions.Open", "Alexa.Actions.Raise"],
        "directive": {
          "name": "SetRangeValue",
          "payload": { "rangeValue": 100 }
        }
      },
      {
        "@type": "ActionsToDirective",
        "actions": ["Alexa.Actions.Close", "Alexa.Actions.Lower"],
        "directive": {
          "name": "SetRangeValue",
          "payload": { "rangeValue": 0 }
        }
      }
    ],
    "stateMappings": [
      {
        "@type": "StatesToValue",
        "states": ["Alexa.States.Closed"],
        "value": 0
      },
      {
        "@type": "StatesToRange",
        "states": ["Alexa.States.Open"],
        "range": { "minimumValue": 1, "maximumValue": 100 }
      }
    ]
  }
}
```

This expands the voice surface for blinds from "Alexa, set kitchen blind
to 100" (current presets-only) to additionally handle:
- "Alexa, **lower** the kitchen blind" (Alexa.Actions.Lower)
- "Alexa, **raise** the kitchen blind"
- "Is the kitchen blind **open**?" (state inference)
- "Alexa, **close** the kitchen blind" (works today via presets;
  with semantics works without depending on the preset list)

### Where it would apply in our mapping catalog

| Capability | Use cases for semantics |
|---|---|
| RangeController (Jalousie/Window/Gate) | Open/Close/Raise/Lower + state inference |
| ToggleController (Audio Shuffle) | "Enable shuffle" → toggleState=ON (generic Action.Enable) |
| ToggleController (future security toggles) | Lock/Unlock action mapping |
| ModeController (Audio Repeat) | "Enable repeat" → mode=all (generic Action.Enable) |
| ModeController (future thermostat presets) | "Set thermostat to comfort" via Action.Open style |

### Implementation sketch

In `bin/src/directive-router.js`, the per-capability Discovery blocks
would gain an optional `semantics` field built from a per-type lookup
table. Existing presets stay; semantics layer on top.

```js
// pseudocode in _capabilitiesFor
if (endpoint.capabilities?.includes('RangeController')) {
  caps.push({
    ...existing,
    ...(semanticsForBlinds(control.type) && { semantics: semanticsForBlinds(control.type) }),
  });
}
```

The handler side requires no changes — semantics is pure Discovery
metadata that tells Alexa how to map utterances to directives. The
handler keeps receiving the same `SetRangeValue` / `SetMode` /
`TurnOn` / `TurnOff` directives.

### Acceptance criteria

- Semantics blocks added to RangeController for all three blind-shaped
  types (Jalousie, Window, Gate).
- Semantics blocks added to ToggleController(Shuffle) and the two
  ModeController instances for AudioZone.
- Voice test "Alexa, lower the \<blind\>" works without explicit preset
  match.
- Voice test "Alexa, is the kitchen blind closed?" returns correct state
  answer based on the cached rangeValue.
- No regression in existing voice phrases that work today via presets.

### Why not now

- Existing presets cover the high-frequency voice phrases ("open",
  "close", "half" for blinds; volume-up/down for speakers).
- The Alexa-platform interception of media intents (Play/Pause/Stop/Next)
  affects PlaybackController regardless of semantics — semantics won't
  fix that part.
- Adding semantics to every capability adds Discovery payload size + tests.
  Worth doing as a focused pass, not piecemeal.

Refer to Amazon docs for the canonical semantics schema:
https://developer.amazon.com/en-US/docs/alexa/device-apis/alexa-discovery.html

## Deferred — AudioZoneV2 (Audioserver) favorites via user-declared map

### Background / the limitation (investigated 2026-05-19)

`AudioZone` (V1, the EOL Loxone MusicServer) publishes its zone favorites
on the Miniserver as the `sourceList` text-state — the daemon parses it
and exposes a Source `ModeController` (shipped). `AudioZoneV2` (the Loxone
Audioserver) does **not**: the favorites are not in `LoxAPP3.json`, there
is no favorites state/command on the Miniserver for V2, and the source
picker is therefore (deliberately) V1-only — see
`doc/user/*/devices.md` and `directive-router.js` Discovery comment.

### Why every "read the favorites" path is closed

Investigated and ruled out, all three grounded in sources:

1. **Audioserver-direct, unauthenticated HTTP** (`audio/cfg/getroomfavs/
   <playerid>` on the `mediaServer.host`, port 7091): reachable (HTTP 200)
   but returns `{"error":"command not allowed when paired"}`. The
   `audio/cfg/*` namespace is the **private Miniserver⇄Audioserver
   perimeter**; a paired Audioserver only honours it for its
   authenticated paired-Miniserver session.
2. **Authenticated Audioserver client** (`secure/hello → authenticate →
   init` then `audio/cfg/getroomfavs`): theoretically possible but the
   handshake crypto is NOT pinned in mr-manuel's docs, and the command
   may only ever answer the paired-Miniserver identity, not a second
   client. Unproven; high effort; real risk of a dead end after the work.
   Impersonating the paired Miniserver is RSA-keypair-bound and would
   collide with the live Miniserver session — rejected outright.
3. **Miniserver-proxy** (get our already-authenticated Miniserver WS to
   relay/return the V2 list): does not exist. Confirmed by the Loxone V17
   Structure File (no V2 favorites state), mr-manuel `miniserver-api.yaml`
   ("relay is internal; clients cannot query Audioserver via the
   Miniserver"), and `marcelschreiner/emulated-loxone-music-server` (the
   Miniserver is the *consumer* of `audio/cfg/getroomfavs`; for V2 it does
   not re-publish the result to its own clients).

The official Loxone app shows V2 favorites by talking **directly** to the
Audioserver with an App `Session-Token` — not via the Miniserver — and
even the App perimeter has no documented favorites *list* command
(`audio/<zone>/roomfav/play/<id>` is activate-only).

### The chosen future approach — user-declared favorite map

Since no API surfaces the names, let the only party that knows them (the
user) declare them, and drive the **documented** `playZoneFav/<slot>`
command we already implement:

- Per-AudioZoneV2 device, add a small editable favorites table in the
  Devices UI (`webfrontend` + `devices.json`): rows of `{ slot, name }`
  (slot = the integer Loxone's app shows for the zone favorite, 1..N).
- Daemon: when a V2 endpoint has a non-empty favorites map, advertise the
  Source `ModeController` from that map (mirror the V1 `_resolveSourceList`
  shape — `value = String(slot)`, friendlyName = user's name, both
  locales). `SetMode` → existing `playZoneFav/<slot>` path (already in
  `_handleSetMode`; today it rejects V2 — gate that on "has user map").
- Robust to "favorites change over time": the user re-syncs the table
  when they reorder favorites in Loxone (same maintenance contract as
  re-discovery). Document this in `devices.md`.
- Alternative worth weighing at implementation time: one Alexa endpoint
  **per favorite** (scene/PowerController style) so "Alexa, turn on
  <favorite>" dodges the music-NLU collision — bigger change, decide then.

### Why not now / acceptance criteria

- Deferred deliberately: ships nothing speculative, uses only documented
  commands, no Audioserver auth. The disabled probe experiment was rolled
  back (not kept as dead code); reintroduce a vetted Audioserver client
  only if a future firmware or a proven OSS handshake reopens path 2.
- Acceptance: a V2 zone with a user-declared map exposes named Source
  modes; "Alexa, set the source on \<zone\> to \<name\>" fires
  `playZoneFav/<slot>`; empty map → no Source mode (today's behavior);
  V1 `AudioZone` behavior unchanged; docs updated.

Reference for any future Audioserver-direct attempt (path 2):
https://github.com/mr-manuel/Loxone_api_documentation
(search for "semantics" — it's a top-level capability field).