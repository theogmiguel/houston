#!/usr/bin/env bash

# clippy.toml is referenced by no Cargo.toml, so deleting it or dropping an
# entry silently disables the spawn-window lint with a green build. This script
# exists only to check those files still name both Command::new paths.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0

for ws in core src-tauri; do
  conf="$ws/clippy.toml"
  if [ ! -f "$conf" ]; then
    echo "FAIL: $conf is missing." >&2
    echo "      Without it clippy enforces nothing and the build still passes" >&2
    echo "      green -- see this script's header. Restore it from the other" >&2
    echo "      workspace's copy (they are identical by design)." >&2
    fail=1
    continue
  fi
  missing=""
  for path in 'std::process::Command::new' 'tokio::process::Command::new'; do
    grep -qF "\"$path\"" "$conf" || missing="$missing $path"
  done
  if [ -n "$missing" ]; then
    echo "FAIL: $conf no longer disallows:$missing" >&2
    echo "      Every production spawn must route through" >&2
    echo "      houston_core::spawn so the child gets CREATE_NO_WINDOW on" >&2
    echo "      Windows. Re-add the entry rather than deleting it; test code" >&2
    echo "      opts out with #![allow(clippy::disallowed_methods)] instead." >&2
    fail=1
  else
    echo "ok: $conf disallows both bare Command::new paths"
  fi
done

spawn_rs="core/houston-core/src/spawn.rs"
if [ ! -f "$spawn_rs" ]; then
  echo "FAIL: $spawn_rs is missing -- clippy.toml's reason strings name it as" >&2
  echo "      the one place a child's window policy is applied." >&2
  fail=1
elif ! grep -qF 'creation_flags(CREATE_NO_WINDOW)' "$spawn_rs"; then
  echo "FAIL: $spawn_rs no longer calls creation_flags(CREATE_NO_WINDOW)." >&2
  echo "      Every call site routes through it precisely so this one line" >&2
  echo "      exists; without it the console windows come back." >&2
  fail=1
else
  echo "ok: $spawn_rs still applies CREATE_NO_WINDOW"
fi

if grep -rn 'CREATE_NO_WINDOW' core/ src-tauri/ --include='*.rs' \
  | grep -v "^$spawn_rs:" \
  | grep -qi 'commandbuilder'; then
  echo "FAIL: CREATE_NO_WINDOW was applied to a portable_pty::CommandBuilder." >&2
  echo "      A pane's child NEEDS its pseudoconsole -- that window is the" >&2
  echo "      terminal. See spawn.rs's 'Why this is not the ConPTY path'." >&2
  fail=1
else
  echo "ok: the ConPTY/CommandBuilder path is left alone, as intended"
fi

exit "$fail"
