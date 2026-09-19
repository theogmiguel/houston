
param(
    [switch]$SkipRenderer,
    [string]$Bundle = 'nsis'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

if (-not $SkipRenderer) {
    Push-Location (Join-Path $Root 'ui')
    try {
        bun run typecheck
        bun run test
        bun run build
        bun run check:css
    } finally { Pop-Location }
}

& "$env:ProgramFiles\Git\bin\bash.exe" -lc ('export LC_ALL=C.UTF-8; cd "$(cygpath -u "' +
    ($Root -replace '\\','/') + '")"; bash scripts/check-renderer-fresh.sh')

& "$env:ProgramFiles\Git\bin\bash.exe" -lc ('export LC_ALL=C.UTF-8; cd "$(cygpath -u "' +
    ($Root -replace '\\','/') + '")"; bash scripts/stage-helper.sh --bin tr-helper --profile release')
if ($LASTEXITCODE -ne 0) { throw "scripts/stage-helper.sh failed with exit code $LASTEXITCODE" }

& "$env:ProgramFiles\Git\bin\bash.exe" -lc ('export LC_ALL=C.UTF-8; cd "$(cygpath -u "' +
    ($Root -replace '\\','/') + '")"; bash scripts/stage-helper.sh --bin houston-core --profile release')
if ($LASTEXITCODE -ne 0) { throw "scripts/stage-helper.sh (houston-core) failed with exit code $LASTEXITCODE" }

Push-Location (Join-Path $Root 'src-tauri')
try {
    $env:CARGO_BUILD_JOBS = '6'
    cargo build --release
} finally { Pop-Location }

$built = Join-Path $Root 'src-tauri\target\release\houston-tauri.exe'
$packaged = Join-Path $Root 'src-tauri\target\release\houston.exe'
Copy-Item -LiteralPath $built -Destination $packaged -Force
Write-Host "packaged binary: $packaged"

$helperSrc = Join-Path $Root 'core\target\release\tr-helper.exe'
$helperDst = Join-Path $Root 'src-tauri\target\release\tr-helper.exe'
Copy-Item -LiteralPath $helperSrc -Destination $helperDst -Force
Write-Host "packaged helper: $helperDst"

$coreSrc = Join-Path $Root 'core\target\release\houston-core.exe'
$coreDst = Join-Path $Root 'src-tauri\target\release\houston-core.exe'
Copy-Item -LiteralPath $coreSrc -Destination $coreDst -Force
Write-Host "packaged daemon sidecar: $coreDst"
Write-Host "installer step (when wanted): cargo tauri build --bundles $Bundle"
