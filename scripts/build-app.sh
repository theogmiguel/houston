#!/usr/bin/env bash
set -euo pipefail

# The one documented way to build the app. Anything that tells a human to run
# `cargo tauri build` directly is a documentation bug -- fix the doc, not this.

cd "$(dirname "$0")/.."

BUNDLES="appimage,deb"
VERBOSE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bundles)
      [ $# -ge 2 ] || { echo "--bundles requires a value, e.g. --bundles deb" >&2; exit 1; }
      BUNDLES="$2"; shift 2 ;;
    --bundles=*) BUNDLES="${1#*=}"; shift ;;
    --verbose) VERBOSE=1; shift ;;
    *)
      echo "unknown flag: '$1'. Accepted: --bundles <list>, --verbose" >&2
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
  [ "$VERBOSE" = "1" ] && shield_args+=(--verbose)
  exec ./scripts/oom-shield.sh "${shield_args[@]}"
fi

echo "[build-app] bundling ($BUNDLES)…"
tauri_args=(build --bundles "$BUNDLES")
[ "$VERBOSE" = "1" ] && tauri_args+=(--verbose)
CARGO_BUILD_JOBS=3 cargo tauri "${tauri_args[@]}"

echo "[build-app] done. Artifacts:"
find src-tauri/target/release/bundle -maxdepth 2 -type f \
  \( -name '*.AppImage' -o -name '*.deb' \) -printf '  %p (%s bytes)\n'
