#!/usr/bin/env bash

# Reads the three version manifests, refuses an empty or disagreeing set, and
# prints the agreed version. With an argument, also refuses a manifest that
# does not match it (the tag a resumed cut rebuilds).

set -euo pipefail

cd "$(dirname "$0")/.."

desktop=$(jq -r .version apps/desktop/package.json)
server=$(jq -r .version apps/server/package.json)
web=$(jq -r .version apps/web/package.json)

echo "apps/desktop/package.json=$desktop  apps/server/package.json=$server  apps/web/package.json=$web" >&2
if [ -z "$desktop" ] || [ -z "$server" ] || [ -z "$web" ]; then
  echo "FAIL: a manifest version came back empty -- expected a semver string in each of the three (got apps/desktop/package.json='$desktop' apps/server/package.json='$server' apps/web/package.json='$web')" >&2
  exit 1
fi
if [ "$desktop" != "$server" ] || [ "$desktop" != "$web" ]; then
  echo "FAIL: version mismatch across the three manifests (apps/desktop/package.json=$desktop apps/server/package.json=$server apps/web/package.json=$web) -- they must agree before a release" >&2
  exit 1
fi
if [ -n "${1:-}" ] && [ "$desktop" != "$1" ]; then
  echo "FAIL: the checked-out tree carries version $desktop but $1 was expected; a resumed cut must check out the release commit its tag names" >&2
  exit 1
fi

echo "$desktop"
