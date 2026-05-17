# Query - or change - the beta connection cap, and show how many distinct
# LoxBerry installations are currently linked.
#
# "Connections" here = DISTINCT bridgeUserId values in the users table (one
# physical LoxBerry install = one slot, no matter how many Alexa accounts it
# linked). This matches exactly what the oauth-handler enforces at link time.
#
# The live limit lives in the config table under key `betaMaxConnections`.
# If that item doesn't exist yet, the Lambda is still using its env-var
# default (BetaMaxConnectionsDefault, 100) and will seed the item on the next
# link attempt.
#
# Usage:
#   .\aws\scripts\beta-limit.ps1                 # query (limit + usage)
#   .\aws\scripts\beta-limit.ps1 -Set 250        # raise the cap to 250
#   .\aws\scripts\beta-limit.ps1 -Stage dev      # use dev tables

[CmdletBinding()]
param(
    [int]    $Set     = -1,
    [ValidateSet('prod','dev')]
    [string] $Stage   = 'prod',
    [string] $Profile = 'loxberry-alexa',
    [string] $Region  = 'eu-west-1'
)

$ErrorActionPreference = 'Stop'

$usersTable  = "alexa-loxberry-users-$Stage"
$configTable = "alexa-loxberry-config-$Stage"
$configKey   = 'betaMaxConnections'

function Get-ConfiguredLimit {
    $keyFile = [System.IO.Path]::Combine(
        [System.IO.Path]::GetTempPath(),
        "beta-limit-key-$([guid]::NewGuid().ToString('N')).json")
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    try {
        $keyJson = ConvertTo-Json -InputObject @{ configKey = @{ S = $configKey } } -Compress
        [System.IO.File]::WriteAllText($keyFile, $keyJson, $utf8NoBom)
        $raw = aws dynamodb get-item `
            --table-name $configTable --region $Region --profile $Profile `
            --key "file://$keyFile" --query 'Item.value.N' --output text
        if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb get-item failed' }
        if ([string]::IsNullOrWhiteSpace($raw) -or $raw -eq 'None') { return $null }
        return [int]$raw
    } finally {
        if (Test-Path -LiteralPath $keyFile) {
            Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-DistinctInstalls {
    $raw = aws dynamodb scan `
        --table-name $usersTable --region $Region --profile $Profile `
        --projection-expression 'bridgeUserId' `
        --query 'Items[*].bridgeUserId.S' --output text
    if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb scan failed' }
    if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
    return ($raw -split '\s+' | Where-Object { $_ } | Sort-Object -Unique)
}

# ---- Set mode ---------------------------------------------------------------
if ($Set -ge 0) {
    $itemFile = [System.IO.Path]::Combine(
        [System.IO.Path]::GetTempPath(),
        "beta-limit-item-$([guid]::NewGuid().ToString('N')).json")
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    try {
        $item = @{
            configKey = @{ S = $configKey }
            value     = @{ N = "$Set" }
            updatedAt = @{ S = (Get-Date).ToUniversalTime().ToString('o') }
            note      = @{ S = 'Beta cap on distinct LoxBerry installations.' }
        }
        $itemJson = ConvertTo-Json -InputObject $item -Compress -Depth 5
        [System.IO.File]::WriteAllText($itemFile, $itemJson, $utf8NoBom)
        aws dynamodb put-item `
            --table-name $configTable --region $Region --profile $Profile `
            --item "file://$itemFile" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb put-item failed' }
    } finally {
        if (Test-Path -LiteralPath $itemFile) {
            Remove-Item -LiteralPath $itemFile -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "Beta cap set to $Set in $configTable." -ForegroundColor Green
    Write-Host ""
}

# ---- Query mode (always runs) -----------------------------------------------
$limit     = Get-ConfiguredLimit
$installs  = @(Get-DistinctInstalls)
$used      = $installs.Count

Write-Host "Stage:                 $Stage"
if ($null -eq $limit) {
    Write-Host "Configured limit:      (not set - Lambda uses its env default, 100)" -ForegroundColor Yellow
} else {
    Write-Host "Configured limit:      $limit"
}
Write-Host "Distinct installs:     $used"
if ($null -ne $limit) {
    $remaining = [Math]::Max(0, $limit - $used)
    $color = if ($remaining -eq 0) { 'Red' } elseif ($remaining -le 5) { 'Yellow' } else { 'Green' }
    Write-Host "Remaining slots:       $remaining" -ForegroundColor $color
}
