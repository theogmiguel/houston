#!/usr/bin/env bash
set -euo pipefail

# Guards the one thing that makes snapshot attach sound: the emulator the
# daemon owns and the engine the renderer paints with are the same library,
# built from the same revision with the same snapshot module.

cd "$(dirname "$0")/.."

LOCK="core/houston-core/ghostty-vt.lock"
SHIM="core/houston-core/ghostty-vt/houston_snapshot.zig"
WASM="ui/src/renderer/src/ghostty/vendor/ghostty-vt.wasm"
PATCHES="core/houston-core/ghostty-patches"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

for f in "$LOCK" "$SHIM" "$WASM"; do
  [ -f "$f" ] || fail "expected to find $f. If it moved, update scripts/check-ghostty-vt-pin.sh"
done
[ -d "$PATCHES" ] || fail "expected to find $PATCHES/"

lock_get() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"\(.*\)\"[[:space:]]*$/\1/p" "$LOCK"
}

revision="$(lock_get revision)"
version_string="$(lock_get lib_version_string)"
lock_format="$(lock_get snapshot_format_version)"
[ -n "$revision" ] || fail "$LOCK has no 'revision'"
[ -n "$version_string" ] || fail "$LOCK has no 'lib_version_string'"
[ -n "$lock_format" ] || fail "$LOCK has no 'snapshot_format_version'"

case "$version_string" in
  *"$revision") ;;
  *) fail "lib_version_string ($version_string) does not end in the pinned revision ($revision); the stamp in the artifacts would name a different build than the pin" ;;
esac

shim_format="$(grep -oP 'pub const FORMAT_VERSION: u32 = \K[0-9]+' "$SHIM" || true)"
[ -n "$shim_format" ] || fail "could not read FORMAT_VERSION from $SHIM (expected 'pub const FORMAT_VERSION: u32 = N;')"
[ "$shim_format" = "$lock_format" ] || fail "snapshot format version disagrees: $SHIM says $shim_format, $LOCK says $lock_format. Bump both together -- an importer refuses a version it does not equal, so a mismatch here is a pane that silently falls back to byte replay"

grep -qa -- "$version_string" "$WASM" || fail "$WASM does not contain the pinned version stamp '$version_string'. Rebuild it: scripts/build-ghostty-vt-wasm.sh"

for symbol in houston_vt_snapshot_format_version houston_vt_snapshot_parser_state \
              houston_vt_snapshot_encode houston_vt_snapshot_import; do
  grep -qa -- "$symbol" "$WASM" || fail "$WASM does not export $symbol. It was built without $PATCHES applied; rebuild it with scripts/build-ghostty-vt-wasm.sh"
done

checked_binary=0
for binary in core/target/debug/houston-core core/target/release/houston-core \
              src-tauri/binaries/houston-core-*; do
  [ -f "$binary" ] || continue
  checked_binary=1
  grep -qa -- "$revision" "$binary" || fail "$binary does not embed the pinned libghostty-vt revision $revision (vt::LIBRARY_REVISION). It was built against a different pin; rebuild it"
done

if [ "$checked_binary" = 0 ]; then
  echo "check-ghostty-vt-pin: lock, module and WASM agree on $revision (format v$lock_format); no built binary to check"
else
  echo "check-ghostty-vt-pin: lock, module, WASM and built binaries agree on $revision (format v$lock_format)"
fi
