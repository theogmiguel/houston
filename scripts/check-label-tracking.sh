#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

WINDOW=4

fail=0
while IFS=: read -r file line _; do
  start=$(( line > WINDOW ? line - WINDOW : 1 ))
  end=$(( line + WINDOW ))
  if ! sed -n "${start},${end}p" "$file" | grep -qE 'tr-text-label-transform|uppercase'; then
    fail=1
    printf '%s:%s: tr-text-label-tracking without tr-text-label-transform/uppercase nearby\n' "$file" "$line"
    printf '  -> not a genuine uppercase head: move this run to the small step (--tr-text-small-size/-weight/-leading), no tracking\n'
  fi
done < <(git ls-files -co --exclude-standard -- 'ui/src/renderer/src/**/*.ts' 'ui/src/renderer/src/**/*.tsx' \
  | xargs -r grep -nE 'tr-text-label-tracking' -- 2>/dev/null || true)

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "check-label-tracking: ok"
