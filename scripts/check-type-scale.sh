#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ -n "${SCAN_ROOT:-}" ]; then
  scan_roots=("$SCAN_ROOT")
else
  scan_roots=(ui/src/renderer/src/components/ui ui/src/renderer/src/theme.css ui/src/renderer/src/tailwind.css ui/src/renderer/src/keyframes.css ui/src/renderer/src/base.css)
fi

mapfile -t sources < <(find "${scan_roots[@]}" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

reports="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my @old;
    while ($src =~ /text-\[([0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt))\]/g) { push @old, [pos($src), "text-[$1]"]; }
    while ($src =~ /(?<![\w-])text-(?:xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g) { push @old, [pos($src), $&]; }
    for my $hit (@old) {
      my $line = 1 + (substr($src, 0, $hit->[0]) =~ tr/\n//);
      print "OLD\t$f\t$line\t$hit->[1]\n";
    }
    my @wide;
    while ($src =~ /\[font-size\s*:\s*([0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt))\]/g) { push @wide, [pos($src), "[font-size:$1]"]; }
    if ($f =~ /\.css$/ && $f !~ m{/(?:theme|tailwind)\.css$}) {
      while ($src =~ /(?:^|[;{]\s*|\n\s*)font-size\s*:\s*([0-9]+(?:\.[0-9]+)?(?:px|rem|em|pt))\b/mg) { push @wide, [pos($src), "font-size: $1"]; }
    }
    for my $hit (@wide) {
      my $line = 1 + (substr($src, 0, $hit->[0]) =~ tr/\n//);
      print "WIDE\t$f\t$line\t$hit->[1]\n";
      if ($hit->[1] =~ /([0-9]+(?:\.[0-9]+)?)px/) {
        print "FLOOR\t$f\t$line\t$hit->[1]\n" if $1 < 11;
      }
    }
    for my $hit (@old) {
      if ($hit->[1] =~ /([0-9]+(?:\.[0-9]+)?)px/ && $1 < 11) {
        my $line = 1 + (substr($src, 0, $hit->[0]) =~ tr/\n//);
        print "FLOOR\t$f\t$line\t$hit->[1]\n";
      }
    }
  }
' "${sources[@]}")"

fail=0
while IFS=$'\t' read -r kind file line value; do
  [ -n "$kind" ] || continue
  case "$kind" in
    OLD) expected="one of the eight --tr-text-<step> tokens" ;;
    WIDE) expected="a type token instead of a literal font size" ;;
    FLOOR) expected="a type token or a size of at least 11px" ;;
  esac
  echo "FAIL: type-scale $file:$line '$value'; expected $expected" >&2
  fail=1
done <<< "$reports"
[ "$fail" -eq 0 ] && echo "ok: type-scale passes"
exit "$fail"
