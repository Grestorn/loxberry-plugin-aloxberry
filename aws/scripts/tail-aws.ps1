# Tail CloudWatch logs for the Aloxberry Lambda functions.
#
# Both functions by default (alexa-handler + oauth-handler), interleaved
# with [alexa] / [oauth] line prefixes. Use -Function to narrow to one.
# Ctrl-C exits both.
#
# Usage:
#   .\aws\scripts\tail-aws.ps1                       # tail both, last 1m + live
#   .\aws\scripts\tail-aws.ps1 -Function alexa       # alexa-handler only
#   .\aws\scripts\tail-aws.ps1 -Function oauth       # oauth-handler only
#   .\aws\scripts\tail-aws.ps1 -Since 10m            # show last 10 minutes first
#   .\aws\scripts\tail-aws.ps1 -Filter "ERROR"       # CloudWatch filter pattern
#   .\aws\scripts\tail-aws.ps1 -NoFollow -Since 1h
#       # Dump the last hour's events and exit (no streaming). Use this
#       # for post-mortem diagnostics. Live-tail mode has unavoidable
#       # buffering latency (aws-cli's Python stdout is block-buffered
#       # when not connected to a TTY); -NoFollow has none.
#
# Requires: aws cli v2 authenticated to the `loxberry-alexa` profile.

[CmdletBinding()]
param(
    [ValidateSet('alexa','oauth','both')]
    [string] $Function = 'both',
    [string] $Profile  = 'loxberry-alexa',
    [string] $Region   = 'eu-west-1',
    [string] $Stage    = 'prod',
    [string] $Since    = '1m',
    [string] $Filter   = '',
    # -NoFollow: dump events from --since and exit, instead of streaming.
    # Strongly recommended for past-event lookups: --follow makes aws-cli
    # block-buffer its stdout to a ~4 KB chunk (Python's default when not
    # connected to a TTY), and Start-Job's output pipe + Receive-Job's
    # polling loop can wait minutes for that buffer to fill. -NoFollow
    # works around that by letting each aws process exit (and flush) on
    # its own; you get the historical window with sub-second latency.
    [switch] $NoFollow
)

$ErrorActionPreference = 'Stop'

$alexaLog = "/aws/lambda/loxberry-alexa-directive-$Stage"
$oauthLog = "/aws/lambda/loxberry-alexa-oauth-$Stage"

# Spawn one background job per log group. Each job runs `aws logs tail
# --follow` and emits stdout lines that the parent script polls + tags.
# PS 5.1-compatible (no -Parallel ForEach).
function Start-Tail {
    param(
        [string] $LogGroup,
        [string] $JobName
    )
    $args = @($LogGroup, $Profile, $Region, $Since, $Filter, [bool]$NoFollow)
    Start-Job -Name $JobName -ArgumentList $args -ScriptBlock {
        param($lg, $prof, $reg, $since, $filter, $noFollow)
        $awsArgs = @(
            'logs', 'tail', $lg,
            '--since', $since,
            '--profile', $prof, '--region', $reg
        )
        if (-not $noFollow) {
            $awsArgs += '--follow'
        }
        if ($filter) {
            $awsArgs += @('--filter-pattern', $filter)
        }
        # 2>&1 sweeps aws-cli's stderr into the job's output stream so the
        # operator sees auth/region errors instead of a silent failure.
        & aws @awsArgs 2>&1
    } | Out-Null
}

$started = @()
if ($Function -eq 'alexa' -or $Function -eq 'both') {
    Start-Tail -LogGroup $alexaLog -JobName 'alexa'
    $started += 'alexa'
}
if ($Function -eq 'oauth' -or $Function -eq 'both') {
    Start-Tail -LogGroup $oauthLog -JobName 'oauth'
    $started += 'oauth'
}

Write-Host "Tailing Lambda logs ($($started -join ', '); profile=$Profile region=$Region stage=$Stage since=$Since). Ctrl-C to stop." -ForegroundColor Cyan
Write-Host ""

# Poll jobs ~twice per second and print any new output prefixed with the
# job name. 500 ms is a small latency tradeoff against CPU; sub-second is
# fine for log tailing UX. Cleanup in finally guarantees background jobs
# don't outlive the script even on Ctrl-C.
#
# Loop-exit semantics:
#   default (streaming):  while ($true) — Ctrl-C is the only way out.
#   -NoFollow:            exit when all jobs have completed AND been
#                          drained, so the script returns cleanly after
#                          dumping the requested window.
try {
    while ($true) {
        foreach ($job in (Get-Job)) {
            $name = $job.Name
            $lines = Receive-Job -Job $job
            foreach ($line in $lines) {
                if ($null -ne $line -and "$line".Length -gt 0) {
                    Write-Host "[$name] $line"
                }
            }
        }
        if ($NoFollow) {
            $stillRunning = @(Get-Job | Where-Object { $_.State -eq 'Running' })
            if ($stillRunning.Count -eq 0) { break }
        }
        Start-Sleep -Milliseconds 500
    }
} finally {
    Get-Job | Stop-Job -ErrorAction SilentlyContinue
    Get-Job | Remove-Job -Force -ErrorAction SilentlyContinue
}
