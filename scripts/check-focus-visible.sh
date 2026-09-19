#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"

EXEMPT_COUNTS=(
  "ui/src/renderer/src/components/agents/SelectMenu.tsx 1"
  "ui/src/renderer/src/editor/editorChrome.ts 2"
  "ui/src/renderer/src/components/browserFullscreenChrome.ts 1"
  "ui/src/renderer/src/components/settings/AppearanceSection.tsx 1"
)

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
  exempt=0
  for entry in "${EXEMPT_COUNTS[@]}"; do
    path="${entry% *}"
    if [ "$path" = "$f" ]; then
      exempt="${entry##* }"
      break
    fi
  done
  if [ "$n" -gt "$exempt" ]; then
    echo "FAIL: $f -- $n outline-none site(s) with no focus-visible paint (exempt: $exempt)" >&2
    fail=1
  fi
done <<< "$counts"

if [ "$fail" -ne 0 ]; then
  echo "      A violation is a class string containing outline-none (any" >&2
  echo "      variant) with no focus-visible: declaration that paints" >&2
  echo "      something (shadow-, ring-, border, bg-, or a real outline)." >&2
  echo "      Give the control a visible focus state -- FOCUS_HALO in" >&2
  echo "      components/shadowChrome.ts for a rounded or capsule control." >&2
  exit 1
fi

echo "ok: no focus-visible violations"
