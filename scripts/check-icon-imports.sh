#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"
icons_owner="ui/src/renderer/src/components/icons.tsx"
fail=0

ALLOWLIST=(
)

mapfile -t offenders < <(
  grep -rlE "from[[:space:]]+['\"]lucide-react['\"]" "$ui_src" \
    --include='*.ts' --include='*.tsx' \
    | grep -v '\.test\.tsx\?$' \
    | grep -vF "$icons_owner" \
    | sort
)

new_offenders=()
for f in "${offenders[@]}"; do
  known=0
  for a in "${ALLOWLIST[@]}"; do
    if [ "$f" = "$a" ]; then
      known=1
      break
    fi
  done
  [ "$known" -eq 0 ] && new_offenders+=("$f")
done

if [ "${#new_offenders[@]}" -gt 0 ]; then
  echo "FAIL: raw 'lucide-react' import outside components/icons.tsx, not in the allowlist:" >&2
  for f in "${new_offenders[@]}"; do
    grep -nE "from[[:space:]]+['\"]lucide-react['\"]" "$f" | while IFS=: read -r line _; do
      echo "  $f:$line" >&2
    done
  done
  echo "      Route the icon through components/icons.tsx (icons-02, charter §12)." >&2
  echo "      If this really is a legitimate new vocabulary file, that is a design" >&2
  echo "      decision for docs/internals/invariants.md, not a line added to this script's" >&2
  echo "      allowlist." >&2
  fail=1
else
  echo "ok: no new raw lucide-react imports outside the allowlist/components/icons.tsx"
fi

stale=()
for a in "${ALLOWLIST[@]}"; do
  if [ ! -f "$a" ] || ! grep -qE "from[[:space:]]+['\"]lucide-react['\"]" "$a"; then
    stale+=("$a")
  fi
done
if [ "${#stale[@]}" -gt 0 ]; then
  echo "FAIL: allowlist entry no longer imports lucide-react (or no longer exists) -- remove it:" >&2
  for a in "${stale[@]}"; do
    echo "  $a" >&2
  done
  fail=1
else
  echo "ok: every allowlist entry still needs its migration"
fi

exit "$fail"
