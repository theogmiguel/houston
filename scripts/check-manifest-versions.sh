#!/usr/bin/env bash

# Reads the four version manifests, refuses an empty or disagreeing set, and
# prints the agreed version. With an argument, also refuses a manifest that
# does not match it (the tag a resumed cut rebuilds).

set -euo pipefail

cd "$(dirname "$0")/.."

conf=$(jq -r .version src-tauri/tauri.conf.json)
crate=$(sed -n '0,/^version = /s/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml)
ui=$(jq -r .version ui/package.json)
# Scoped to the [workspace.package] table: core/Cargo.toml also carries
# `version = ` lines under [workspace.dependencies], and an unscoped
# first-match read picks up whichever comes first.
core=$(awk '/^\[workspace\.package\]/{f=1;next} /^\[/{f=0} f && /^version = /{gsub(/^version = "|"$/,""); print; exit}' core/Cargo.toml)

echo "tauri.conf.json=$conf  src-tauri/Cargo.toml=$crate  ui/package.json=$ui  core/Cargo.toml=$core" >&2
if [ -z "$conf" ] || [ -z "$crate" ] || [ -z "$ui" ] || [ -z "$core" ]; then
  echo "FAIL: a manifest version came back empty -- expected a semver string in each of the four (got tauri.conf.json='$conf' src-tauri/Cargo.toml='$crate' ui/package.json='$ui' core/Cargo.toml='$core')" >&2
  exit 1
fi
if [ "$conf" != "$crate" ] || [ "$conf" != "$ui" ] || [ "$conf" != "$core" ]; then
  echo "FAIL: version mismatch across the four manifests (tauri.conf.json=$conf src-tauri/Cargo.toml=$crate ui/package.json=$ui core/Cargo.toml=$core) -- they must agree before a release" >&2
  exit 1
fi
if [ -n "${1:-}" ] && [ "$conf" != "$1" ]; then
  echo "FAIL: the checked-out tree carries version $conf but $1 was expected; a resumed cut must check out the release commit its tag names" >&2
  exit 1
fi

echo "$conf"
