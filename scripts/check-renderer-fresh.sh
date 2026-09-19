#!/usr/bin/env bash

# Freshness is an mtime comparison, a proxy and not proof. git reorders mtimes
# on clone or checkout, so this fails CLOSED; the remedy it prints (rebuild)
# clears a false alarm as surely as a real one. Do not weaken it to a warning.

set -euo pipefail
cd "$(dirname "$0")/.."

TS_SRC="ui/src/renderer/src/houston/generated/PROTOCOL_VERSION.ts"
RUST_SRC="core/houston-protocol/src/lib.rs"
BUILT="ui/out/renderer"
INDEX="$BUILT/index.html"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$TS_SRC" ] || fail "expected $TS_SRC (the generated renderer-side PROTOCOL_VERSION); it does not exist. If it moved, update scripts/check-renderer-fresh.sh"
[ -f "$RUST_SRC" ] || fail "expected $RUST_SRC (the daemon-side PROTOCOL_VERSION); it does not exist. If it moved, update scripts/check-renderer-fresh.sh"

[ -d "$BUILT" ] || fail "the renderer has not been built: $BUILT does not exist. tauri.conf.json's frontendDist points at it, so a bundle built now would have no frontend at all. Run: (cd ui && bun run build)"
[ -f "$INDEX" ] || fail "$BUILT exists but has no index.html, so it is not a usable frontendDist. Rebuild it: (cd ui && bun run build)"

rust_version=$(grep -oP 'pub const PROTOCOL_VERSION: u32 = \K[0-9]+' "$RUST_SRC" || true)
ts_version=$(grep -oP 'export const PROTOCOL_VERSION = \K[0-9]+' "$TS_SRC" || true)

[ -n "$rust_version" ] || fail "could not read PROTOCOL_VERSION from $RUST_SRC (expected a line like 'pub const PROTOCOL_VERSION: u32 = 39;')"
[ -n "$ts_version" ] || fail "could not read PROTOCOL_VERSION from $TS_SRC (expected a line like 'export const PROTOCOL_VERSION = 39')"

if [ "$rust_version" != "$ts_version" ]; then
  fail "daemon and renderer sources disagree on the wire protocol before anything was even built: $RUST_SRC says $rust_version, $TS_SRC says $ts_version. Regenerate the TS side (scripts/gen-protocol-types.sh) -- it is generated, not hand-edited."
fi

if [ "$TS_SRC" -nt "$INDEX" ]; then
  ts_time=$(date -r "$TS_SRC" '+%Y-%m-%d %H:%M:%S')
  built_time=$(date -r "$INDEX" '+%Y-%m-%d %H:%M:%S')
  fail "the built renderer is older than the protocol it must speak: $TS_SRC (protocol $ts_version) was modified $ts_time, but $INDEX was built $built_time. Bundling now would embed a renderer that predates the current wire version. Rebuild it: (cd ui && bun run build)"
fi

if [ "$RUST_SRC" -nt "$INDEX" ]; then
  rust_time=$(date -r "$RUST_SRC" '+%Y-%m-%d %H:%M:%S')
  built_time=$(date -r "$INDEX" '+%Y-%m-%d %H:%M:%S')
  fail "the daemon's protocol source is newer than the built renderer: $RUST_SRC was modified $rust_time, $INDEX was built $built_time. Even at matching version numbers the built renderer may predate a same-version wire change. Rebuild it: (cd ui && bun run build)"
fi

echo "ok: built renderer at $BUILT is current for protocol v$rust_version"
