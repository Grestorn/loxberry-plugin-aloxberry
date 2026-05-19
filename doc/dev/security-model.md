# Security model

[← Dev index](README.md) · User‑facing version: [user/en/security.md](../user/en/security.md)

## Identities and keys

| Value | Bytes / encoding | Secret? | Held by | Rotated by |
|-------|------------------|---------|---------|------------|
| `userId` | 16 random bytes → base64url (22 chars) | No (routing key) | plugin, bridge, Lambda/DDB | "kill all pairings" |
| `skillSecret` | 32 random bytes → hex (64 chars) | **Yes (HMAC key)** | plugin + Lambda/DDB only | "kill all pairings" |
| pair code | 10 chars from a 32‑char alphabet (50 bits) | Transient | plugin → bridge (TTL) | one‑shot, expires 10 min |
| JWT access token | `jose`‑signed, payload `userId` | Bearer | Alexa ↔ Lambda | ~1 h expiry |
| OAuth refresh token | 64 hex chars (2×UUIDv4) | Bearer (long‑lived) | Alexa ↔ Lambda/DDB | **non‑rotating by design** — [decisions.md](decisions.md); cleared by "kill all pairings" |
| Loxone token | Loxone JWT (token handshake) | Yes | plugin only | refresh / re‑auth |

`userId` being non‑secret is deliberate: it is only a routing selector. Stealing
it lets an attacker *address* a plugin but not *command* it — every directive
must still carry a valid HMAC produced with `skillSecret`, which the attacker
does not have.

## End‑to‑end HMAC

Every directive carries `x-aloxberry-timestamp` + `x-aloxberry-signature`
(HMAC‑SHA256 over `${timestamp}\n${payload}`, base64url). The Lambda signs with
the user's `skillSecret`; the plugin verifies with its local copy. Reports go
the other way, signed by the plugin, verified at the Lambda's `/event`.

Consequences:

- A malicious/compromised **bridge cannot forge** a directive (no key) nor
  **read** a meaningful command beyond opaque bytes + a `userId` it already
  routes by.
- A replayed directive is bounded by timestamp checking; reports are
  self‑resetting (the next state transition supersedes a missed one), so the
  bridge does not ack/retry them.

## Pair‑code design

50 bits of entropy is modest but sufficient *for this use*:

- One‑shot: the first `GET /pair?code=X` on the bridge deletes the entry.
- ~10‑minute TTL regardless.
- The bridge's `/pair` GET sits behind `X-Bridge-Auth`, so only the Lambda can
  even attempt a lookup.

So an attacker gets effectively one guess per code inside a 10‑minute window
behind an authenticated endpoint — brute force is hopeless. The code is a
*transport for the identity tuple*, not a long‑term key. The UI auto‑uppercases
input and the alphabet omits `I O 0 1` to avoid transcription errors.

## Loxone Miniserver auth

The plugin **reuses LoxBerry's Miniserver config** — it never stores Loxone
credentials of its own. Auth is the Loxone token handshake
(`getkey2` → `getjwt` or `authwithtoken` → periodic `refreshjwt`) with a
`chmod 600` disk token cache. Loxone credentials never leave the LoxBerry; they
are never sent to the bridge, Lambda, or Amazon.

## User‑controlled kill switches (enforced in the daemon)

From `devices-config.js` globals:

- **`globals.enabled`** (master switch) — when false the daemon refuses all
  bridge communication (no inbound directives, no outbound reports). Fail‑safe
  default is *open* only because the box is useless otherwise; the user can
  hard‑close it.
- **`globals.vacationGate`** — when the chosen Loxone **Virtual Status**
  (`vacationGate.controlUuid`) is On, the daemon **blocks Alexa→Miniserver
  writes** but still allows state reports. A deliberate one‑way mode.
  Restricted strictly to control type `InfoOnlyDigital` (Loxone Config
  "Virtueller Status", V17 spec p.70) — there is **no Loxone API to read a
  custom operating mode (Betriebsart)**: `globalStates.operatingMode` only
  ever exposes the resolved calendar/weekday slot (0..11), confirmed
  empirically + by the V17 spec. The user wires their pause condition into
  a Virtual Status in Loxone Config and selects it in the picker. Fails
  **open** (writes allowed) if the gate is unconfigured, the picked
  control isn't an `InfoOnlyDigital`, or its value hasn't arrived yet —
  never silently gate on the wrong signal. The legacy
  `operatingModeIndex` field was removed (it could never work for custom
  Betriebsarten).
- **Per‑device `enabled`** — drop a single device from discovery/commands
  without losing its config.
- **"Kill all pairings"** — rotates `userId` + `skillSecret`. Every existing
  Alexa link instantly becomes an orphan (Lambda's stored secret no longer
  verifies; bridge routes to a now‑unknown `userId`). The user must re‑link.

Hand‑edited `devices.json` is defensively sanitised (bounded numbers, category
whitelist) so a malformed file cannot crash the router or push absurd values.

## Threat model summary

| Adversary | Can they…? | Why not |
|-----------|-----------|---------|
| Compromised bridge | Forge/alter a command? | No `skillSecret`; HMAC verified at plugin. |
| Compromised bridge | Read what's controlled? | Sees opaque signed bytes + routing `userId` only. |
| Network attacker | Reach the LoxBerry? | No inbound ports; plugin only dials out over WSS/TLS. |
| Stolen `userId` | Command a plugin? | No — needs `skillSecret` to produce a valid HMAC. |
| Guessing a pair code | Hijack linking? | One‑shot, 10‑min TTL, behind `X-Bridge-Auth`. |
| Curious cloud operator | Get Loxone creds? | They never leave the LoxBerry. |
| Malicious linked Alexa acct | Exceed granted scope? | Only commands devices the user explicitly exposed; gates still apply. |
