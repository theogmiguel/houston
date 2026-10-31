
param(
    [string]$Bundle = 'nsis'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$env:CARGO_BUILD_JOBS = '3'

Push-Location (Join-Path $Root 'src-tauri')
try {
    cargo tauri build --no-bundle --ci -- --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build --no-bundle failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$packaged = Join-Path $Root 'src-tauri\target\release\houston.exe'
if (-not (Test-Path -LiteralPath $packaged)) { throw "Tauri application missing at $packaged" }
Write-Host "packaged binary: $packaged"
Write-Host "installer step (when wanted, from src-tauri): cargo tauri bundle --bundles $Bundle"
