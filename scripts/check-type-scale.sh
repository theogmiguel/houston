#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

counts="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my $n = 0;
    $n++ while $src =~ /text-\[[0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt)\]/g;
    # The utility scale, as a whole word: `text-sm` counts, `text-small-size`
    # and `data-text-xs` do not.
    $n++ while $src =~ /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;
    print "$n\t$f\n" if $n > 0;
  }
' "${sources[@]}")"

if [ "${1:-}" = "--baseline" ]; then
  if [ -z "$counts" ]; then
    echo "ok: nothing to pin, the guard has no exceptions"
  else
    echo "$counts"
  fi
  exit 0
fi

if [ -n "$counts" ]; then
  echo "FAIL: type-scale violations:" >&2
  while IFS=$'\t' read -r n f; do
    [ -n "$f" ] && echo "  $f -- $n violation(s)" >&2
  done <<< "$counts"
  echo "      A violation is a bare text-[Npx]/[Nrem]/[Nem] size literal, or a" >&2
  echo "      raw text-xs/sm/base utility. Use one of the eight steps in" >&2
  echo "      STYLEGUIDE 'Type' (--tr-text-<step>-size, --tr-text-<step>-weight)." >&2
  exit 1
fi

echo "ok: no type-scale violations"
