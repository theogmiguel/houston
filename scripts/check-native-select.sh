#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"
select_owner="ui/src/renderer/src/components/Select.tsx"

mapfile -t offenders < <(
  find "$ui_src" \( -name '*.tsx' -o -name '*.ts' \) \
    ! -name '*.test.tsx' ! -name '*.test.ts' -print0 \
    | xargs -0 -r grep -lE '<select[[:space:]/>]' \
    | grep -vF "$select_owner" \
    | sort
)

fail=0
for f in "${offenders[@]}"; do
  stripped=$(sed -e 's://.*::' "$f" | perl -0777 -pe 's:/\*.*?\*/::gs')
  if printf '%s' "$stripped" | grep -qE '<select[[:space:]/>]'; then
    if [ "$fail" -eq 0 ]; then
      echo "FAIL: native <select> in the renderer — its open popup is a GTK window, not page content." >&2
      echo "      Use <Select> from components/Select.tsx (it composes the same SELECT_CLS chrome)." >&2
      fail=1
    fi
    printf '  %s\n' "$f" >&2
    printf '%s' "$stripped" | grep -nE '<select[[:space:]/>]' | sed 's/^/      /' >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-native-select: OK — no native <select> outside $select_owner"
