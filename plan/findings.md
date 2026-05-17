# Security & code audit — findings

Audit date: 2026-05-16. Scope: whole project (AWS Lambda backend + infra,
bridge, daemon `bin/src`, webfrontend/packaging). Filtered to real-impact
issues only. Status legend: ☐ open · ◐ in progress · ☑ fixed (awaiting
test/commit) · ✅ fixed + verified.

## Attack chains (why the P0s matter together)

- **Chain A — Alexa account-link hijack (remote):** redirect_uri regex
  bypass (#1) → attacker receives the one-time auth code → PKCE/client
  binding optional-by-design (#9) → no endpoint throttling (#6) → grant
  reduces to one static client secret. Full link takeover, remotely.
- **Chain B — Bridge/routing takeover (bridge is internet-facing):** WSS
  `hello` identity unauthenticated TOFU (#5) + pair-code/`pair-publish`
  no brute-force/overwrite protection (#5/#6) + no `maxPayload`/conn caps
  (#8). Per-user routing hijack, link takeover, whole-bridge DoS.

## P0 — fix before any wider release

- ☑ **#1 OAuth `redirect_uri` allowlist bypass.** `oauth-handler/index.js`
  `REDIRECT_URI_HOST_RE = /(^|\.)amazon\.[a-z.]+$/i` matched
  `amazon.evil.com` (verified). → auth-code exfiltration → account-link
  hijack. Conf: High. **FIXED** — replaced the regex with an exact-host
  `Set` (`pitangui.amazon.com`, `layla.amazon.com`, `alexa.amazon.co.jp`);
  `isAllowedRedirectUri` now does case-normalized exact membership only.
  +13 regression tests (incl. the exact bypass + userinfo-confusion).
  Awaiting test/commit.
- ☑ **#2 Stored XSS via JSON `<script>` island.** `templates/devices.html:254-255`
  emit `CATALOGUE_JSON`/`DEVICES_JSON` with no ESCAPE; `encode_json`
  (index.cgi) did not escape `<`/`>`/`&`. A Loxone control named
  `</script>…` ran JS in the LoxBerry admin origin (persistent, bypassed
  the textContent DOM code). Conf: High. **FIXED** — new
  `json_for_html_script()` helper \u-escapes `&` `<` `>` U+2028 U+2029
  before `$template->param`; both island params now route through it.
  Output is still valid JSON (decode round-trips identically), so the
  picker JS is unaffected. Verified with a verbatim-sub harness (PASS;
  harness removed — no Perl test infra in-repo). Awaiting test/commit.
- ☑ **#3 No CSRF on state-changing CGI actions.** `index.cgi` + all POST
  forms. Worst: `save_settings` silently repoints `BRIDGE_URL`; also
  GET-triggerable (`CGI->param` reads query string). Conf: High.
  **FIXED** — synchronizer-token pattern: 256-bit install-scoped secret
  (`.csrf-secret`, 0600, under config dir), `csrf_token`/`csrf_eq`
  (constant-time)/`csrf_same_origin` helpers; gate before dispatch
  requires **POST + exact token + same-origin** (Origin/Referer when
  present), else `$action` is blanked → read-only render + error flash.
  Hidden `csrf` field added to all 8 POST forms; `CSRF.REJECTED` string
  added (en/de). 17 logic checks pass (cross-origin/prefix-glue/path-
  confusion/null-origin all rejected). Awaiting test/commit.
- ☑ **#4 ModeController free-text → unescaped Loxone command path.**
  `directive-router.js` LightController v1 (`String(requestedMode)`) +
  default LightControllerV2 (`changeTo/${requestedMode}`) → `lox-control.pl`
  raw path interpolation (whitespace-only guard; comment falsely claimed
  LWP escapes). Compromised/malicious Lambda invoked arbitrary Miniserver
  webservices. Conf: High. **FIXED (two layers):** (1) source — both
  branches now `Number.parseInt` + validate (`>=0`, round-trips) and
  reject non-numeric with INVALID_VALUE, matching every other SetMode
  branch (Discovery only ever advertises numeric ids); (2) sink —
  `lox-control.pl` strict `uuid =~ ^[0-9A-Fa-f-]+$` + command allowlist
  `^[A-Za-z0-9_.()/,:+-]+$` with explicit `..`-segment rejection; false
  comment corrected. JS suite 426/0 (+injection regression); `perl -c`
  clean; 38/38 Perl validation cases (all legit shapes incl.
  `hsv()/temp()/setTimer/..` accepted, all injections rejected).
  Awaiting test/commit.
- ◐ **#5 Bridge WSS identity unauthenticated (TOFU last-write-wins).**
  `bridge/ws-handlers.js`, `routing.js`. Routing hijack / directive-
  content disclosure / blackhole if a userId leaks (it's in /dispatch
  bodies + was logged). Conf: Medium. **HARDENED (proportionate, this
  pass):** `routing.tryAdd` refuses to displace a *provably-live* socket
  (recent traffic) — a newcomer knowing only the userId can no longer
  evict an active plugin; it may only take a slot that is closed/stale
  (legit reconnect). `routing.touch` refreshes liveness on inbound
  traffic. Global + per-IP connection caps in `index.js` (env-tunable).
  Raw `userId` no longer logged — replaced with a non-reversible
  fingerprint (this also resolves **#13**). 14 routing unit tests.
  **Residual (tracked → #5b):** this is a heuristic, not authentication —
  an attacker connecting in the gap before the real plugin (e.g. right
  after a bridge restart) can still grab a free slot. The cryptographic
  fix is **#5b** below. Awaiting test/commit.
- ☐ **#5b Authenticated bridge handshake (follow-up to #5).** Conf: n/a
  (design). Remove the heuristic entirely: on connect the bridge sends a
  random `nonce` in `welcome`; the daemon replies
  `{type:"auth", proof: HMAC_SHA256(skillSecret, nonce + "\n" + userId)}`;
  the bridge relays `{userId, nonce, proof}` to a NEW Lambda endpoint
  `POST /verify-connect` (authed with the bridge-dispatch secret) which
  looks up that user's `skillSecret` in DDB and recomputes the HMAC;
  only on success does the bridge `routing` the socket and allow
  displacement. Keeps secrets out of the bridge (privacy invariant
  intact). Costs: daemon `bridge-client.js` + bridge `ws-handlers.js` +
  new Lambda route + IAM/DDB read + a bridge→Lambda dependency on every
  connect (degrade: queue/deny on Lambda outage) + coordinated 3-part
  deploy + its own test pass. Feature-sized; schedule deliberately.

## P1 — fix soon (availability + chain-enablers)

- ☐ **#6 No throttling** on `/token`, `POST /authorize`, bridge `/pair`,
  WSS. `template.yaml` HttpApi; `bridge/http-handlers.js:201`. Brute-force
  of 50-bit pair codes / static client secret; cost/DoS via per-attempt
  Scan. Conf: High.
- ☐ **#7 Refresh-token `ScanCommand` `Limit:1`** — limit applied before
  filter. `oauth-handler/index.js:413-419`. Intermittent `invalid_grant`
  once >1 user → forced re-link. Conf: High. Fix: GSI on
  refreshToken/prevRefreshToken + Query (also kills #6's Scan).
- ☐ **#8 Bridge WSS no `maxPayload` (100 MB default) + no conn caps.**
  `bridge/index.js:39-51`. Unauthenticated client memory/FD-exhausts the
  shared bridge for everyone. Conf: High.
- ☐ **#9 PKCE + client_id optional at `/authorize`.**
  `oauth-handler/index.js:135-289,361-379`. Enforced only "iff stored";
  attacker-crafted authorize omits them. Reduces Chain A to one static
  secret. Conf: Medium. Fix: require client_id (match expected) + PKCE
  S256 at `/authorize`; absence = error.

## P2 — hardening / defense-in-depth

- ☐ **#10 IAM over-grant.** `DynamoDBCrudPolicy` on internet-exposed
  alexa-handler (needs only Get + conditional Update); `AlexaSkillId`
  optional leaves invoke open to any skill. `template.yaml:323-324,345-351`.
- ☐ **#11 Logger no secret redaction.** `bin/src/log.js:130-185`. Any
  future `log({...})` with skillSecret/token/Miniserver key → cleartext.
- ☐ **#12 JWT alg not pinned** to HS256. `shared/jwt.js:28-36`. Latent
  alg-confusion; not exploitable today.
- ☑ **#13 Bridge logs raw `userId` at info.** `bridge/ws-handlers.js`.
  **FIXED as part of #5** — all log sites now use `fp(userId)` (first
  8 hex of SHA-256); the only remaining raw `userId` is the `pair.store`
  data payload (not a log). Awaiting test/commit.
- ☐ **#14 `BRIDGE_URL` accepts `http://` + loopback/link-local.**
  `index.cgi:149` (`^https?://\S+`). SSRF/downgrade; amplifies #3.
- ☐ **#15 HMAC ±5 min replay window, no nonce.** `shared/hmac.js:53-70`.
  Bounded; malicious bridge can replay within window.
- ☐ **#16 `/event` shares mutated `changeReport` object.**
  `oauth-handler/index.js:644-647`. Latent cross-tenant on any future
  concurrency refactor.
- ☐ **#17 Spoofable `x-aloxberry-pairing-id` object key.**
  `bin/src/pairings.js:53-67`. Display/DoS only (not proto pollution).
- ☐ **#18 Unauthenticated bridge `report` flooding** via trusted dispatch
  secret. `bridge/ws-handlers.js:197-223`, `outbound.js:27-63`.
- ☐ **#19 Flash reflects raw daemon stderr.** `index.cgi` flash paths.
  Info-disclosure (escaping is correct, not XSS).

## Confirmed sound (no action)

Loxone AES/RSA + SHA-from-`getkey2` handshake; binary event-table parser
bounds-checked + crash-contained; secret files atomic `0o600`; E2E HMAC
privacy invariant holds; `.lbplugin` leaks no secrets; CGI command exec
fixed+quoted; page/path selection allowlisted; daemon crash-handlers +
reconnect backoff correct.

## Fix log

- **2026-05-16 — #5 bridge WSS hardening (+ #13).** `bridge/src/routing.js`
  rewritten: liveness-tracked entries, `tryAdd` (added/displaced/rejected),
  `touch`, owner-guarded `remove`/`get` (back-compat: `get` still returns
  the ws). `bridge/src/ws-handlers.js`: hello uses `tryAdd` (refuse to
  displace a live socket; `CLOSE.SLOT_IN_USE=4006`), `routing.touch` on
  inbound frames, all logs use `fp(userId)`. `bridge/src/index.js`:
  global + per-IP connection caps (`MAX_CONNECTIONS`=5000,
  `MAX_CONNECTIONS_PER_IP`=50, env-tunable) with idempotent release.
  New `bridge/test/test-routing.cjs` (14/0); test-pair 18/0,
  test-bridge-hmac 9/0 unaffected. Bridge-only; redeploy the bridge
  container — no daemon/AWS change, protocol unchanged (no daemon-side
  edit needed). ⚠ Behavior: after a network partition where the old
  socket is half-open, a legit reconnect can be refused until the old
  one is detected stale (≤ ROUTING_STALE_MS, 60s) — the bridge-client
  backoff loop covers it. #5b (crypto handshake) removes this tradeoff.
- **2026-05-16 — #4 ModeController command-path injection.**
  `bin/src/directive-router.js`: LightController-v1 + default-LCv2
  branches parse/validate numeric id (INVALID_VALUE on non-numeric).
  `bin/lox-control.pl`: strict uuid + command allowlist + `..` rejection,
  corrected the misleading "LWP escapes" comment. Tests:
  `bin/test/test-directive-router.cjs` +2 injection regressions (426/0);
  Perl validated via verbatim harness (removed). Daemon-side only;
  redeploy daemon (`bin/`) — no AWS/SAM. Behavior change: a
  non-numeric ModeController value (never sent by Alexa for these types)
  is now rejected instead of forwarded.
- **2026-05-16 — #3 CSRF.** `webfrontend/htmlauth/index.cgi`: added
  `$CSRF_FILE` + `csrf_token`/`csrf_eq`/`csrf_same_origin`; pre-dispatch
  gate (POST + token + same-origin, blanks `$action` on failure);
  `CSRF_TOKEN` template param. `templates/status.html` (7 forms) +
  `templates/devices.html` (1 form): hidden `csrf` field. `[CSRF]
  REJECTED` in language_en.ini + language_de.ini. Frontend-only; ships
  with next `.lbplugin` rebuild. ⚠ Existing logged-in browser tabs must
  reload once after deploy to pick up the token (a stale tab's first
  POST will get the CSRF error, reload fixes it — by design). The
  `.csrf-secret` file lives under the config dir (not web-served,
  0600); first-load create-race is self-healing.
- **2026-05-16 — #2 JSON-island stored XSS.** `webfrontend/htmlauth/index.cgi`:
  added `json_for_html_script()` (\u-escapes `&<>` + U+2028/U+2029 on the
  UTF-8 byte string from `encode_json`); `CATALOGUE_JSON`/`DEVICES_JSON`
  now use it instead of raw `encode_json`. `templates/devices.html`
  unchanged (still parses via `JSON.parse(textContent)` — escapes decode
  back). Frontend-only; ships with next `.lbplugin` rebuild. No daemon/AWS
  change. Verified: `</script>` breakout neutralized, JSON round-trips.
- **2026-05-16 — #1 redirect_uri bypass.** `aws/lambda/oauth-handler/index.js`:
  removed `REDIRECT_URI_HOST_RE`; added `ALLOWED_REDIRECT_HOSTS` Set +
  exact, case-normalized membership check in `isAllowedRedirectUri`.
  Exported it for tests; added 13 cases to `test-pkce-clientauth.cjs`
  (41 pass total). Server-side only — deploy = `sam build && sam deploy`
  of the oauth handler; no SSM/Alexa/LoxBerry change. ⚠ If any real
  deployment ever used a non-listed Amazon host, linking would now fail —
  the three hosts are Amazon's full documented set, so this is expected
  to be safe; confirm the skill's region after deploy.
