#!/usr/bin/env bash

set -euo pipefail

# A page column has one width. A per-page max-width makes two pages disagree
# about where their content ends, so every page root asks for --page-w instead.
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

src="${SCAN_ROOT:-ui/src/renderer/src}"
mapfile -t files < <(
  find "$src/components/nav" "$src/components/prs" -type f -name '*.tsx' -not -name '*.test.tsx' 2>/dev/null
  printf '%s\n' "$src/components/UsageSection.tsx" "$src/components/ui/PrPage.tsx"
)
existing=()
for file in "${files[@]}"; do [ -f "$file" ] && existing+=("$file"); done

hits="$(grep -nE 'max-w-\[[^]]+\]|max-width:[[:space:]]*[0-9]' "${existing[@]}" | grep -v 'max-w-\[var(--page-w)\]' || true)"
if [ -n "$hits" ]; then
  echo "check-page-width: a page root carries its own max width; expected max-w-[var(--page-w)] (--page-w in theme.css):" >&2
  printf '%s\n' "$hits" | sed 's/^/  /' >&2
  exit 1
fi

echo "check-page-width: ok"
