# List entries in the Aloxberry DynamoDB tables.
#
# Default target is the users table (the persistent linked-account state).
# Use -AuthCodes for the short-lived OAuth-code table.
#
# Secrets (skillSecret, refreshToken, prevRefreshToken) are not printed in
# the default view. Use -Full for raw DynamoDB JSON.
#
# For the users table the safe view shows:
#   - one row per linked Alexa account, with the LWA link-status column
#     (OK | REVOKED) sourced from the `lwaRevoked` flag the Lambda sets
#     on `invalid_grant`, sorted revoked-first;
#   - a per-bridgeUserId summary grouping users by Loxone installation,
#     so an "N of M accounts on this bridge need re-link" pattern is
#     visible at a glance.
#
# Usage:
#   .\aws\scripts\ddb-list.ps1                 # users table, safe view
#   .\aws\scripts\ddb-list.ps1 -AuthCodes      # auth-codes table
#   .\aws\scripts\ddb-list.ps1 -Stage dev      # use dev tables
#   .\aws\scripts\ddb-list.ps1 -Full           # raw JSON (includes secrets)

[CmdletBinding()]
param(
    [switch] $AuthCodes,
    [switch] $Full,
    [ValidateSet('prod','dev')]
    [string] $Stage   = 'prod',
    [string] $Profile = 'loxberry-alexa',
    [string] $Region  = 'eu-west-1'
)

$ErrorActionPreference = 'Stop'

$target = if ($AuthCodes) { 'authcodes' } else { 'users' }
$table  = if ($target -eq 'users') { "alexa-loxberry-users-$Stage" } else { "alexa-loxberry-authcodes-$Stage" }

Write-Host "Table: $table" -ForegroundColor Cyan
Write-Host ""

if ($Full) {
    aws dynamodb scan --table-name $table --region $Region --profile $Profile --output json
    if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb scan failed' }
    exit 0
}

# Single scan, local processing. Keeps DDB read cost the same as before
# while letting us derive Status + the per-bridge aggregate without a
# second round trip.
$json = aws dynamodb scan `
    --table-name $table --region $Region --profile $Profile `
    --output json
if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb scan failed' }

$scan  = $json | ConvertFrom-Json
$items = if ($scan.Items) { $scan.Items } else { @() }

if ($target -eq 'authcodes') {
    # The auth-codes table is short-lived OAuth state; no link-status to
    # surface, just keep the original projection.
    $rows = $items | ForEach-Object {
        [PSCustomObject]@{
            Code    = $_.code.S
            User    = $_.userId.S
            TTL     = $_.ttl.N
            Created = $_.createdAt.S
        }
    }
    $rows | Format-Table -AutoSize
    Write-Host ""
    Write-Host ("Rows: " + $items.Count)
    Write-Host "(secrets hidden; use -Full for raw JSON)"
    exit 0
}

# ---- Users table: per-user view + per-bridge summary -----------------------

$rows = $items | ForEach-Object {
    $revoked = ($_.lwaRevoked -ne $null) -and ($_.lwaRevoked.BOOL -eq $true)
    [PSCustomObject]@{
        User       = $_.userId.S
        Bridge     = $_.bridgeUserId.S
        Name       = $_.friendlyName.S
        Status     = if ($revoked) { 'REVOKED' } else { 'OK' }
        Created    = $_.createdAt.S
        Granted    = if ($_.lwaGrantedAt) { $_.lwaGrantedAt.S } else { '' }
        RevokedAt  = if ($_.lwaRevokedAt) { $_.lwaRevokedAt.S } else { '' }
        # Carry the boolean separately so the bridge-summary pass below
        # does not have to re-parse the Status string.
        _Revoked   = $revoked
    }
}

# Sort revoked rows to the top so problems are immediately visible.
$sorted = $rows | Sort-Object @{Expression='_Revoked';Descending=$true},
                              @{Expression='Bridge';   Descending=$false},
                              @{Expression='Created';  Descending=$false}

Write-Host "USERS" -ForegroundColor Cyan
$sorted | Select-Object User, Bridge, Name, Status, Created, Granted, RevokedAt |
    Format-Table -AutoSize

# Per-bridge aggregate. One row per Loxone installation, with OK vs revoked
# counts. The State column collapses the most common shapes into a short
# label so an operator can scan the column without doing arithmetic.
$bridges = $rows | Group-Object Bridge | ForEach-Object {
    $total   = $_.Count
    $revoked = ($_.Group | Where-Object { $_._Revoked }).Count
    $ok      = $total - $revoked
    $state   = if    ($revoked -eq 0)       { 'healthy' }
               elseif ($revoked -eq $total) { 'ALL ACCOUNTS NEED RE-LINK' }
               else                         { "$revoked of $total need re-link" }
    [PSCustomObject]@{
        Bridge  = $_.Name
        Users   = $total
        OK      = $ok
        Revoked = $revoked
        State   = $state
    }
} | Sort-Object @{Expression='Revoked';Descending=$true}, Bridge

Write-Host "BRIDGES" -ForegroundColor Cyan
$bridges | Format-Table -AutoSize

# Top-line summary.
$totalUsers   = $items.Count
$totalRevoked = ($rows | Where-Object { $_._Revoked }).Count
$totalOk      = $totalUsers - $totalRevoked
$totalBridges = ($bridges | Measure-Object).Count

Write-Host ("Users:   {0} total, {1} OK, {2} revoked" -f $totalUsers, $totalOk, $totalRevoked)
Write-Host ("Bridges: {0} total" -f $totalBridges)
Write-Host "(secrets hidden; use -Full for raw JSON)"
