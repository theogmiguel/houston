
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

$Launcher = Join-Path $Root 'apps\desktop\scripts\start-electron.mjs'

Write-Host '[dev] building the v2 web renderer, server and desktop host...'
Invoke-BuildStep -WorkingDirectory $Root -FilePath 'npx' -ArgumentList @('-y', 'pnpm@12.14.0', 'run', 'build:desktop')

Write-Host "[dev] starting the desktop app on channel '$env:HOUSTON_CHANNEL'... (Ctrl+C ends it AND its sessions)"
& node $Launcher
exit $LASTEXITCODE
