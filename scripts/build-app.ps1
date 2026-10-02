
param(
    [switch]$SkipRenderer,
    [string]$Bundle = 'nsis'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$env:CARGO_BUILD_JOBS = '3'

if (-not $SkipRenderer) {
    Push-Location (Join-Path $Root 'ui')
    try {
        bun run typecheck
        if ($LASTEXITCODE -ne 0) { throw "bun run typecheck failed with exit code $LASTEXITCODE" }
        bun run test
        if ($LASTEXITCODE -ne 0) { throw "bun run test failed with exit code $LASTEXITCODE" }
        bun run build
        if ($LASTEXITCODE -ne 0) { throw "bun run build failed with exit code $LASTEXITCODE" }
        bun run check:css
        if ($LASTEXITCODE -ne 0) { throw "bun run check:css failed with exit code $LASTEXITCODE" }
    } finally { Pop-Location }
}

& "$env:ProgramFiles\Git\bin\bash.exe" -lc ('export LC_ALL=C.UTF-8; cd "$(cygpath -u "' +
    ($Root -replace '\\','/') + '")"; bash scripts/check-renderer-fresh.sh')
if ($LASTEXITCODE -ne 0) { throw "scripts/check-renderer-fresh.sh failed with exit code $LASTEXITCODE" }

Push-Location $Root
try {
    cargo build --locked --release --manifest-path core/Cargo.toml --bin tr-helper --bin houston-core
    if ($LASTEXITCODE -ne 0) { throw "sidecar build failed with exit code $LASTEXITCODE" }
    $hostTriple = (rustc -vV | Select-String '^host: ').ToString().Substring(6)
    if ($LASTEXITCODE -ne 0) { throw "rustc -vV failed with exit code $LASTEXITCODE" }
    $binaries = Join-Path $Root 'src-tauri/binaries'
    New-Item -ItemType Directory -Force $binaries | Out-Null
    foreach ($name in @('tr-helper', 'houston-core')) {
        Copy-Item -LiteralPath (Join-Path $Root "core/target/release/$name.exe") `
            -Destination (Join-Path $binaries "$name-$hostTriple.exe") -Force
    }
} finally { Pop-Location }

Push-Location (Join-Path $Root 'src-tauri')
try {
    cargo tauri build --no-bundle --ci -- --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri build --no-bundle failed with exit code $LASTEXITCODE" }
} finally { Pop-Location }

$packaged = Join-Path $Root 'src-tauri\target\release\houston.exe'
if (-not (Test-Path -LiteralPath $packaged)) { throw "Tauri application missing at $packaged" }
Write-Host "packaged binary: $packaged"

$helperSrc = Join-Path $Root 'core\target\release\tr-helper.exe'
$helperDst = Join-Path $Root 'src-tauri\target\release\tr-helper.exe'
Copy-Item -LiteralPath $helperSrc -Destination $helperDst -Force
Write-Host "packaged helper: $helperDst"

$coreSrc = Join-Path $Root 'core\target\release\houston-core.exe'
$coreDst = Join-Path $Root 'src-tauri\target\release\houston-core.exe'
Copy-Item -LiteralPath $coreSrc -Destination $coreDst -Force
Write-Host "packaged daemon sidecar: $coreDst"
Write-Host "installer step (when wanted, from src-tauri): cargo tauri bundle --bundles $Bundle"
