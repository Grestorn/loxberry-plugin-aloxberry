# AWS backend

Multi-tenant AWS infrastructure for the Alexa Smart Home skill. A single
deployment of this stack serves every Loxberry installation that has linked
itself via the OAuth flow.

## Layout

```
aws/
├── lambda/
│   ├── alexa-handler/         # Smart Home directive dispatcher (Lambda)
│   ├── oauth-handler/         # OAuth2 Authorization Code Grant server (Lambda + API Gateway)
│   └── shared/                # Shared modules (DDB client, JWT, HMAC, SSM, logger)
├── infrastructure/
│   └── template.yaml          # AWS SAM template — declares all resources
├── scripts/
│   ├── bootstrap.{ps1,sh}     # Legacy: creates JWT SSM SecureString only.
│   │                          # deploy-prod handles this automatically now.
│   ├── deploy-prod.{ps1,sh}   # Build + deploy + ensure SSM secrets exist
│   ├── ddb-list.{ps1,sh}      # Read-only DDB inspection (secrets redacted)
│   └── ddb-clear.{ps1,sh}     # DDB wipe (dry-run default + typed confirmation)
└── samconfig.toml.example     # Template for sam deploy parameters
```

## Architecture in one paragraph

`AlexaHandlerFunction` receives Smart Home directives, looks up the user
by access token in DynamoDB, signs the directive with the per-user HMAC
`skillSecret`, and POSTs it to **the bridge** — a small relay outside AWS
(see [`../bridge/README.md`](../bridge/README.md)). The bridge forwards over a persistent
WebSocket to the user's Loxberry plugin daemon. The bridge is privacy-safe
by design: end-to-end HMAC means the bridge can't forge directives, and it
keeps no persistent state. `OAuthHandlerFunction` handles account-linking
during Alexa skill setup and redeems short-lived pair codes issued by the
daemon to bind a user's DynamoDB row to their daemon identity. The Lambdas
know the bridge's URL via the `BridgeUrl` SAM parameter (in
`samconfig.toml`) and authenticate to the bridge with a shared secret
stored in SSM (`/loxberry-alexa/bridge-dispatch-secret`).

## Resources created by the SAM stack

| Resource                 | Purpose                                                                                |
|--------------------------|----------------------------------------------------------------------------------------|
| `UsersTable` (DynamoDB)  | One row per linked Loxberry. Stores `bridgeUserId`, HMAC `skillSecret`, refresh token. |
| `AuthCodesTable` (DDB)   | Short-lived OAuth auth codes (10-min DynamoDB TTL).                                    |
| `OAuthApi` (HTTP API GW) | `/authorize` (GET, POST) and `/token` (POST) routes.                                   |
| `OAuthHandlerFunction`   | OAuth2 Authorization Code Grant server.                                                |
| `AlexaHandlerFunction`   | Alexa Smart Home directive dispatcher (forwards to user's Loxberry).                   |

Out-of-stack: four SSM SecureStrings live alongside the stack but are
not managed by it.

| Path                                       | Purpose                                                                 | Provisioned by               |
|--------------------------------------------|-------------------------------------------------------------------------|------------------------------|
| `/loxberry-alexa/jwt-secret`               | Signs the OAuth access tokens this stack issues to Alexa.               | `deploy-prod` (auto, random) |
| `/loxberry-alexa/bridge-dispatch-secret`   | Authenticates Lambda → bridge dispatch + bridge → Lambda event POSTs.   | `deploy-prod` (auto, random) |
| `/loxberry-alexa/lwa-client-id`            | LWA (Login With Amazon) client ID — from the Alexa skill's *Permissions* tab. Used by AcceptGrant + outbound ChangeReport flow. | **Manual** — one-time setup step 5 below |
| `/loxberry-alexa/lwa-client-secret`        | LWA client secret that pairs with the client ID above.                  | **Manual** — one-time setup step 5 below |

## One-time setup

You only need to do these once per AWS account / per dev machine.

### 1. Install prerequisites

#### Windows (PowerShell)

```powershell
# AWS CLI v2
winget install -e --id Amazon.AWSCLI

# SAM CLI via uv (Amazon's winget package is no longer maintained)
winget install --id=astral-sh.uv -e
# close + reopen the terminal so uv lands on PATH
uv tool install aws-sam-cli
uv tool update-shell
# close + reopen the terminal once more so `sam` lands on PATH
sam --version
```

#### Debian / Ubuntu / WSL

```bash
# Base tools
sudo apt update
sudo apt install -y curl unzip openssl ca-certificates

# AWS CLI v2 — do NOT use `apt install awscli`, that's the unsupported v1
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/awscliv2.zip
(cd /tmp && unzip -q awscliv2.zip && sudo ./aws/install)
aws --version

# SAM CLI via uv (consistent with the Windows path)
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.local/bin/env       # or restart the shell
uv tool install aws-sam-cli
sam --version
```

#### macOS

```sh
brew install awscli aws-sam-cli openssl
```

### 2. Configure AWS credentials

The `loxberry-alexa` profile must point at AWS account `686404584210` in
`eu-west-1`.

#### Windows (PowerShell)

```powershell
# If you opened the terminal from IntelliJ, the env vars are usually set.
# Otherwise:
$env:AWS_PROFILE = 'loxberry-alexa'
$env:AWS_REGION  = 'eu-west-1'

aws sts get-caller-identity
```

If you need to set up the profile from scratch:
```powershell
aws configure --profile loxberry-alexa
```

#### Debian / Ubuntu / WSL

**Option A — reuse the Windows credentials from WSL** (convenient when
the Windows side is already configured; nothing to rotate twice):
```bash
mkdir -p ~/.aws
WIN_USER="$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r')"
ln -sf "/mnt/c/Users/$WIN_USER/.aws/credentials" ~/.aws/credentials
ln -sf "/mnt/c/Users/$WIN_USER/.aws/config"      ~/.aws/config
```

**Option B — configure a fresh profile inside WSL:**
```bash
aws configure --profile loxberry-alexa
# AWS Access Key ID:     <your key>
# AWS Secret Access Key: <your secret>
# Default region name:   eu-west-1
# Default output format: json
```

Either way, verify:
```bash
export AWS_PROFILE=loxberry-alexa
export AWS_REGION=eu-west-1
aws sts get-caller-identity
```
Expected: `Account: 686404584210`.

### 3. Copy the SAM config template

```powershell
Copy-Item aws\samconfig.toml.example aws\samconfig.toml
```
```bash
cp aws/samconfig.toml.example aws/samconfig.toml
```

Edit `aws/samconfig.toml` and set `BridgeUrl` in `parameter_overrides`
(e.g. `BridgeUrl=https://loxhome-bridge.net`). The file is gitignored.

> The very first deploy can leave `BridgeUrl=` empty — the Lambdas will
> return HTTP 503 for every directive until you redeploy with a real URL.
> `BridgeDispatchSecretParam` defaults to
> `/loxberry-alexa/bridge-dispatch-secret`; only set it explicitly if you
> keep the secret under a different SSM path.

### 4. Auto-generated SSM secrets

`deploy-prod.{ps1,sh}` creates two SSM SecureStrings on its first run
(values: 32 random bytes hex-encoded each):
- `/loxberry-alexa/jwt-secret` — signs OAuth access tokens
- `/loxberry-alexa/bridge-dispatch-secret` — Lambda ↔ bridge auth

The bridge dispatch secret is printed on creation so you can paste it
into the bridge container's `BRIDGE_DISPATCH_SECRET` env var. To
re-print it later:
```powershell
.\aws\scripts\deploy-prod.ps1 -ShowBridgeSecret
```
```bash
./aws/scripts/deploy-prod.sh --show-bridge-secret
```

(There's also a legacy `bootstrap.{ps1,sh}` that creates only the JWT
secret. It's kept for backwards compatibility but is no longer needed —
`deploy-prod` is idempotent and handles both secrets.)

The other two SSM SecureStrings (`/loxberry-alexa/lwa-client-id` and
`/loxberry-alexa/lwa-client-secret`) are populated manually — see
step 5.

### 5. Alexa skill LWA credentials

When the daemon observes a Loxone state change (e.g. someone flips a
wall switch outside Alexa), the Lambda pushes a *ChangeReport* event
to Alexa so the app reflects the new state. Authenticating those
POSTs needs an LWA (Login With Amazon) refresh-token, which Alexa
hands us during account linking via the `AcceptGrant` directive.

For that exchange to work, the Lambda needs the skill's LWA client
credentials. They live in the Alexa Developer Console and must be
copied into SSM by hand — they can't be auto-generated.

1. Open the [Alexa Developer Console](https://developer.amazon.com/alexa/console/ask)
   → your skill → **Permissions** tab.
2. Toggle **Send Alexa Events** on. If this stays off, Alexa never
   fires `AcceptGrant`, no refresh-token is ever delivered, and Phase
   4 silently does nothing.
3. Copy the two values shown on that page:
   - **Alexa Client Id** — looks like `amzn1.application-oa2-client.…`
   - **Alexa Client Secret** — an opaque blob
4. Put both into SSM as SecureStrings:

   ```powershell
   aws ssm put-parameter --name /loxberry-alexa/lwa-client-id `
                         --type SecureString `
                         --value "amzn1.application-oa2-client.XXXXXXXX" `
                         --profile loxberry-alexa --region eu-west-1

   aws ssm put-parameter --name /loxberry-alexa/lwa-client-secret `
                         --type SecureString `
                         --value "<paste the client secret here>" `
                         --profile loxberry-alexa --region eu-west-1
   ```
   ```bash
   aws ssm put-parameter --name /loxberry-alexa/lwa-client-id \
                         --type SecureString \
                         --value "amzn1.application-oa2-client.XXXXXXXX" \
                         --profile loxberry-alexa --region eu-west-1

   aws ssm put-parameter --name /loxberry-alexa/lwa-client-secret \
                         --type SecureString \
                         --value '<paste the client secret here>' \
                         --profile loxberry-alexa --region eu-west-1
   ```

5. Deploy (`./aws/scripts/deploy-prod.sh` or `.ps1`). The Lambda picks
   the values up at cold start, with a 5-minute SSM cache.

6. **Re-link the skill** in the Alexa app (disable → enable). Alexa
   fires `AcceptGrant` on every link/re-link. The Lambda exchanges the
   code at `https://api.amazon.com/auth/o2/token` and writes
   `lwaRefreshToken` onto the user row.

#### Verifying

The user row in DynamoDB should now carry `lwaRefreshToken`:
```bash
./aws/scripts/ddb-list.sh --full
```
Look for `lwaRefreshToken` alongside the existing `bridgeUserId`,
`skillSecret`, `refreshToken`. If it's missing, the Lambda log tells
you why:
```bash
aws logs tail /aws/lambda/loxberry-alexa-directive-prod --follow \
              --profile loxberry-alexa --region eu-west-1
```
Look for one of:
- `alexa.acceptgrant.tokens_persisted` — success
- `alexa.acceptgrant.lwa_exchange_failed` — wrong client_id/secret in SSM, or LWA endpoint unreachable
- `alexa.acceptgrant.no_refresh_token` — Amazon returned an access-token but no refresh-token (rare; usually means "Send Alexa Events" was toggled off mid-flow)
- `alexa.acceptgrant.user_not_found` — race: AcceptGrant fired before the OAuth /token call created the user row; just re-link
- `alexa.acceptgrant.ddb_failed` — DynamoDB error; check the message

#### Rotating LWA credentials

These rarely need rotation — only if the skill's LWA credentials are
regenerated in the Developer Console. When that happens:

```bash
aws ssm put-parameter --name /loxberry-alexa/lwa-client-id \
                      --overwrite --type SecureString \
                      --value "amzn1.application-oa2-client.NEW" \
                      --profile loxberry-alexa --region eu-west-1
# same for /loxberry-alexa/lwa-client-secret
```

The Lambda's in-process SSM cache TTL is 5 minutes; warm invocations
pick the new value up by then without a deploy. To force-flush, push a
no-op redeploy or wait for the function's next cold start.

## First deploy

From the repo root:

```powershell
.\aws\scripts\deploy-prod.ps1
```
```bash
./aws/scripts/deploy-prod.sh
```

What the script does, in order:
1. `aws sts get-caller-identity` on the `loxberry-alexa` profile.
2. Creates the two auto-generated SSM SecureStrings (`jwt-secret`,
   `bridge-dispatch-secret`) if missing. Does **not** touch the
   manually-populated LWA pair from step 5 — those must already be
   in place if Phase 4 proactive events are in scope.
3. Clears stale `@aloxberry/shared` snapshots + `.aws-sam` build cache (npm's
   `file:` deps don't refresh on content-only edits).
4. `sam build --build-in-source`.
5. `sam deploy` — change-set confirmation comes from `samconfig.toml`'s
   `confirm_changeset = true`.
6. Prints the stack outputs.

Two output values go into the Alexa Developer Console:

- **`OAuthBaseUrl`** → Account Linking
  - Authorization URI: `${OAuthBaseUrl}/authorize`
  - Access Token URI:  `${OAuthBaseUrl}/token`
- **`AlexaHandlerArn`** → Smart Home Service Endpoint → Default endpoint (Europe region)

One more value goes into the **bridge** container's `.env` (for Phase 4
proactive ChangeReports — see "Wire the bridge for outbound events"
below):

- **`OAuthBaseUrl` + `/event`** → `LAMBDA_EVENT_URL` env var on the bridge

Useful flags:
- `--build-only` / `-BuildOnly` — run the build step without deploying.
  Handy on WSL for a smoke test that you have the toolchain wired up.
- `--show-bridge-secret` / `-ShowBridgeSecret` — print the existing bridge
  dispatch secret. No build, no deploy.

### Wire the bridge for outbound events (Phase 4)

After the first deploy, the bridge needs to know where the Lambda's
`/event` endpoint lives. The daemon emits proactive ChangeReports over
the existing WSS upstream; the bridge forwards them to this URL.

On the bridge host (the GKS server at `loxhome-bridge.net`, or wherever
you've deployed `bridge/nginx-proxy/`):

1. Look up `OAuthBaseUrl` from the SAM stack output (printed by
   `deploy-prod`, or re-fetch with:)
   ```bash
   aws cloudformation describe-stacks --stack-name loxberry-alexa \
       --profile loxberry-alexa --region eu-west-1 \
       --query "Stacks[0].Outputs[?OutputKey=='OAuthBaseUrl'].OutputValue" \
       --output text
   ```
2. Edit the bridge's `.env` and set `LAMBDA_EVENT_URL` to
   `<OAuthBaseUrl>/event`. Example:
   ```
   LAMBDA_EVENT_URL=https://abcd1234.execute-api.eu-west-1.amazonaws.com/event
   ```
3. Restart the bridge container:
   ```bash
   cd /opt/dockerapp/aloxberry-bridge
   docker compose up -d
   ```

Without this, the daemon will still emit ChangeReports but the bridge
logs and drops them (look for `LAMBDA_EVENT_URL not set` in bridge
logs). Inbound directives are unaffected — they don't use this URL.

### Verifying Phase 4 end-to-end

After the LWA credentials (step 5) are in place, the skill is linked,
and the bridge has `LAMBDA_EVENT_URL` set:

1. Flip a Loxone switch you've exposed via the plugin's Devices tab
   (either physically or via the Loxone app).
2. Within ~1 second, the Alexa app should reflect the new state.
3. To trace the chain:
   - Daemon log → `ChangeReport dispatched` with `endpointId` + `propertyCount`.
   - Bridge container log → `forwardReport` (no message if successful;
     warnings if the Lambda URL is unset or returns non-2xx).
   - OAuth Lambda CloudWatch → `event.delivered` (success) or one of
     `event.bridge_auth_failed`, `event.hmac_failed`, `event.no_matching_users`,
     `event.gateway_non2xx`, `event.user_failed` for diagnostics:
     ```bash
     aws logs tail /aws/lambda/loxberry-alexa-oauth-prod --follow \
                   --profile loxberry-alexa --region eu-west-1
     ```

## Subsequent deploys

```powershell
.\aws\scripts\deploy-prod.ps1
```
```bash
./aws/scripts/deploy-prod.sh
```

After you've created the skill in the Alexa Developer Console and have
its ID (`amzn1.ask.skill.<uuid>`), edit `aws/samconfig.toml`'s
`parameter_overrides` to include `AlexaSkillId=amzn1.ask.skill.<uuid>`
and redeploy. This restricts the Lambda's invoke permission to your
specific skill instead of the open `alexa-connectedhome.amazon.com`
principal.

## Support scripts

### Inspect the DDB tables

Read-only; safe to run any time. Secrets (`skillSecret`, `refreshToken`)
are redacted unless you pass `--full` / `-Full`.

```bash
./aws/scripts/ddb-list.sh                  # users table, safe view
./aws/scripts/ddb-list.sh --auth-codes     # auth-codes table
./aws/scripts/ddb-list.sh --full           # raw JSON, includes secrets
./aws/scripts/ddb-list.sh --stage dev      # dev tables
```
```powershell
.\aws\scripts\ddb-list.ps1
.\aws\scripts\ddb-list.ps1 -AuthCodes
.\aws\scripts\ddb-list.ps1 -Full
.\aws\scripts\ddb-list.ps1 -Stage dev
```

### Wipe a DDB table

Two safety layers: dry-run by default; with `--apply`/`-Apply` the script
prompts for a typed confirmation that includes the row count + table
name, so you can't satisfy it with reflex.

```bash
./aws/scripts/ddb-clear.sh                 # dry-run (lists keys; no writes)
./aws/scripts/ddb-clear.sh --apply         # delete, after typed confirmation
./aws/scripts/ddb-clear.sh --auth-codes    # target auth-codes table instead
```
```powershell
.\aws\scripts\ddb-clear.ps1
.\aws\scripts\ddb-clear.ps1 -Apply
.\aws\scripts\ddb-clear.ps1 -AuthCodes
```

Wiping the users table forces every linked Alexa user to re-link the
skill through the OAuth flow. Wiping auth-codes is harmless — they
self-expire within 10 minutes anyway.

## Build details

The deploy script always passes `--build-in-source`. This is required
because SAM's lambda-builders esbuild workflow only finds `esbuild` by
walking up from the function's own directory; without this flag, the
build runs in a scratch tempdir and never sees our function-local
esbuild install. Each Lambda function therefore lists `esbuild` in its
own `package.json` as a regular dependency — esbuild only runs at build
time, but SAM's per-function `npm install --omit=dev` won't touch
`devDependencies`. The bundled artifact is a single `index.js` (plus
source map); no `node_modules/` ships to Lambda.

`--build-in-source` does leave a `node_modules/` directory next to each
function's source after build — both are gitignored.

### Why deploy-prod nukes caches every run

`@aloxberry/shared` is a local file-link dep (`"file:../shared"`). npm
copies file: deps once at install time and never refreshes them on
content-only edits, even when the cached copy is stale. esbuild's
incremental hashing inside `.aws-sam/` then misses content changes
inside the stale copy. Deleting both caches at the start of every
deploy is faster and more reliable than trying to invalidate them
precisely.

## Sensitive data

Never commit:
- `.env` files
- `aws/samconfig.toml` (contains your stack name, region, parameters)
- `.aws-sam/` build artifacts
- Any private keys or signing secrets
- IAM credentials

The repo's root `.gitignore` covers all of these.

Both Lambda CloudWatch log groups have a 14-day retention by default
(configurable via the `LogRetentionDays` stack parameter).
