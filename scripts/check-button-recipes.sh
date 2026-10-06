#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"
chrome_owner="ui/src/renderer/src/components/ui/buttonChrome.ts"

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

report="$(perl -e '
  my $owner = shift @ARGV;
  # Overlays on `.btn`, so a call site must spell the literal class too.
  # The other recipes are self-sufficient or a deliberate partial piece.
  my @overlay_names = qw(BTN_PRIMARY BTN_DANGER_SOLID BTN_GHOST BTN_GHOST_DANGER_HOVER BTN_GHOST_DANGER_ARM);
  my $overlay_re = join("|", @overlay_names);

  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;

    # Rule 1: only buttonChrome.ts may declare a BTN_* constant.
    if ($f ne $owner) {
      while ($src =~ /^\s*(?:export\s+)?const\s+(BTN_[A-Z0-9_]*)\s*=/mg) {
        print "shadow\t$f\t$1\n";
      }
    }

    # Rule 2: a template literal using one of the overlay constants must
    # also carry the literal `btn` class somewhere in the same literal.
    while ($src =~ /`([^`]*)`/gs) {
      my $lit = $1;
      next unless $lit =~ /\$\{($overlay_re)\}/;
      next if $lit =~ /\bbtn\b/;
      my $const = $1;
      print "bare\t$f\t$const\n";
    }
  }
' "$chrome_owner" "${sources[@]}")"

fail=0
while IFS=$'\t' read -r kind file name; do
  [ -z "$kind" ] && continue
  case "$kind" in
    shadow) echo "FAIL: button-recipe $file declares $name; expected shared recipes from components/ui/buttonChrome.ts" >&2 ;;
    bare) echo "FAIL: button-recipe $file uses overlay constant $name without 'btn'; expected the base class in the same class string" >&2 ;;
  esac
  fail=1
done <<< "$report"
[ "$fail" -eq 0 ] && echo "ok: no button-recipe violations"
exit "$fail"
