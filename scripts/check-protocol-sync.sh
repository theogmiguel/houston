#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

RUST_SRC="core/houston-protocol/src/lib.rs"
TS_SRC="ui/src/renderer/src/houston/generated/PROTOCOL_VERSION.ts"
DOC_SRC="protocol/protocol.md"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

for f in "$RUST_SRC" "$TS_SRC" "$DOC_SRC"; do
  [ -f "$f" ] || fail "expected to find $f (a file carrying PROTOCOL_VERSION); it does not exist. If it moved, update scripts/check-protocol-sync.sh"
done

rust_version=$(grep -oP 'pub const PROTOCOL_VERSION: u32 = \K[0-9]+' "$RUST_SRC" || true)
ts_version=$(grep -oP 'export const PROTOCOL_VERSION = \K[0-9]+' "$TS_SRC" || true)
doc_version=$(grep -oP '^# Wire protocol v\K[0-9]+' "$DOC_SRC" || true)

[ -n "$rust_version" ] || fail "could not read PROTOCOL_VERSION from $RUST_SRC (expected a line like 'pub const PROTOCOL_VERSION: u32 = 35;')"
[ -n "$ts_version" ] || fail "could not read PROTOCOL_VERSION from $TS_SRC (expected a line like 'export const PROTOCOL_VERSION = 35')"
[ -n "$doc_version" ] || fail "could not read the version from $DOC_SRC (expected a first-line header like '# Wire protocol v35')"

if [ "$rust_version" != "$ts_version" ]; then
  fail "daemon and UI disagree on the wire protocol: $RUST_SRC says $rust_version, $TS_SRC says $ts_version. The TS file is ts-rs generated — regenerate it rather than editing it by hand. A daemon and a UI that disagree on this number cannot complete the hello handshake."
fi

if [ "$rust_version" != "$doc_version" ]; then
  fail "the protocol doc is stale: code says $rust_version, $DOC_SRC's header says v$doc_version. AGENTS.md requires protocol.md to be updated in the same commit as the bump."
fi

echo "ok: PROTOCOL_VERSION agrees across daemon, UI and doc (v$rust_version)"
