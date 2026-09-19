#!/usr/bin/env bash

set -uo pipefail

# CI is the wrong place to catch this alone: raising a pin is the smallest diff
# that turns a red gate green, so it is what an agent reaches for. Here the
# refusal lands while the edit is still in front of it.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$file" ] || exit 0

case "$file" in
  */scripts/check-radius-tokens.sh|scripts/check-radius-tokens.sh) ;;
  */scripts/check-control-metrics.sh|scripts/check-control-metrics.sh) ;;
  */scripts/check-spacing-tokens.sh|scripts/check-spacing-tokens.sh) ;;
  */scripts/check-focus-visible.sh|scripts/check-focus-visible.sh) ;;
  */ui/complexity-baseline.json|ui/complexity-baseline.json) ;;
  *) exit 0 ;;
esac

out="$(bash "$repo_root/scripts/check-ratchets-only-tighten.sh" 2>&1)" && exit 0
printf '%s\n' "$out" >&2
exit 2
