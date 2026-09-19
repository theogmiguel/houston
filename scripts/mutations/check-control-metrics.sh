#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT=scripts/mutations/fixtures/control bash "$root/scripts/check-control-metrics.sh" 2>&1 || true)"
grep -q 'fixtures/control/Bad.tsx' <<< "$out"
