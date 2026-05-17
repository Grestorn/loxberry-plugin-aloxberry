# Clear all entries from a Aloxberry DynamoDB table.
#
# Two safety layers:
#   - Default is dry-run: lists the keys that would be deleted; no writes.
#   - With -Apply, the script prompts for a typed confirmation including
#     the row count + table name; only proceeds on an exact match. This is
#     deliberately impossible to satisfy with a simple "y/n" reflex.
#
# Scope: the users table is the persistent linked-account state — wiping
# it forces every Alexa user to re-link the skill. The auth-codes table
# is short-lived (10-min TTL) and clearing it has no user-visible effect.
#
# Usage:
#   .\aws\scripts\ddb-clear.ps1                          # dry-run, users-prod
#   .\aws\scripts\ddb-clear.ps1 -Apply                   # actually delete (with prompt)
#   .\aws\scripts\ddb-clear.ps1 -AuthCodes               # target auth-codes table
#   .\aws\scripts\ddb-clear.ps1 -Stage dev -Apply        # dev users table

[CmdletBinding()]
param(
    [switch] $AuthCodes,
    [switch] $Apply,
    [ValidateSet('prod','dev')]
    [string] $Stage   = 'prod',
    [string] $Profile = 'loxberry-alexa',
    [string] $Region  = 'eu-west-1'
)

$ErrorActionPreference = 'Stop'

$target  = if ($AuthCodes) { 'authcodes' } else { 'users' }
$table   = if ($target -eq 'users') { "alexa-loxberry-users-$Stage" } else { "alexa-loxberry-authcodes-$Stage" }
$keyName = if ($target -eq 'users') { 'userId' } else { 'code' }

# Pull keys only.
$raw = aws dynamodb scan `
    --table-name $table --region $Region --profile $Profile `
    --projection-expression $keyName `
    --query "Items[*].$keyName.S" `
    --output text
if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb scan failed' }

$keys = @()
if (-not [string]::IsNullOrWhiteSpace($raw)) {
    $keys = $raw -split '\s+' | Where-Object { $_ }
}
$count = $keys.Count

Write-Host "Table: $table" -ForegroundColor Cyan
Write-Host "Rows:  $count"
Write-Host ""

if ($count -eq 0) {
    Write-Host "Nothing to delete." -ForegroundColor Green
    exit 0
}

Write-Host "Keys that would be deleted:"
foreach ($k in $keys) { Write-Host "  - $k" }

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry-run (no deletions). Re-run with -Apply to actually delete." -ForegroundColor Yellow
    exit 0
}

$expected = "DELETE $count FROM $table"
Write-Host ""
Write-Host "About to delete $count row(s) from $table." -ForegroundColor Red
Write-Host "Type exactly:  $expected" -ForegroundColor Yellow
$typed = Read-Host '>'

if ($typed -ne $expected) {
    Write-Host "Confirmation did not match. Aborting." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Deleting..."
$i = 0
# Pass the --key payload via `file://` rather than as a quoted string
# argument. Windows PowerShell's native-command argument passing strips
# the inner double quotes from a JSON string before it reaches aws.exe
# ("{userId:{S:abc}}" instead of "{\"userId\":{\"S\":\"abc\"}}"), so the
# CLI rejects it as malformed JSON. file:// is unaffected by any shell
# quoting because no shell is involved — aws.exe reads the file directly.
#
# Encoding caveat: PS 5.1's Set-Content -Encoding utf8 *always* prepends a
# UTF-8 BOM, and aws-cli's JSON parser chokes on the BOM (it gets read as
# the literal three bytes `ï»¿` before the `{`). Bypass Set-Content and
# use .NET's UTF8Encoding(false) constructor to write without the BOM.
$keyFile = [System.IO.Path]::Combine(
    [System.IO.Path]::GetTempPath(),
    "ddb-clear-key-$([guid]::NewGuid().ToString('N')).json"
)
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
try {
    foreach ($k in $keys) {
        $i++
        $keyJson = ConvertTo-Json -InputObject @{ $keyName = @{ S = $k } } -Compress
        [System.IO.File]::WriteAllText($keyFile, $keyJson, $utf8NoBom)
        aws dynamodb delete-item `
            --table-name $table --region $Region --profile $Profile `
            --key "file://$keyFile" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to delete $k" }
        Write-Host "  [$i/$count] deleted $k"
    }
} finally {
    if (Test-Path -LiteralPath $keyFile) {
        Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
