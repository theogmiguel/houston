#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT="$root/scripts/mutations/fixtures/focus" bash "$root/scripts/check-focus-visible.sh" 2>&1 || true)"
grep -q 'Bad.tsx has 1 focus class(es) with an interpolated arbitrary value' <<< "$out"
