# The AWS backend

[← Dev index](README.md) · Source: [`aws/`](../../aws/)

## Why it exists

An Alexa Smart Home skill **must** have an AWS Lambda as its endpoint — Amazon
calls it directly. The skill also needs **OAuth2 account linking** so each
Alexa account maps to one LoxBerry. Those are the two jobs of the backend. A
shared, project‑operated instance serves all users of the public "Aloxberry"
skill; it is open source and self‑hostable for a private skill.

## What it is

Deployed via **AWS SAM** (`aws/infrastructure/template.yaml`):

| Resource | Purpose |
|----------|---------|
| `oauth-handler` Lambda | Account linking (OAuth2 Authorization Code Grant) + the `/event` ingress for proactive state. |
| `alexa-handler` Lambda | Receives every Smart Home directive, authenticates it, dispatches via the bridge. |
| DynamoDB `users` | `userId → { skillSecret, refreshToken, LWA tokens, … }`. |
| DynamoDB `authcodes` | Short‑lived OAuth auth codes (TTL 600 s). |
| DynamoDB `config` | Generic key/value; holds `betaMaxConnections`, the beta cap on distinct linked LoxBerry installs the OAuth handler enforces at link time. |
| API Gateway (HTTP API) | Public OAuth endpoints (`/authorize`, `/token`, `/event`). |
| SSM SecureStrings | JWT signing secret, bridge dispatch secret, LWA client id/secret. |
| `@aloxberry/shared` | Shared layer: DDB client, JWT (`jose`), HMAC sign/verify, LWA token exchange. |

Runtime: Node.js 24 on arm64, AWS SDK v3, no web framework (plain HTTP
parsing).

### oauth-handler

- `GET /authorize` — renders the account‑linking page (inline HTML; the user
  pastes the **pair code**, not credentials).
- `POST /authorize` — looks the pair code up on the bridge
  (`GET /pair?code=…`), gets `{userId, skillSecret}`, writes the `users` row,
  redirects back to Alexa with an auth code.
- `POST /token` — exchanges the auth code for a **JWT access token**
  (payload: `userId`, signed with the SSM JWT secret, ~1 h TTL) + an opaque,
  **non‑rotating** refresh token. The `refresh_token` grant is idempotent:
  validate the token → mint a fresh access token → return the **same** refresh
  token. Rotation was deliberately removed (it caused silent account‑link
  death — see [decisions.md](decisions.md)). Each successful refresh emits an
  `oauth.refresh.ok` **INFO** line: Alexa refreshes every linked account
  ~hourly, so that line is the per‑account liveness heartbeat — a gap is the
  earliest signal of a broken link.
- `POST /event` — receives signed ChangeReports from the bridge, verifies the
  HMAC against the user's `skillSecret`, fans the report out to every linked
  Alexa account using each account's LWA token.

### alexa-handler

For every directive: extract bearer JWT → verify → `userId` → load
`skillSecret` from DDB → **HMAC‑sign** the directive → `POST /dispatch` to the
bridge → return the plugin's response to Alexa. `AcceptGrant` trades the
Alexa‑supplied auth code for the user's LWA refresh token (stored for proactive
events).

## Why these specific choices

- **JWT for access tokens**: stateless verification in `alexa-handler` — no DDB
  read just to authenticate. The `userId` travels in the signed payload.
- **`skillSecret` per user in DDB, never to the bridge**: the Lambda is the
  only cloud component holding the HMAC key, so the bridge stays blind.
- **SSM SecureStrings, cached across warm invocations**: secrets out of env
  vars and code; one decrypt per cold start.
- **Diversions from the obvious SAM template** (documented in
  [decisions.md](decisions.md)): the Smart Home Lambda permission uses the
  `alexa-connectedhome.amazon.com` principal (SAM's `AlexaSkill` event source
  uses the wrong, Custom‑skill principal), and SSM IAM is hand‑written because
  SAM's `SSMParameterReadPolicy` mangles ARNs for leading‑slash parameter
  names.

## Running your own (basics)

Needed only for a **private skill** / full independence. Outline:

1. Create an Alexa Smart Home skill in the Alexa Developer Console; note its
   skill ID.
2. `sam build && sam deploy --guided` from `aws/` (account/region/profile per
   your setup). Stack outputs the OAuth base URL + handler ARN.
3. Put the required secrets in SSM: JWT secret, `BRIDGE_DISPATCH_SECRET`
   (must match your bridge), LWA client id/secret from the skill's account
   linking config.
4. Wire the skill: endpoint = `alexa-handler` ARN; account linking URLs =
   the API Gateway output.
5. Point the skill's bridge env (`BRIDGE_URL`) at your bridge
   ([bridge.md](bridge.md)).

Deployments are intentionally **manual** (print the `sam`/`aws` commands; do
not auto‑run). Detailed deploy helpers live in `aws/scripts/`.
