#!/usr/bin/env bash
# v2 renderer design-system guards. Rules, baselines and fixtures live beside
# this wrapper; --self-test proves every guard still fires on a bad fixture.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$repo_root/scripts/check-web-style.mjs" "$@"
