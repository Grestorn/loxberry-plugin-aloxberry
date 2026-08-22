# Technical decisions

[← Dev index](README.md)

The non‑obvious choices and *why* they were made. Each is a place where the
"obvious" alternative was deliberately rejected.

## Architecture

**Plugin dials out to a bridge instead of accepting inbound.**
The obvious Smart Home design exposes an HTTPS endpoint per user. Rejected: it
puts the home box on the internet, needs a public IP / DynDNS / per‑user TLS,
and breaks behind CGNAT. An outbound persistent WSS to a thin relay needs none
of that. Cost: a relay must exist and be reachable — accepted, and made blind.

**The bridge is a stateless, blind relay (no DB, no payload parsing).**
End‑to‑end HMAC between Lambda and plugin means the only multi‑tenant public
hop can't read or forge commands. Keeping it stateless removes a backup/leak
surface and makes restarts free (plugins reconnect in seconds). A community
bridge operator is therefore *untrusted by design*.

**`userId` non‑secret, `skillSecret` secret and never on the bridge.**
Separating the routing key from the auth key lets the bridge route by `userId`
while being structurally incapable of forging directives. Multiple Alexa
accounts can drive one daemon because the identity tuple is stable across pair
codes.

**Pair code instead of typing credentials into an Amazon‑hosted form.**
Account linking pages are Amazon‑hosted. Asking for LoxBerry/Loxone credentials
there would leak them into a third party. A one‑shot, short‑TTL, behind‑auth
pair code carries only a transient reference to the identity tuple. 50 bits is
"enough for a one‑shot, rate‑limited, expiring transport," not "enough for a
key."

**Reuse LoxBerry's Miniserver config; don't manage Loxone auth.**
LoxBerry already stores and rotates Miniserver access. Re‑implementing it would
duplicate credentials and risk drift. The plugin reads `get_miniservers()` and
uses the standard token handshake — credentials stay in one place and never
leave the box.

## Plugin

**Daemon + thin CGI split.** Privileged, long‑lived logic (sockets, crypto,
Loxone session) lives in one supervised Node process. The Perl CGI only renders
UI and calls a loopback API. The UI cannot itself reach the bridge or Loxone, so
the attack/again‑surface is small and the daemon is the single source of truth.

**Loopback API on 127.0.0.1, POST‑only mutations.** The control surface is not
network‑reachable (bind address + LoxBerry htmlauth in front). Mutating
endpoints are POST so a stray browser‑bar GET can't rotate identity.

**`devices.json` watched + hot‑reloaded; defensively sanitised.** The user
edits via the picker, but the file can also be hand‑edited. `chokidar` reload
means no daemon restart on save; bounded numeric clamps + a category whitelist
mean a bad file degrades gracefully instead of crashing the router.

**`TYPE_MAP` as the single mapping authority.** One frozen table maps each
Loxone control type to a default Alexa category, capability set, and per‑type
`allowedCategories`. The picker, the sanitiser, and the router all derive from
it — no mapping logic is duplicated or can drift. There is intentionally a
*wide* universal category whitelist (defence‑in‑depth) and a *narrow*
per‑type picker list (UX).

**The garage-door voice code is Alexa's, not ours.** A Gate can be exposed
two ways. The default (`DOOR` + `RangeController`) accepts "open"/"close"/"set
to 50 percent". The opt-in (`GARAGE_DOOR` + `Alexa.ModeController` with
instance `GarageDoor.Position`) is the only shape Amazon recognises as a
garage door, and recognition is the whole feature: Alexa's cloud then asks
"What is your voice code?" before it dispatches an *open* (never a close).
The code is set per device in the Alexa app and checked in Amazon's cloud —
the daemon does not see it, validate it, or know it exists. Nothing about the
PIN is implemented here; we only have to declare the endpoint exactly right.

Consequences worth remembering, because none of them announce themselves:
a near-miss shape (wrong category, extra `RangeController` on the same
endpoint, a renamed instance) still yields a working control that is simply
never gated, so `DevicesConfig._resolveArm` forces the pair to agree on load —
demoting the *category* when the gated arm is missing (that is the shape every
pre-0.7.1 install has on disk, and promoting it would silently make a working
gate demand a code its owner never set), dropping the *extras* when it is
present; `GARAGE_DOOR` must appear in *both* category allowlists (the daemon's
`VALID_CATEGORIES` and the CGI's `%valid_cat`) or a save silently rewrites it
to `OTHER`; the arm loses `PartiallyOpen`, since Alexa's mode is
two-valued; and Amazon supports it only in de-DE, en-GB, en-US, es-ES, es-US,
fr-FR and it-IT — nl-NL is absent, so Dutch households get a tile that
ignores the voice verbs. Hence opt-in, with the trade-offs on the picker.

**Identity + `devices.json` under `$LBPCONFIG`.** Only that directory is
preserved by LoxBerry across plugin upgrades. Putting identity there means an
upgrade doesn't silently break every Alexa link.

**Config errors fail loud (`exit(2)`).** A daemon that boots with wrong config
mis‑routes directives silently — worse than not booting. Missing required env
→ immediate exit with a clear stderr line.

## AWS

**JWT access tokens (stateless verify).** `alexa-handler` authenticates without
a DDB round‑trip; `userId` rides in the signed payload. DDB is touched only to
load `skillSecret` and route.

**OAuth refresh tokens are NOT rotated — deliberately.** The `refresh_token`
grant is idempotent: it validates the token, mints a fresh access token, and
returns the *same* refresh token. Rotation was tried and removed because it
caused **silent, permanent account‑link death**: access tokens have a ~1 h
TTL, so Alexa refreshes each linked account ~hourly; with rotation a single
lost or slow rotation HTTP response left Alexa holding a token the backend had
already rotated past, the next refresh failed `invalid_grant`, and Alexa then
stopped sending *all* directives ("device not responding") until the user
manually re‑linked — recurring on every unlucky cycle. For an Alexa Smart Home
skill (one known client; the token is bound to a single user row) rotation's
marginal benefit does not justify that failure mode. The legacy
`prevRefreshToken` field is still *accepted* on lookup (so in‑flight tokens
survive the deploy and converge onto the canonical token) but is no longer
written. **Do not "harden" this by re‑adding rotation** without first solving
the lost‑response desync — that is exactly the breakage this note exists to
prevent. Successful refreshes log `oauth.refresh.ok` at INFO as the
per‑account hourly liveness heartbeat.

**Never `Scan` with `Limit: N` for a filtered lookup.** The opaque
refresh/bridge tokens have no key or index, so they are found by
`ScanCommand` + `FilterExpression`. DynamoDB applies `Limit` to items **read
before** the filter, not items **returned after** it — so a `Scan` with
`Limit: 1` reads exactly one arbitrary row and matches only if that row is
the one you wanted. It is silently correct with a single user row and
silently broken at ≥2 (≈`1/N` success per call). A `Limit: 1` here was the
root cause of the "every additional linked user breaks every other user's
account link" outage: each new linked account enlarged the `users` table and
diluted every refresh's hit rate, so `oauth.refresh.not_found` →
`invalid_grant` → Alexa drops the skill. Token lookups must **paginate the
scan** (`do { … } while (LastEvaluatedKey)`, no `Limit`) and stop on the
first match — see `distinctBridgeInstalls` for the canonical pattern.
O(table) per refresh is fine at beta scale (low hundreds of rows); a GSI on
`refreshToken`/`prevRefreshToken` (and `bridgeUserId` for `/event` fanout) is
the proper scale optimisation, but it is a *performance* follow‑up — the
`Limit` removal is the *correctness* fix and must not be reverted.

**SSM SecureStrings, cached across warm invocations.** Secrets out of code and
env; one KMS decrypt per cold start.

**Manual IAM / Lambda‑permission overrides vs. stock SAM.** SAM's
`Type: AlexaSkill` event source grants the `alexa-appkit.amazon.com` principal
(Custom skills); Smart Home needs `alexa-connectedhome.amazon.com`, declared
by hand. SAM's `SSMParameterReadPolicy` builds a malformed ARN for parameter
names with a leading slash, so SSM IAM is an explicit inline statement. These
are bug‑workarounds, documented so they aren't "cleaned up" back into breakage.

**AWS resource names retained through the "Aloxberry" rebrand.** Renaming
DynamoDB tables / stack resources would force stack recreation and re‑linking
of every existing user. Cosmetic identity (repo, npm scope, skill name) was
rebranded; infra names were intentionally frozen.

**Deployments are manual.** The agent/tooling prints `sam`/`aws` commands; it
does not auto‑run them. Infra changes against a shared multi‑tenant backend are
a human decision.

## Operational

**TLS terminated outside the bridge.** The bridge speaks plain HTTP on
loopback; Caddy/nginx/Cloudflare Tunnel handles certs. This keeps the bridge
trivial and lets operators pick whatever fits their network (incl. CGNAT via
Tunnel) without bridge code changes.

**State reports are fire‑and‑forget.** Loxone state is self‑resetting — the
next transition supersedes a missed one. A buffered ack/retry layer would add
real complexity for negligible reliability gain, so reports are signed, sent,
and dropped on failure (logged).
