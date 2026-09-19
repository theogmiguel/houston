#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"

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
    while ($src =~ /shadow-\[([^\]]*)\]/g) {
      my $content = $1;
      # Strip every destination-shaped term: a var() whose fallback may
      # nest parens or an interpolation one level deep, then a bare
      # `${CONSTANT}` on its own, as a multi-shadow composite spells it.
      my $stripped = $content;
      1 while $stripped =~ s/var\(--[A-Za-z0-9-]+(?:,(?:[^()]|\([^()]*\)|\$\{[^}]*\})*)?\)//;
      $stripped =~ s/\$\{[^}]*\}//g;
      # What is left is punctuation the two shapes above are joined by --
      # commas and Tailwind'"'"'s underscore-for-space -- never recipe content.
      $stripped =~ s/[,_\s]//g;
      $n++ if length $stripped;
    }
    # The same recipe as an inline style object; two files exempt by name.
    # \x27 and \x60 stand in for quotes, which cannot appear literally
    # inside the single-quoted perl program this script wraps.
    unless ($f =~ m{components/(?:Sidebar|BrowserActConfirm)\.tsx$}) {
      while ($src =~ /boxShadow\s*:\s*[\x22\x27\x60]([^\x22\x27\x60]*)[\x22\x27\x60]/g) {
        my $stripped = $1;
        1 while $stripped =~ s/var\(--[A-Za-z0-9-]+(?:,(?:[^()]|\([^()]*\))*)?\)//;
        $stripped =~ s/\$\{[^}]*\}//g;
        $stripped =~ s/[,_\s]//g;
        $n++ if length $stripped;
      }
    }
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
  echo "FAIL: shadow-recipe violations:" >&2
  while IFS=$'\t' read -r n f; do
    [ -n "$f" ] && echo "  $f -- $n violation(s)" >&2
  done <<< "$counts"
  echo "      A violation is a shadow-[...] bracket content, or a boxShadow:" >&2
  echo "      style value, that is a hand-typed px length or colour. Use a" >&2
  echo "      token (shadow-[var(--x)])" >&2
  echo "      or a named constant from components/shadowChrome.ts" >&2
  echo "      (shadow-[\${RING_...}] / \${GLOW_...}), interpolated." >&2
  exit 1
fi

echo "ok: no shadow-recipe violations"
