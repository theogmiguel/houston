#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT=scripts/mutations/fixtures/radius bash "$root/scripts/check-radius-tokens.sh" 2>&1 || true)"
grep -q 'rounded-\[7px\]' <<< "$out"
