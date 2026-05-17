# List entries in the Aloxberry DynamoDB tables.
#
# Default target is the users table (the persistent linked-account state).
# Use -AuthCodes for the short-lived OAuth-code table.
#
# Secrets (skillSecret, refreshToken, prevRefreshToken) are not printed in
# the default view. Use -Full for raw DynamoDB JSON.
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

if ($target -eq 'users') {
    aws dynamodb scan `
        --table-name $table --region $Region --profile $Profile `
        --query 'Items[*].{User:userId.S,Bridge:bridgeUserId.S,Name:friendlyName.S,Created:createdAt.S,Updated:updatedAt.S}' `
        --output table
} else {
    aws dynamodb scan `
        --table-name $table --region $Region --profile $Profile `
        --query 'Items[*].{Code:code.S,User:userId.S,TTL:ttl.N,Created:createdAt.S}' `
        --output table
}
if ($LASTEXITCODE -ne 0) { throw 'aws dynamodb scan failed' }

$count = aws dynamodb scan `
    --table-name $table --region $Region --profile $Profile `
    --select COUNT --query Count --output text

Write-Host ""
Write-Host "Rows: $count"
Write-Host "(secrets hidden; use -Full for raw JSON)"
