#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ -n "${SCAN_ROOT:-}" ]; then
  scan_roots=("$SCAN_ROOT")
else
  scan_roots=(ui/src/renderer/src/components/ui ui/src/renderer/src/theme.css ui/src/renderer/src/tailwind.css ui/src/renderer/src/keyframes.css ui/src/renderer/src/base.css)
fi
fail=0


mapfile -t sources < <(find "${scan_roots[@]}" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

reports="$(perl -e '
  my $LENGTH = qr/(?<![\w.-])((?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)(?:px|rem|em|pt))\b/;
  my $CSS = qr/(?:^|[;{]\s*|\n\s*)(padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap)\s*:\s*[^;{}]*?$LENGTH/m;
  my $ARBITRARY = qr/(\[&[^\]]*\]:)?\[(padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|gap|row-gap|column-gap)\s*:\s*[^\]]*?$LENGTH[^\]]*\]/;
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my @old;
    while ($src =~ /(\[&[^\]]*\]:)?(?<![\w-])(-?)(?:mt|mr|mb|ml)-(\[[^\]]+\]|[\w.]+)/g) {
      my ($variant, $sign, $value) = ($1 // "", $2, $3);
      next if $variant =~ /^\[&_/;            # 4. prose we did not author
      next if $value eq "auto";               # 1. alignment
      next if $sign eq "-" || $value =~ /^\[-/;  # 3. a pull, not a gap
      next if $value =~ /^(?:0|\[0(?:px|rem|em)?\])$/;  # 2. a reset
      push @old, [pos($src), $&];
    }
    my @wide;
    while ($src =~ /$ARBITRARY/g) {
      my ($variant, $property, $value) = ($1 // "", $2, $3);
      next if $variant =~ /^\[&_/;
      push @wide, [pos($src), "[$property:$value]"];
    }
    if ($f =~ /\.css$/ && $f !~ m{/(?:theme|tailwind)\.css$}) {
      while ($src =~ /$CSS/g) { push @wide, [pos($src), "$1: $2"]; }
    }
    for my $entry ([OLD => \@old], [WIDE => \@wide]) {
      my ($kind, $hits) = @$entry;
      for my $hit (@$hits) {
        my $line = 1 + (substr($src, 0, $hit->[0]) =~ tr/\n//);
        print "$kind\t$f\t$line\t$hit->[1]\n";
      }
    }
  }
' "${sources[@]}")"

fail=0
while IFS=$'\t' read -r kind file line value; do
  [ -n "$kind" ] || continue
  case "$kind" in
    OLD) expected="gap-* on the flex or grid parent, or an allowed alignment/reset" ;;
    WIDE) expected="--space-* tokens for padding, margin and gap" ;;
  esac
  echo "FAIL: spacing-token $file:$line '$value'; expected $expected" >&2
  fail=1
done <<< "$reports"
[ "$fail" -eq 0 ] && echo "ok: spacing-token passes"
exit "$fail"
