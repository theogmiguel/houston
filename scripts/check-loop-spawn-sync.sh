#!/usr/bin/env bash

# WHY STILL JUST GREP: a bash lexer cannot police Rust, and hand-lexing was
# tried and abandoned. The app's daemon_host.rs must NOT call
# spawn_background_loops -- a positive match there is the regression to catch.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

helper_file="core/houston-core/src/boot.rs"
helper="spawn_background_loops"
standalone="core/houston-core/src/main.rs"
app_host="src-tauri/src/daemon_host.rs"

for f in "$helper_file" "$standalone" "$app_host"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f does not exist -- this guard cannot check what it cannot find." >&2
    echo "      If the helper or a host moved, update this script; do not" >&2
    echo "      delete the check." >&2
    exit 1
  fi
done

if ! grep -qF "pub fn $helper" "$helper_file"; then
  echo "FAIL: $helper_file no longer declares 'pub fn $helper'." >&2
  echo "      That function IS the rule: one spawn list, one caller. If it" >&2
  echo "      was renamed, rename it here too." >&2
  exit 1
fi

fail=0

if ! grep -qF "$helper(" "$standalone"; then
  echo "FAIL: $standalone does not call $helper." >&2
  echo "      This is the daemon's own entry point -- without this call its" >&2
  echo "      whole background-loop set (including swarm_mail_loop, which" >&2
  echo "      hook drop files, plan-event ingest and GC all depend on) never" >&2
  echo "      runs at all." >&2
  fail=1
fi

if grep -qF "$helper(" "$app_host"; then
  echo "FAIL: $app_host calls $helper -- the app is hosting a daemon" >&2
  echo "      in-process again. Detach (D2/D10) made the daemon a separate" >&2
  echo "      process the app connects to or spawns detached; a second" >&2
  echo "      in-process caller of this helper means two daemons can end up" >&2
  echo "      on one state dir (AGENTS.md, danger #3)." >&2
  fail=1
fi

if [ "$fail" = "0" ]; then
  echo "ok: $standalone is the one caller of $helper; $app_host is not"
fi

exit "$fail"
