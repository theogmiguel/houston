#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT=scripts/mutations/fixtures/typescale bash "$root/scripts/check-type-scale.sh" 2>&1 || true)"
grep -q 'fixtures/typescale/Bad.tsx' <<< "$out"
grep -q '\[font-size:9px\]' <<< "$out"
grep -q 'font-size: 10px' <<< "$out"

out="$(SCAN_ROOT="$root/scripts/mutations/fixtures/typescale" bash "$root/scripts/check-type-scale.sh" 2>&1 || true)"
grep -q 'components/ui/Bad.tsx' <<< "$out"
