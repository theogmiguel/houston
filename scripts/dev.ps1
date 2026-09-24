
$ErrorActionPreference = 'Stop'

Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot

function Write-DevErr {
    param([string[]]$Lines)
    foreach ($line in $Lines) {
        [Console]::Error.WriteLine($line)
    }
}

function Invoke-BuildStep {
    param([string]$WorkingDirectory, [string]$FilePath, [string[]]$ArgumentList)
    Push-Location $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }
    finally {
        Pop-Location
    }
}

$Argv = @($args)

$Fresh = $false
$PrintTarget = $false
$ChannelArg = ''
$ChannelArgSet = $false

$i = 0
while ($i -lt $Argv.Count) {
    $arg = $Argv[$i]
    if ($arg -ceq '--fresh') {
        $Fresh = $true
        $i += 1
    }
    elseif ($arg -ceq '--print-target') {
        $PrintTarget = $true
        $i += 1
    }
    elseif ($arg -ceq '--channel') {
        if ($i + 1 -ge $Argv.Count) {
            Write-DevErr @("[dev] --channel requires a value (got none). Expected: --channel <name>, e.g. --channel release")
            exit 1
        }
        $ChannelArg = $Argv[$i + 1]
        $ChannelArgSet = $true
        $i += 2
    }
    elseif ($arg.StartsWith('--channel=', [System.StringComparison]::Ordinal)) {
        $ChannelArg = $arg.Substring(10)
        $ChannelArgSet = $true
        $i += 1
    }
    else {
        Write-DevErr @("[dev] unknown flag: '$arg'. Accepted flags: --fresh, --channel <name>, --print-target")
        exit 1
    }
}

if (Test-Path Env:\HOUSTON_CHANNEL) {
    $PaneChannel = $env:HOUSTON_CHANNEL
}
else {
    $PaneChannel = 'release'
}

if ($ChannelArgSet) {
    if ([string]::IsNullOrEmpty($ChannelArg)) {
        Write-DevErr @("[dev] --channel was given an empty value. Expected: 1-32 characters of [a-z0-9-] (not starting or ending with '-'), or the literal 'release'.")
        exit 1
    }
    if ($ChannelArg -ceq 'release') {
    }
    elseif ($ChannelArg -cnotmatch '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$') {
        Write-DevErr @("[dev] --channel '$ChannelArg' is not a valid channel name. Expected: 1-32 characters of [a-z0-9-], not starting or ending with '-', or the literal 'release'.")
        exit 1
    }
    $TargetChannel = $ChannelArg
}
else {
    $TargetChannel = 'dev'
}
$env:HOUSTON_CHANNEL = $TargetChannel

if ($env:HOUSTON_CHANNEL -ceq 'release') {
    $StateDir = Join-Path $HOME '.houston'
    if ($PrintTarget) {
        Write-DevErr @(
            "[dev] WARNING: --channel release requested - a real run would drive the",
            "      INSTALLED APP's own daemon and live state dir ($StateDir)."
        )
    }
    else {
        Write-DevErr @(
            "[dev] WARNING: --channel release requested - this drives the INSTALLED APP's",
            "      own daemon and live state dir ($StateDir). This is the shared,",
            "      dangerous mode: it can touch sessions the installed app owns."
        )
    }
}
else {
    $StateDir = Join-Path $HOME ".houston-$env:HOUSTON_CHANNEL"
}
Write-Host "[dev] channel: $env:HOUSTON_CHANNEL - state dir $StateDir"

if ($PrintTarget) {
    Write-Host "[dev] --print-target: channel=$env:HOUSTON_CHANNEL state_dir=$StateDir"
    exit 0
}

if ($Fresh) {
    if (-not [string]::IsNullOrEmpty($env:HOUSTON_SESSION) -and $PaneChannel -ceq $env:HOUSTON_CHANNEL) {
        Write-DevErr @(
            "[dev] refusing --fresh: this shell runs inside a '$env:HOUSTON_CHANNEL' channel pane (session $env:HOUSTON_SESSION).",
            "      Restarting that app would kill this terminal and every other session on the channel.",
            "      Run it from a pane on another channel (e.g. the installed app), or a terminal outside both."
        )
        exit 1
    }
}

$App = Join-Path $Root 'src-tauri\target\debug\houston-tauri.exe'

Write-Host '[dev] building the renderer...'
Invoke-BuildStep -WorkingDirectory (Join-Path $Root 'ui') -FilePath 'bun' -ArgumentList @('run', 'build')

Write-Host '[dev] building the daemon and hook helper (debug)...'
Invoke-BuildStep -WorkingDirectory (Join-Path $Root 'core') -FilePath 'cargo' -ArgumentList @('build', '--bin', 'houston-core', '--bin', 'tr-helper')

$RustcVersion = & rustc -vV
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
$HostTriple = ($RustcVersion | Where-Object { $_ -match '^host: ' }) -replace '^host: ', ''
if ([string]::IsNullOrWhiteSpace($HostTriple)) {
    throw '[dev] could not read the host target triple from rustc -vV'
}
$SidecarDir = Join-Path $Root 'src-tauri\binaries'
New-Item -ItemType Directory -Path $SidecarDir -Force | Out-Null
foreach ($Sidecar in @('tr-helper', 'houston-core')) {
    Copy-Item -LiteralPath (Join-Path $Root "core\target\debug\$Sidecar.exe") -Destination (Join-Path $SidecarDir "$Sidecar-$HostTriple.exe") -Force
}

Write-Host '[dev] building the app (debug)...'
Invoke-BuildStep -WorkingDirectory (Join-Path $Root 'src-tauri') -FilePath 'cargo' -ArgumentList @('build')

if (-not (Test-Path -LiteralPath $App)) {
    Write-DevErr @("[dev] app binary missing at $App after a successful build - did the bin name change in src-tauri/Cargo.toml?")
    exit 1
}

$env:HOUSTON_DAEMON_BIN_DIR = Join-Path $Root 'core\target\debug'

$AppArgs = @('--channel', $env:HOUSTON_CHANNEL)
if ($Fresh) {
    $AppArgs += '--daemon-fresh'
}

Write-Host "[dev] starting the app on channel '$env:HOUSTON_CHANNEL'... (Ctrl+C ends it AND its sessions)"
& $App @AppArgs
exit $LASTEXITCODE
