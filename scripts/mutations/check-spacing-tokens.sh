#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT=scripts/mutations/fixtures/spacing bash "$root/scripts/check-spacing-tokens.sh" 2>&1 || true)"
grep -q 'mt-3' <<< "$out"
