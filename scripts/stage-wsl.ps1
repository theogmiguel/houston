$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# The installer carries the Linux daemon that WSL environments install into a distro;
# a release without it would fail every enable, so a missing source stops the build.
$wslSource = $env:HOUSTON_WSL_LINUX_BIN_DIR
if (-not $wslSource) {
    throw ("HOUSTON_WSL_LINUX_BIN_DIR is not set; expected a directory holding houston-core, " +
        "tr-helper and houston-supervisor built for x86_64-unknown-linux-gnu at this commit " +
        "(inside WSL: cd core && cargo build --release --bin houston-core --bin tr-helper " +
        "--bin houston-supervisor, then point it at core/target/release)")
}
$wslStage = Join-Path $Root 'src-tauri/wsl'
if (Test-Path -LiteralPath $wslStage) { Remove-Item -Recurse -Force -LiteralPath $wslStage }
New-Item -ItemType Directory -Force $wslStage | Out-Null
foreach ($name in @('houston-core', 'tr-helper', 'houston-supervisor')) {
    $source = Join-Path $wslSource $name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "HOUSTON_WSL_LINUX_BIN_DIR has no $name at $source; expected the x86_64 Linux build"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $wslStage $name) -Force
}
& "$env:ProgramFiles\Git\bin\bash.exe" -lc ('export LC_ALL=C.UTF-8 HOUSTON_WSL_BUNDLE_REQUIRED=1; cd "$(cygpath -u "' +
    ($Root -replace '\\','/') + '")"; bash scripts/check-wsl-bundle.sh')
if ($LASTEXITCODE -ne 0) { throw "scripts/check-wsl-bundle.sh failed with exit code $LASTEXITCODE" }

