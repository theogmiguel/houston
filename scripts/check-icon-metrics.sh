#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' \
  -not -path '*/components/icons.tsx' | sort)

counts="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my $n = 0;
    # A JSX tag whose name marks it a glyph, including the variable a
    # Record lookup binds one to. Attributes may nest braces one level.
    while ($src =~ /<(?:Icon[A-Z]\w*|Icon|Glyph|FilledMark|FileTreeIcon|\w+\.Icon)\b((?:[^<>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?)\/?>/gs) {
      my $tag = $&;
      next if $tag =~ /^<IconTile\b/;
      my $attrs = $1;
      $n++ if $attrs =~ /(?<![\w-])size=/;
      $n++ if $attrs =~ /(?<![\w-])strokeWidth=/;
    }
    # A props object spread onto a glyph is the same violation one hop away:
    # `const HEAD_ICON = { size: 13, strokeWidth: 1.75 }`.
    $n++ while $src =~ /\{\s*(?:size|strokeWidth)\s*:\s*[0-9.]+\s*[,}]/g;
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
  echo "FAIL: icon-metric violations:" >&2
  while IFS=$'\t' read -r n f; do
    [ -n "$f" ] && echo "  $f -- $n violation(s)" >&2
  done <<< "$counts"
  echo "      A violation is a size= or strokeWidth= prop on a glyph, or a" >&2
  echo "      props object that spells one. Use the rung the neighbouring" >&2
  echo "      text sits on: <Icon glyph={IconFoo} role=\"ui\" />, or" >&2
  echo "      ICON_ROLE_CLS[role] as a class where wrapping breaks the DOM." >&2
  echo "      The eight rungs are STYLEGUIDE 'Icons' / --tr-icon-<rung>-*." >&2
  exit 1
fi

echo "ok: no icon-metric violations"
