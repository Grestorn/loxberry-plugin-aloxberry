# Build the aloxberry-bridge container image and push it to ghcr.io.
#
# Targets the registry image referenced by bridge/nginx-proxy/docker-compose.yaml
# (ghcr.io/grestorn/aloxberry-bridge:latest). The local Caddy-stack deployment
# at bridge/docker-compose.yml uses `build: .` and does NOT need this script;
# `docker compose up -d --build` rebuilds in place there.
#
# Prerequisites:
#   - docker (Docker Desktop on Windows is fine)
#   - One-time:  docker login ghcr.io
#     Use a GitHub Personal Access Token with `write:packages` scope as the
#     password. Login persists in $env:USERPROFILE\.docker\config.json.
#
# Usage:
#   .\bridge\build-and-push.ps1                  # build + push :latest and :git-<sha>
#   .\bridge\build-and-push.ps1 -BuildOnly       # build, no push (smoke test)
#   .\bridge\build-and-push.ps1 -Tag v0.2.0      # also tag + push :v0.2.0
#
# After a successful push, on the bridge host (GKS server):
#   cd /opt/dockerapp/aloxberry-bridge
#   docker compose pull
#   docker compose up -d
#
# To roll back, target the previous git-<sha> tag explicitly in the compose
# `image:` field, then `docker compose up -d`.

[CmdletBinding()]
param(
    [switch] $BuildOnly,
    [string] $Tag = ''
)

$ErrorActionPreference = 'Stop'

$Registry  = 'ghcr.io'
$ImagePath = 'grestorn/aloxberry-bridge'
$Image     = "${Registry}/${ImagePath}"

$scriptDir = Split-Path -Parent $PSCommandPath
Set-Location $scriptDir

if (-not (Test-Path -LiteralPath 'Dockerfile' -PathType Leaf)) {
    throw "Dockerfile missing -- script is not in bridge/"
}

# Derive an immutable build tag from the current git commit. Outside a git
# checkout (rare -- CI?), fall back to a timestamp so we still get a
# rollback-able tag.
$gitSha = $null
try {
    $gitSha = (git rev-parse --short=8 HEAD 2>$null).Trim()
} catch {}

if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrEmpty($gitSha)) {
    $buildTag = "git-$gitSha"
    $dirty = (git status --porcelain 2>$null)
    if (-not [string]::IsNullOrWhiteSpace($dirty)) {
        Write-Warning "Working tree has uncommitted changes -- git tag $buildTag won't match HEAD exactly."
    }
} else {
    $buildTag = "build-$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
    Write-Warning "Not in a git checkout -- using timestamp tag $buildTag."
}

Write-Host "==> docker build" -ForegroundColor Cyan
Write-Host "    image: $Image"
$tagList = "latest, $buildTag"
if ($Tag) { $tagList += ", $Tag" }
Write-Host "    tags:  $tagList"
Write-Host ""

# Assemble args. PowerShell argument splatting handles each token cleanly.
$buildArgs = @(
    'build',
    '--pull',
    '--tag', "${Image}:latest",
    '--tag', "${Image}:$buildTag"
)
if ($Tag) {
    $buildArgs += @('--tag', "${Image}:$Tag")
}
$buildArgs += @('--file', 'Dockerfile', '.')

$env:DOCKER_BUILDKIT = '1'
& docker @buildArgs
if ($LASTEXITCODE -ne 0) { throw "docker build failed (exit $LASTEXITCODE)" }

if ($BuildOnly) {
    Write-Host ""
    Write-Host "Build complete. Skipping push (-BuildOnly)." -ForegroundColor Green
    Write-Host "To inspect locally:  docker run --rm -e BRIDGE_DISPATCH_SECRET=test ${Image}:latest"
    return
}

Write-Host ""
Write-Host "==> docker push" -ForegroundColor Cyan

# Push :latest first -- that's what `docker compose pull` on the bridge host
# fetches. If auth fails, surface a clear hint.
& docker push "${Image}:latest"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push failed. If the error mentions denied / unauthorized:" -ForegroundColor Red
    Write-Host "  docker login ghcr.io"
    Write-Host "  (use a GitHub PAT with write:packages scope as the password)"
    throw "docker push :latest failed"
}
& docker push "${Image}:$buildTag"
if ($LASTEXITCODE -ne 0) { throw "docker push :$buildTag failed" }
if ($Tag) {
    & docker push "${Image}:$Tag"
    if ($LASTEXITCODE -ne 0) { throw "docker push :$Tag failed" }
}

Write-Host ""
Write-Host "Push complete:" -ForegroundColor Green
Write-Host "  ${Image}:latest"
Write-Host "  ${Image}:$buildTag"
if ($Tag) { Write-Host "  ${Image}:$Tag" }
Write-Host ""
Write-Host "To deploy on the bridge host:"
Write-Host "  ssh <bridge-host>"
Write-Host "  cd /opt/dockerapp/aloxberry-bridge"
Write-Host "  docker compose pull; docker compose up -d"
Write-Host ""
Write-Host "To roll back to this build later, set image: ${Image}:$buildTag"
Write-Host "in docker-compose.yaml on the bridge host and re-run docker compose up -d."
