#!/usr/bin/env bash

# Why it fails CLOSED on mtime: git does not preserve mtimes, so a fresh clone
# or branch switch can make a source look newer than a current binary. A false
# alarm costs one cheap rebuild; a silent stale install costs a ghost bug.

set -euo pipefail
cd "$(dirname "$0")/.."

BIN="src-tauri/target/release/houston"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[ -f "$BIN" ] || fail "the app binary does not exist at $BIN. Build it: ./scripts/build-app.sh"

mapfile -t ROOTS < <(printf '%s\n' \
  core/houston-core/src core/houston-protocol/src src-tauri/src \
  core/Cargo.toml src-tauri/Cargo.toml src-tauri/tauri.conf.json \
  core/Cargo.lock src-tauri/Cargo.lock)

present=()
for r in "${ROOTS[@]}"; do
  [ -e "$r" ] && present+=("$r")
done

[ ${#present[@]} -gt 0 ] || fail "none of the watched Rust source paths exist (${ROOTS[*]}). They must have moved -- update scripts/check-binary-fresh.sh rather than letting it pass while watching nothing."

newer=$(find "${present[@]}" \
  \( -name target -type d -prune \) -o \
  -type f -newer "$BIN" -print -quit)

if [ -n "$newer" ]; then
  src_time=$(date -r "$newer" '+%Y-%m-%d %H:%M:%S')
  bin_time=$(date -r "$BIN" '+%Y-%m-%d %H:%M:%S')
  fail "the app binary is stale against the Rust sources.
  $newer
      modified $src_time
  $BIN
      built    $bin_time
Installing now would copy a binary that predates that change into
~/.local/lib/houston/, and the installed app would behave as if the edit
had never happened. Rebuild first:
  ./scripts/build-app.sh
(If you are certain the binary is current and this is an mtime artifact of a
clone, branch switch or stash pop, rebuilding is still the correct and cheapest
way to clear it -- see this script's header on why it fails closed.)"
fi

echo "ok: $BIN is newer than every watched Rust source"
