#!/usr/bin/env bash

# Reads the three version manifests, refuses an empty or disagreeing set, and
# prints the agreed version. With an argument, also refuses a manifest that
# does not match it (the tag a resumed cut rebuilds).

set -euo pipefail

cd "$(dirname "$0")/.."

conf=$(jq -r .version src-tauri/tauri.conf.json)
crate=$(sed -n '0,/^version = /s/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml)
server=$(jq -r .version apps/server/package.json)

echo "tauri.conf.json=$conf  src-tauri/Cargo.toml=$crate  apps/server/package.json=$server" >&2
if [ -z "$conf" ] || [ -z "$crate" ] || [ -z "$server" ]; then
  echo "FAIL: a manifest version came back empty -- expected a semver string in each of the three (got tauri.conf.json='$conf' src-tauri/Cargo.toml='$crate' apps/server/package.json='$server')" >&2
  exit 1
fi
if [ "$conf" != "$crate" ] || [ "$conf" != "$server" ]; then
  echo "FAIL: version mismatch across the three manifests (tauri.conf.json=$conf src-tauri/Cargo.toml=$crate apps/server/package.json=$server) -- they must agree before a release" >&2
  exit 1
fi
if [ -n "${1:-}" ] && [ "$conf" != "$1" ]; then
  echo "FAIL: the checked-out tree carries version $conf but $1 was expected; a resumed cut must check out the release commit its tag names" >&2
  exit 1
fi

echo "$conf"
