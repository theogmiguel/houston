#!/usr/bin/env bash
set -euo pipefail

# Tauri looks for `<externalBin>-<target triple>` relative to src-tauri and
# strips the triple when installing beside the app. Each file must exist before
# cargo touches src-tauri: the build script validates every entry and refuses.

cd "$(dirname "$0")/.."

PROFILE="debug"
BIN_NAME="tr-helper"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || { echo "--profile requires a value: debug or release" >&2; exit 1; }
      PROFILE="$2"; shift 2 ;;
    --profile=*) PROFILE="${1#*=}"; shift ;;
    --bin)
      [ $# -ge 2 ] || { echo "--bin requires a value" >&2; exit 1; }
      BIN_NAME="$2"; shift 2 ;;
    --bin=*) BIN_NAME="${1#*=}"; shift ;;
    *)
      echo "unknown flag: '$1'. Accepted: --bin <name>, --profile <debug|release>" >&2
      exit 1 ;;
  esac
done

case "$PROFILE" in
  debug) CARGO_PROFILE_FLAG="" ;;
  release) CARGO_PROFILE_FLAG="--release" ;;
  *)
    echo "unknown profile: '$PROFILE'. Accepted: debug, release" >&2
    exit 1 ;;
esac

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
[ -n "$HOST_TRIPLE" ] || { echo "could not read the host target triple from 'rustc -vV'" >&2; exit 1; }

case "$HOST_TRIPLE" in
  *windows*) EXE=".exe" ;;
  *) EXE="" ;;
esac

if [ "$BIN_NAME" = "houston-supervisor" ] && [ "$EXE" = ".exe" ]; then
  echo "refusing to stage houston-supervisor for $HOST_TRIPLE: the supervisor is \
Linux-only (Windows spawns houston-core directly, see \
docs/internals/daemon.md's 'Supervisor' section)." >&2
  exit 1
fi

CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-3}" \
  cargo build $CARGO_PROFILE_FLAG --manifest-path core/Cargo.toml --bin "$BIN_NAME"

BUILT="core/target/$PROFILE/$BIN_NAME$EXE"
[ -f "$BUILT" ] || { echo "cargo reported success but '$BUILT' does not exist" >&2; exit 1; }

mkdir -p src-tauri/binaries
STAGED="src-tauri/binaries/$BIN_NAME-$HOST_TRIPLE$EXE"
cp "$BUILT" "$STAGED"
echo "[stage-helper] staged sidecar: $STAGED ($PROFILE)"
