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
    (my $code = $src) =~ s{/\*.*?\*/}{}gs;
    $code =~ s{//[^\n]*}{}g;
    my $n = 0;
    for my $re ("`([^`]*)`", "\"([^\"\\n]*)\"", "'"'"'([^'"'"'\\n]*)'"'"'") {
      while ($code =~ /$re/gs) {
        my $content = $1;
        next unless $content =~ /\boutline-none\b/;
        my $paint = qr/(shadow-|ring-|ring\b|border(?:-|\b)|bg-|outline(?!-none\b))/;
        my $ok = $content =~ /focus-visible:\[?$paint/
              || $content =~ /focus-visible:after:$paint/
              || $content =~ /:focus-visible\]:$paint/;
        $n++ unless $ok;
      }
    }
    print "$n\t$f\n" if $n > 0;
  }
' "${sources[@]}")"

fail=0
while IFS=$'\t' read -r n f; do
  [ -z "$f" ] && continue
  echo "FAIL: focus-visible $f has $n outline-none site(s) with no focus-visible paint; expected a visible focus-visible state" >&2
  fail=1
done <<< "$counts"

if [ "$fail" -ne 0 ]; then
  echo "      A violation is a class string containing outline-none (any" >&2
  echo "      variant) with no focus-visible: declaration that paints" >&2
  echo "      something (shadow-, ring-, border, bg-, or a real outline)." >&2
  echo "      Give the control a visible focus state -- FOCUS_HALO in" >&2
  echo "      components/ui/shadowChrome.ts for a rounded or capsule control." >&2
  exit 1
fi

echo "ok: no focus-visible violations"
