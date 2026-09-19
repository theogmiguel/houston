#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

icons_file="ui/src/renderer/src/components/icons.tsx"

total="$(grep -oE '^export function Icon\w+\(' "$icons_file" | grep -cv 'Tight(')"

mapfile -t pairs < <(sed -n '/^export const TIGHT_ICON_MAP/,/^])/p' "$icons_file" \
  | grep -oE '\[Icon\w+, *Icon\w+\]')

echo "icon tight-cut coverage: ${#pairs[@]} of ${total} glyphs have a label/small/ui drawing"
echo
for p in "${pairs[@]}"; do
  echo "  $p"
done
echo
echo "everything else falls back to its standard drawing at every rung, by design."
