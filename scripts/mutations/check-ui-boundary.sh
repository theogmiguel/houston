#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT="$root/scripts/mutations/fixtures/ui-boundary" bash "$root/scripts/check-ui-boundary.sh" 2>&1 || true)"
grep -q 'Bad.tsx:2.*bg-red-500.*layout-only utilities outside components/ui' <<< "$out"
grep -q 'Hidden.tsx:2.*shadow-lg' <<< "$out"
grep -q 'Hidden.tsx:2.*bg-red-500' <<< "$out"
grep -q 'stylesheet .*feature.css' <<< "$out"
grep -q 'base stylesheet .*base.css:1.*widget' <<< "$out"
if grep -q 'primitive.css' <<< "$out"; then exit 1; fi
fixtures="$root/scripts/mutations/fixtures/ui-boundary"
pending() { SCAN_ROOT="$fixtures" UI_BOUNDARY_PENDING="$fixtures/Bad.tsx $1" bash "$root/scripts/check-ui-boundary.sh" 2>&1 || true; }
held="$(pending 1)"
if grep -q 'ui-boundary .*Bad.tsx' <<< "$held"; then exit 1; fi
grep -q 'PENDING allows 0 .*Bad.tsx, found 1' <<< "$(pending 0)"
grep -q 'PENDING allows 2 .*Bad.tsx, found 1; lower the entry to 1' <<< "$(pending 2)"
