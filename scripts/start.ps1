
param(
    [string]$Channel = $env:HOUSTON_CHANNEL,
    [string]$App = $env:TR_APP
)

$ErrorActionPreference = 'Stop'

if (-not $App) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Houston\houston.exe'),
        (Join-Path $PSScriptRoot '..\src-tauri\target\release\houston.exe')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { $App = $c; break }
    }
}
if (-not $App -or -not (Test-Path -LiteralPath $App)) {
    throw "houston.exe not found; pass -App <path> or set TR_APP"
}

if ($Channel) { $env:HOUSTON_CHANNEL = $Channel }

Start-Process -FilePath $App -WorkingDirectory (Split-Path -Parent $App)
