#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"

pattern='type=["'"'"'](checkbox|radio)["'"'"']'

mapfile -t offenders < <(
  find "$ui_src" \( -name '*.tsx' -o -name '*.ts' \) \
    ! -name '*.test.tsx' ! -name '*.test.ts' -print0 \
    | xargs -0 -r grep -lE "$pattern" \
    | sort
)

fail=0
for f in "${offenders[@]}"; do
  stripped=$(sed -e 's://.*::' "$f" | perl -0777 -pe 's:/\*.*?\*/::gs')
  if printf '%s' "$stripped" | grep -qE "$pattern"; then
    if [ "$fail" -eq 0 ]; then
      echo "FAIL: native checkbox/radio in the renderer — its box is drawn by the OS theme, never ours." >&2
      echo "      Use Toggle for a binary and Segmented for a radio group (both in components/settingsPrimitives.tsx)." >&2
      fail=1
    fi
    printf '  %s\n' "$f" >&2
    printf '%s' "$stripped" | grep -nE "$pattern" | sed 's/^/      /' >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "check-native-input: OK — no native checkbox/radio in $ui_src"
