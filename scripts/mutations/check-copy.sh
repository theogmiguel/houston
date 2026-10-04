#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
for fixture in title-case placeholder-case count banned-status; do
  out="$(SCAN_ROOT="scripts/mutations/fixtures/copy/$fixture" bash "$root/scripts/check-copy.sh" 2>&1 || true)"
  grep -q "copy-.*$fixture" <<< "$out"
done
