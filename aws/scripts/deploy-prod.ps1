# Full production deploy for the Aloxberry AWS backend.
#
# What it does, in order:
#   1. Verifies AWS CLI is logged in to the expected profile/region.
#   2. Ensures both SSM SecureString secrets exist:
#        /loxberry-alexa/jwt-secret              (Lambda -> user-facing JWT signing)
#        /loxberry-alexa/bridge-dispatch-secret  (Lambda <-> bridge shared secret)
#      If a secret is missing, generates 32 random bytes and writes it.
#   3. Runs `sam build --build-in-source`.
#   4. Runs `sam deploy` against the samconfig.toml in aws/ - which already
#      includes BridgeUrl + BridgeDispatchSecretParam in parameter_overrides.
#   5. Prints the stack outputs.
#
# After the SSM secrets are created, the bridge container needs the SAME value
# as /loxberry-alexa/bridge-dispatch-secret in its BRIDGE_DISPATCH_SECRET env
# var. The script prints the value so you can paste it into bridge/.env. If
# the secret already existed, you can re-print it with:
#   .\aws\scripts\deploy-prod.ps1 -ShowBridgeSecret
#
# Usage:
#   .\aws\scripts\deploy-prod.ps1
#   .\aws\scripts\deploy-prod.ps1 -BuildOnly
#   .\aws\scripts\deploy-prod.ps1 -ShowBridgeSecret    # just dump the value, no deploy
#   .\aws\scripts\deploy-prod.ps1 -LogLevel DEBUG      # verbose Lambda logging
#   .\aws\scripts\deploy-prod.ps1 -Force               # don't error on an empty changeset

[CmdletBinding()]
param(
    [switch] $BuildOnly,
    [switch] $ShowBridgeSecret,
    [switch] $Force,
    [string] $Profile = 'loxberry-alexa',
    [string] $Region  = 'eu-west-1',
    # Lambda log level. Defaults to INFO. The @aloxberry/shared logger filters
    # anything below this level - CloudWatch ingestion scales with how many
    # per-request lines survive, so leaving this at INFO is what keeps the
    # production-scale cost bounded. Use DEBUG when investigating.
    [ValidateSet('DEBUG', 'INFO', 'WARN', 'ERROR')]
    [string] $LogLevel = 'INFO'
)

$ErrorActionPreference = 'Stop'

$JWT_PARAM    = '/loxberry-alexa/jwt-secret'
$BRIDGE_PARAM = '/loxberry-alexa/bridge-dispatch-secret'

$scriptRoot = Split-Path -Parent $PSCommandPath
$awsDir     = Split-Path -Parent $scriptRoot
$template   = Join-Path $awsDir 'infrastructure\template.yaml'

# ---------- helpers ---------------------------------------------------------

function Test-SsmParam {
    param([string] $Name)
    try {
        aws ssm get-parameter --name $Name --region $Region --profile $Profile --with-decryption | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    }
}

function Get-SsmParamValue {
    param([string] $Name)
    $value = aws ssm get-parameter --name $Name --region $Region --profile $Profile --with-decryption `
              --query 'Parameter.Value' --output text
    if ($LASTEXITCODE -ne 0) { throw "Could not read SSM parameter $Name" }
    return $value
}

function New-SsmSecret {
    param(
        [string] $Name,
        [string] $Description
    )
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $value = -join ($bytes | ForEach-Object { $_.ToString('x2') })
    Write-Host "  Creating SecureString $Name ..." -ForegroundColor Cyan
    aws ssm put-parameter `
        --name $Name `
        --type SecureString `
        --value $value `
        --description $Description `
        --region $Region `
        --profile $Profile `
        --tags 'Key=project,Value=loxberry-alexa' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to create SSM parameter $Name" }
    return $value
}

# ---------- ShowBridgeSecret shortcut --------------------------------------

if ($ShowBridgeSecret) {
    if (-not (Test-SsmParam -Name $BRIDGE_PARAM)) {
        Write-Error "Bridge dispatch secret has not been created yet. Run without -ShowBridgeSecret first."
        exit 1
    }
    $val = Get-SsmParamValue -Name $BRIDGE_PARAM
    Write-Host ""
    Write-Host "BRIDGE_DISPATCH_SECRET=$val" -ForegroundColor Yellow
    Write-Host "(put this into bridge/.env on the host running the bridge)"
    exit 0
}

# ---------- preflight -------------------------------------------------------

if (-not (Test-Path $template)) {
    throw "SAM template not found at $template"
}

Write-Host "==> Preflight: aws sts get-caller-identity --profile $Profile" -ForegroundColor Cyan
aws sts get-caller-identity --profile $Profile --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "AWS profile '$Profile' is not configured or has expired credentials."
}

# ---------- SSM secrets -----------------------------------------------------

Write-Host "==> Ensuring SSM SecureString secrets exist" -ForegroundColor Cyan

$bridgeJustCreated = $false
$bridgeValue       = $null

if (Test-SsmParam -Name $JWT_PARAM) {
    Write-Host "  [ok] $JWT_PARAM already exists"
} else {
    New-SsmSecret -Name $JWT_PARAM -Description 'JWT signing secret for Aloxberry OAuth access tokens' | Out-Null
    Write-Host "  [ok] $JWT_PARAM created"
}

if (Test-SsmParam -Name $BRIDGE_PARAM) {
    Write-Host "  [ok] $BRIDGE_PARAM already exists"
} else {
    $bridgeValue       = New-SsmSecret -Name $BRIDGE_PARAM -Description 'Shared secret authenticating Lambda calls to the bridge /dispatch endpoint'
    $bridgeJustCreated = $true
    Write-Host "  [ok] $BRIDGE_PARAM created"
}

# ---------- build + deploy --------------------------------------------------

Push-Location $awsDir
try {
    # ---- clear stale @aloxberry/shared snapshots --------------------------
    # npm copies file:../shared at install time and never refreshes it on
    # version-less edits. Deleting the cached copies forces sam build's
    # `npm install` to lay down a fresh copy with the current source.
    # Same for the .aws-sam build cache: esbuild's incremental hashing can
    # miss content changes inside file: deps.
    Write-Host "==> Clearing stale @aloxberry/shared snapshots + .aws-sam cache" -ForegroundColor Cyan
    foreach ($handler in 'alexa-handler', 'oauth-handler') {
        $stale = Join-Path $awsDir "lambda\$handler\node_modules\@aloxberry"
        if (Test-Path $stale) {
            Write-Host "  removing $stale"
            Remove-Item -Recurse -Force $stale
        }
    }
    $samBuildCache = Join-Path $awsDir '.aws-sam'
    if (Test-Path $samBuildCache) {
        Write-Host "  removing $samBuildCache"
        Remove-Item -Recurse -Force $samBuildCache
    }

    Write-Host ""
    Write-Host "==> sam build --build-in-source" -ForegroundColor Cyan
    sam build --template-file $template --build-in-source
    if ($LASTEXITCODE -ne 0) { throw 'sam build failed' }

    if ($BuildOnly) {
        Write-Host "Build complete (no deploy)." -ForegroundColor Green
        return
    }

    Write-Host ""
    Write-Host "==> sam deploy (LogLevel=$LogLevel)" -ForegroundColor Cyan

    # IMPORTANT: SAM CLI does NOT merge a command-line --parameter-overrides
    # with the parameter_overrides in samconfig.toml. The CLI value REPLACES
    # the file value wholesale, and any parameter not restated falls back to
    # the deployed stack's PREVIOUS value. Passing only "LogLevel=..." here
    # silently dropped Stage / AlexaSkillId / BridgeUrl /
    # BridgeDispatchSecretParam, so editing AlexaSkillId in samconfig.toml
    # produced "no changes to deploy" (it kept the old skill id). We read the
    # file's parameter_overrides and append LogLevel so the full set is sent.
    $samconfig = Join-Path $awsDir 'samconfig.toml'
    $cfgParams = ''
    if (Test-Path $samconfig) {
        $m = Select-String -Path $samconfig `
                -Pattern '^\s*parameter_overrides\s*=\s*"(.*)"\s*$' |
             Select-Object -First 1
        if ($m) { $cfgParams = $m.Matches[0].Groups[1].Value }
    }
    if (-not $cfgParams) {
        throw "Could not read parameter_overrides from $samconfig. Refusing to deploy: a partial parameter set would silently reuse the stack's previous values and mask whatever you just changed."
    }
    $mergedParams = (($cfgParams + ' ' + "LogLevel=$LogLevel")).Trim()

    # Guard rail: neither of these may ever go out empty.
    #   BridgeUrl=''    -> both Lambdas refuse to forward directives, so every
    #                      paired user loses Alexa control until the next deploy.
    #   AlexaSkillId='' -> the Lambda permission reopens to ANY Smart Home skill.
    # CloudFormation would accept both without complaint, so check here.
    foreach ($required in @('BridgeUrl', 'AlexaSkillId')) {
        $hit = [regex]::Match(" $mergedParams", "\s$required=(\S*)")
        if ((-not $hit.Success) -or (-not $hit.Groups[1].Value)) {
            throw "Refusing to deploy: $required resolves to an empty value. Merged parameter-overrides: $mergedParams. Fix parameter_overrides in $samconfig and re-run."
        }
    }

    Write-Host "    parameter-overrides: $mergedParams"

    $deployArgs = @(
        '--profile', $Profile, '--region', $Region,
        '--parameter-overrides', $mergedParams
    )
    if ($Force) {
        # CloudFormation is declarative - there is no "force a no-op change".
        # This only stops an empty changeset being treated as an error, for
        # when a redeploy legitimately has nothing to change.
        Write-Host "    -Force: empty changeset will not fail the run" -ForegroundColor DarkYellow
        $deployArgs += '--no-fail-on-empty-changeset'
    }
    sam deploy @deployArgs
    if ($LASTEXITCODE -ne 0) { throw 'sam deploy failed' }

    Write-Host ""
    Write-Host "==> Stack outputs" -ForegroundColor Cyan
    aws cloudformation describe-stacks `
        --stack-name 'loxberry-alexa' `
        --profile $Profile --region $Region `
        --query 'Stacks[0].Outputs' `
        --output table
}
finally {
    Pop-Location
}

# ---------- footer ----------------------------------------------------------

if ($bridgeJustCreated) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Yellow
    Write-Host " Bridge dispatch secret was just created."                    -ForegroundColor Yellow
    Write-Host " Put the value below into bridge/.env on the bridge host:"    -ForegroundColor Yellow
    Write-Host ""
    Write-Host " BRIDGE_DISPATCH_SECRET=$bridgeValue"                          -ForegroundColor White
    Write-Host ""
    Write-Host " You can re-print this later with:"                            -ForegroundColor Yellow
    Write-Host "   .\aws\scripts\deploy-prod.ps1 -ShowBridgeSecret"            -ForegroundColor White
    Write-Host "============================================================" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
