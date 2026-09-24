#!/usr/bin/env bash
set -euo pipefail

# The one documented way to build the app. It exists so the build-time
# protocol gate cannot be forgotten: anything that tells a human to run
# `cargo tauri build` directly is a documentation bug -- fix the doc, not this.

cd "$(dirname "$0")/.."

BUNDLES="appimage,deb"
SKIP_RENDERER=0
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bundles)
      [ $# -ge 2 ] || { echo "--bundles requires a value, e.g. --bundles deb" >&2; exit 1; }
      BUNDLES="$2"; shift 2 ;;
    --bundles=*) BUNDLES="${1#*=}"; shift ;;
    --skip-renderer) SKIP_RENDERER=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    *)
      echo "unknown flag: '$1'. Accepted: --bundles <list>, --skip-renderer, --verbose" >&2
      exit 1 ;;
  esac
done

command -v cargo-tauri >/dev/null || {
  echo "the Tauri CLI is not installed. Install the pinned version:" >&2
  echo "  cargo install tauri-cli --version 2.11.4 --locked" >&2
  echo "(exact version, not a caret range)" >&2
  exit 1
}

if [ "${BUILD_APP_SHIELDED:-0}" != "1" ]; then
  export BUILD_APP_SHIELDED=1
  shield_args=("$0" --bundles "$BUNDLES")
  [ "$SKIP_RENDERER" = "1" ] && shield_args+=(--skip-renderer)
  [ "$VERBOSE" = "1" ] && shield_args+=(--verbose)
  exec ./scripts/oom-shield.sh "${shield_args[@]}"
fi

if [ "$SKIP_RENDERER" = "0" ]; then
  echo "[build-app] building the renderer…"
  (cd ui && bun run build)
fi

echo "[build-app] checking the built renderer against the wire protocol…"
./scripts/check-renderer-fresh.sh

# Whisper otherwise uses -march=native; shipped binaries must run off the build host.
export GGML_NATIVE=OFF GGML_SSE42=OFF GGML_AVX=OFF GGML_AVX2=OFF
export GGML_F16C=OFF GGML_FMA=OFF GGML_BMI2=OFF
# whisper-rs-sys does not track GGML_* changes in Cargo's build-script cache.
cargo clean --release --manifest-path core/Cargo.toml -p whisper-rs-sys
cargo clean --release --manifest-path src-tauri/Cargo.toml -p whisper-rs-sys

./scripts/stage-helper.sh --bin tr-helper --profile release
./scripts/stage-helper.sh --bin houston-core --profile release
./scripts/stage-helper.sh --bin houston-supervisor --profile release

echo "[build-app] checking the terminal emulator pin…"
./scripts/check-ghostty-vt-pin.sh

echo "[build-app] bundling ($BUNDLES)…"
tauri_args=(build --bundles "$BUNDLES")
[ "$VERBOSE" = "1" ] && tauri_args+=(--verbose)
CARGO_BUILD_JOBS=3 cargo tauri "${tauri_args[@]}"

cp core/target/release/tr-helper src-tauri/target/release/tr-helper
cp core/target/release/houston-core src-tauri/target/release/houston-core
cp core/target/release/houston-supervisor src-tauri/target/release/houston-supervisor

echo "[build-app] done. Artifacts:"
find src-tauri/target/release/bundle -maxdepth 2 -type f \
  \( -name '*.AppImage' -o -name '*.deb' \) -printf '  %p (%s bytes)\n'
