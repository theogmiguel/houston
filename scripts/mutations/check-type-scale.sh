#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT=scripts/mutations/fixtures/typescale bash "$root/scripts/check-type-scale.sh" 2>&1 || true)"
grep -q 'fixtures/typescale/Bad.tsx' <<< "$out"
