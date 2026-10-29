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

# The ladder's two text pairings: 15px at 1.6 beside 13px text, 13px at 1.7
# beside 11-12px text. A drift here re-inks every glyph in the app at once.
ladder_problems="$(perl -e '
  my $f = shift;
  open my $fh, "<", $f or exit 1;
  local $/ = undef;
  my $src = <$fh>;
  close $fh;
  my %want = (body => ["15px", "1.6"], ui => ["15px", "1.6"], small => ["13px", "1.7"], label => ["13px", "1.7"]);
  my (%size, %stroke);
  while ($src =~ /--tr-icon-([a-z]+)-size\s*:\s*([^;]+);/g) { $size{$1} = $2 }
  while ($src =~ /--tr-icon-([a-z]+)-stroke\s*:\s*([^;]+);/g) { $stroke{$1} = $2 }
  for my $role (sort keys %want) {
    my ($size_want, $stroke_want) = @{$want{$role}};
    my $size_got = $size{$role} // "missing";
    my $stroke_got = $stroke{$role} // "missing";
    print "--tr-icon-$role-size is \x27$size_got\x27; expected \x27$size_want\x27\n" unless $size_got eq $size_want;
    print "--tr-icon-$role-stroke is \x27$stroke_got\x27; expected \x27$stroke_want\x27\n" unless $stroke_got eq $stroke_want;
  }
' ui/src/renderer/src/theme.css)"

if [ -n "$ladder_problems" ]; then
  echo "FAIL: icon-metric ladder:" >&2
  while IFS= read -r problem; do
    [ -n "$problem" ] && echo "  $problem" >&2
  done <<< "$ladder_problems"
  exit 1
fi

echo "ok: no icon-metric violations"
