# Components

[← Dev index](README.md)

## Repository layout

```
.
├── plugin.cfg, release.cfg, prerelease.cfg   # LoxBerry plugin manifest + auto-update
├── pre/postinstall.sh, pre/postupgrade.sh    # LoxBerry lifecycle hooks
├── bin/                                      # the daemon (Node.js) + Perl helpers
│   ├── src/                                  # daemon modules (see below)
│   └── *.pl                                  # lox-getstructure.pl, lox-control.pl
├── webfrontend/htmlauth/index.cgi            # Perl config UI controller
├── templates/                                # HTML::Template views + lang/*.ini
├── config/, cron/, icons/, uninstall/        # standard LoxBerry plugin dirs
├── bridge/                                   # the dispatch bridge (NOT shipped to LoxBerry)
├── aws/                                      # Lambda + SAM (NOT shipped to LoxBerry)
└── doc/                                      # this documentation
```

`bridge/` and `aws/` live in the monorepo for development convenience but are
outside LoxBerry‑recognised plugin paths, so the installer ignores them.

## The plugin daemon (`bin/src/`)

A single long‑lived Node.js process. `index.js` boot sequence:

1. **`config.js`** — load config from env (set by the start wrapper from the
   plugin config). `BRIDGE_URL` is required; missing → `exit(2)` (fail loud, do
   not mis‑route).
2. **`identity.js`** — load or generate the persistent identity:
   `userId` (16 random bytes, base64url — a non‑secret routing key) and
   `skillSecret` (32 random bytes, hex — the HMAC key). Stored `chmod 600` in
   `$LBPCONFIG/alexa-aloxberry`, surviving upgrades/reboots. Rotated only by
   "kill all pairings".
3. **`daemon-uuid.js`** — a separate UUID that identifies the daemon as a
   *Loxone client* (unrelated to `userId`).
4. **Miniserver session** — see below.
5. **`bridge-client.js`** — the persistent WSS client.
6. **`local-http.js`** — the loopback control API for the CGI.
7. **`state.js`** — periodically writes `data/state.json` so the Perl CGI can
   render live status.

### Module groups

| Modules | Role |
|---------|------|
| `bridge-client.js`, `bridge-hmac.js` | Persistent WSS to the bridge; verify inbound directive HMAC, sign outbound reports. State machine with close‑code‑driven reconnect policy. |
| `directive-router.js` | The heart: maps an Alexa directive (`namespace`/`name`) to Loxone actions and builds the Alexa response envelope. Owns `IMPLEMENTED_CAPABILITIES`. |
| `structure.js` | Fetches `LoxAPP3.json` (via `lox-getstructure.pl`), caches it to disk, flattens it into a control catalogue, and holds `TYPE_MAP` — the Loxone‑type → Alexa‑category/capability table that drives the picker. |
| `devices-config.js` | Reads/watches `devices.json` (the user's chosen mapping) with `chokidar`; sanitises it; exposes globals (master switch, vacation gate) + the endpoint list the router consumes. |
| `miniserver-*.js` | `miniserver-session` (auth choice + reconnect), `-ws` (RFC6455 client), `-crypto` (AES+RSA command encryption), `-token-store` (disk token cache), `-events` (binary event tables), `-probe`, `-config` (reuses LoxBerry's Miniserver config). |
| `state-cache.js`, `state-reporter.js` | Track Loxone state; build/sign Alexa ChangeReports for proactive updates. |
| `pair-code.js`, `pairings.js` | Generate one‑shot pair codes; track observed pairings for the UI. |
| `loxone-command.js` | Encodes Loxone command URLs (`jdev/sps/io/…`) per control type. |
| `log.js` | Structured JSON logger with child loggers per component. |

### Loxone communication

The daemon reuses **LoxBerry's existing Miniserver configuration** (via
`LoxBerry::System::get_miniservers` exposed through the Perl helpers) — it does
**not** manage Miniserver credentials itself. Auth uses the Loxone token
handshake (`getkey2` → `getjwt`/`authwithtoken` → periodic `refreshjwt`) with a
disk‑persisted token cache. Reads come from the WebSocket event stream; writes
go through `jdev/sps/io/<uuid>/<cmd>`. The token handshake and binary event
decoding are easy to get subtly wrong — they follow the official Loxone
"Communicating with the Miniserver" v17 spec.

### The local control API (`local-http.js`)

Binds **only** to `127.0.0.1:7800`. Three JSON endpoints, called by the CGI:

- `GET /status` — liveness + `state.json` snapshot + implemented capabilities.
- `POST /pair` — generate a 10‑char code, publish it to the bridge over the
  existing WSS, return `{ code, expiresInSec }`.
- `POST /reset-pairings` — rotate identity, reconnect; existing Alexa links
  become orphans. (POSTs to prevent accidental browser‑bar invocation.)

## The plugin CGI (`webfrontend/htmlauth/index.cgi`)

Perl, behind LoxBerry's `htmlauth` gate. Renders three tabs from
`templates/*.html` (`HTML::Template`) with `templates/lang/language_*.ini`
translations:

- **Setup** (`status.html`) — daemon/bridge/Miniserver status, pair‑code
  generation, settings (Bridge URL, local port), daemon start/stop/restart,
  "kill all pairings" danger zone.
- **Devices** (`devices.html`) — the picker: Loxone catalogue on the left,
  exposed devices on the right; per‑device category/capabilities/settings;
  global master switch + operating‑mode pause. Writes `devices.json`.
- **Logs** (`logs.html`) — log sessions + SSH live‑tail hint.

The CGI never talks to the bridge or Loxone directly — it only calls the
daemon's loopback API and reads `state.json`. This keeps the privileged,
long‑lived logic in one place (the daemon) and the UI thin.

## On‑disk files

| Path | Written by | Purpose |
|------|-----------|---------|
| `$LBPCONFIG/alexa-aloxberry/identity/{userId,skillSecret}` | daemon | Persistent identity (chmod 600). |
| `$LBPCONFIG/alexa-aloxberry/devices.json` | CGI | The user's Loxone→Alexa mapping + globals. Hot‑reloaded by the daemon. |
| `$LBPDATA/.../loxapp3.json` | daemon | Cached Loxone structure (picker works offline). |
| `$LBPDATA/.../state.json` | daemon | Live status snapshot for the CGI. |
| token cache | daemon | Loxone JWT cache (chmod 600). |

Identity and `devices.json` live under `$LBPCONFIG` specifically because
LoxBerry's installer preserves that directory across plugin upgrades.
