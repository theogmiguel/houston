#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT=scripts/mutations/fixtures/ui-boundary bash "$root/scripts/check-ui-boundary.sh" 2>&1 || true)"
grep -q 'Bad.tsx:2.*bg-red-500.*layout only outside components/ui' <<< "$out"
