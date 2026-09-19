#!/usr/bin/env bash

set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
file="$(jq -r '.tool_input.file_path // empty' 2>/dev/null)"
[ -n "$file" ] || exit 0

case "$file" in
  *.rs|*.ts|*.tsx|*.css|*.sh|*.ps1|*.mjs|*.yml) ;;
  *) exit 0 ;;
esac
case "$file" in
  */generated/*|*/node_modules/*|*/ghostty/vendor/*) exit 0 ;;
esac

out="$(bash "$repo_root/scripts/check-comment-hygiene.sh" "$file" 2>&1)" && exit 0
printf '%s\n' "$out" >&2
exit 2
