#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
out="$(SCAN_ROOT="$root/scripts/mutations/fixtures/shadow" bash "$root/scripts/check-shadow-recipes.sh" 2>&1 || true)"
grep -q 'Bad.tsx' <<< "$out"
grep -q 'shadow-recipe violations' <<< "$out"
