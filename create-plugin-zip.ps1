# Build an installable .lbplugin (zip) archive of this plugin.
# Output: <plugin>-<version>-snapshot.zip in the repo root.
#
# Sister to create-plugin-zip.sh — same logic, PowerShell-native I/O.
# The archive contains a snapshot of the current working tree (uncommitted
# changes included). Tag + release.cfg bump separately for AUTOUPDATE users.

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# ---- Plugin metadata from plugin.cfg --------------------------------------

function Get-CfgValue([string] $Key, [string] $Default) {
    $line = Select-String -Path plugin.cfg -Pattern "^$Key=" -SimpleMatch:$false |
            Select-Object -First 1
    if ($null -eq $line) { return $Default }
    return ($line.Line -replace "^$Key=", '').Trim()
}

$pluginName = Get-CfgValue 'FOLDER'  'alexa-aloxberry'
$version    = Get-CfgValue 'VERSION' 'dev'
$version    = "$version-snapshot"
$zipName    = "$pluginName-$version.zip"

Write-Host "Building $zipName ..." -ForegroundColor Cyan
Write-Host ""

# ---- Staging dir -----------------------------------------------------------
# LoxBerry expects the zip root to contain a single folder named after the
# plugin. So we copy our payload into $stageDir\$pluginName\ and zip that.

$tempRoot = Join-Path $env:TEMP "loxberry-plugin-$(Get-Random)"
$stageDir = Join-Path $tempRoot $pluginName
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

try {
    # --- Top-level files (lifecycle hooks + plugin metadata) ----------------
    # Skip silently if a file is missing (e.g. release.cfg might not be set up
    # yet on a fresh fork).
    $topLevelFiles = @(
        'plugin.cfg', 'release.cfg', 'prerelease.cfg',
        'preinstall.sh', 'postinstall.sh',
        'preupgrade.sh', 'postupgrade.sh'
    )
    foreach ($f in $topLevelFiles) {
        if (Test-Path $f -PathType Leaf) {
            Copy-Item $f -Destination $stageDir
        }
    }

    # --- Whole directories that ship as-is ----------------------------------
    # uninstall/   — required by LoxBerry conventions
    # cron/        — auto-start hooks
    # icons/       — plugin icons
    # templates/   — i18n + HTML::Template files (used by index.cgi)
    # doc/         — user docs (optional)
    # webfrontend/ — htmlauth/plugins/<plugin>/index.cgi
    $dirsAsIs = @('uninstall', 'cron', 'icons', 'templates', 'doc', 'webfrontend')
    foreach ($d in $dirsAsIs) {
        if (Test-Path $d -PathType Container) {
            Copy-Item -Recurse -Path $d -Destination $stageDir
        }
    }

    # --- bin/ — selective ---------------------------------------------------
    # We ship src/, control.sh, tail-daemon.sh, lox-*.pl, and package*.json.
    # postinstall.sh runs `npm install --omit=dev` on the LoxBerry — that's
    # where node_modules gets built, with the right native ABI.
    # Explicitly drop dev-only subdirs (scripts/, test/, data/, node_modules/).
    $binDest = Join-Path $stageDir 'bin'
    New-Item -ItemType Directory -Path $binDest -Force | Out-Null

    Copy-Item -Recurse -Path 'bin\src' -Destination $binDest

    $binFiles = @(
        'bin\control.sh', 'bin\tail-daemon.sh',
        'bin\log-session-create.pl',
        'bin\lox-getconfig.pl', 'bin\lox-getstructure.pl',
        'bin\lox-send.pl', 'bin\lox-control.pl',
        'bin\package.json', 'bin\package-lock.json',
        'bin\.gitkeep'
    )
    foreach ($f in $binFiles) {
        if (Test-Path $f -PathType Leaf) {
            Copy-Item $f -Destination $binDest
        }
    }

    # --- Sanity check: required payload files must be present ---------------
    $required = @(
        'plugin.cfg', 'preinstall.sh', 'postinstall.sh',
        'bin\src\index.js', 'bin\package.json',
        'bin\control.sh', 'cron\cron.reboot'
    )
    foreach ($r in $required) {
        $path = Join-Path $stageDir $r
        if (-not (Test-Path $path)) {
            throw "Staged tree is missing required file: $r"
        }
    }

    # --- Inventory --------------------------------------------------------
    Write-Host "Staged tree:" -ForegroundColor Cyan
    Get-ChildItem -Recurse -File -Path $stageDir |
        ForEach-Object { '  ' + ($_.FullName.Substring($stageDir.Length + 1) -replace '\\', '/') } |
        Sort-Object |
        ForEach-Object { Write-Host $_ }
    Write-Host ""

    # --- Zip --------------------------------------------------------------
    # We shell out to Info-ZIP's `zip.exe` (install on Windows via
    # `choco install zip`). The reason for not using PowerShell's built-ins:
    #
    #   - Compress-Archive silently drops dotfiles (PowerShell issue #9011)
    #     → our .gitkeep entries vanished, breaking install on empty dirs.
    #   - [System.IO.Compression.ZipFile]::CreateFromDirectory writes entry
    #     names with backslashes on Windows (dotnet/runtime#41914), which
    #     violates the ZIP spec → Linux `unzip` warns and exits non-zero,
    #     which LoxBerry's plugin installer treats as CRITICAL.
    #
    # `zip.exe` is decades-mature, handles dotfiles, and uses forward
    # slashes. Same tool the bash script uses — single source of truth.
    if (-not (Get-Command zip -ErrorAction SilentlyContinue)) {
        throw "zip.exe is required. Install with:  choco install zip"
    }

    $zipPath = Join-Path $PSScriptRoot $zipName
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }

    # `zip -r` recurses; `-q` is quiet. We run it from the *parent* of the
    # staged tree so entry names start with "alexa-aloxberry/...".
    Push-Location $tempRoot
    try {
        & zip -rq $zipPath $pluginName
        if ($LASTEXITCODE -ne 0) {
            throw "zip exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    $size = (Get-Item $zipPath).Length
    $sizeKB = [math]::Round($size / 1KB, 1)
    Write-Host ("OK  Built {0}  ({1} KB)" -f $zipName, $sizeKB) -ForegroundColor Green
    Write-Host "    Upload via: LoxBerry -> Plugin install -> choose this file"
}
finally {
    # Always clean up the staging dir, even on error.
    if (Test-Path $tempRoot) {
        Remove-Item -Recurse -Force $tempRoot
    }
}
