#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(cd "$root/ui" && SCAN_ROOT="$root/scripts/mutations/fixtures/complexity" node scripts/check-complexity.mjs 2>&1 || true)"
if ! grep -q 'fixtures/complexity/Bad.tsx' <<< "$out" || ! grep -q 'not in the baseline' <<< "$out"; then
  echo "check-complexity did not refuse the fixture by path. Its output was:" >&2
  sed 's/^/  /' <<< "$out" >&2
  exit 1
fi
