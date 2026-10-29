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

# The scale itself: six steps, with the body weight the design settled on.
scale_problems="$(perl -e '
  my $f = shift;
  open my $fh, "<", $f or exit 1;
  local $/ = undef;
  my $src = <$fh>;
  close $fh;
  my %want = (
    "large-title" => [26, 32, 700],
    title => [20, 26, 650],
    headline => [13, 18, 600],
    body => [13, 18, 400],
    callout => [12, 16, 400],
    caption => [11, 14, 600]
  );
  my (%size, %leading, %weight);
  while ($src =~ /--tr-text-([a-z-]+)-size\s*:\s*([^;]+);/g) { $size{$1} = $2 }
  while ($src =~ /--tr-text-([a-z-]+)-leading\s*:\s*([^;]+);/g) { $leading{$1} = $2 }
  while ($src =~ /--tr-text-([a-z-]+)-weight\s*:\s*([^;]+);/g) { $weight{$1} = $2 }
  sub px { my $v = shift // ""; return $1 if $v =~ /([0-9]+(?:\.[0-9]+)?)px/; return undef }
  sub lh { my $v = shift // ""; return $1 if $v =~ /^\s*([0-9]+(?:\.[0-9]+)?)\s*$/; return undef }
  sub wt { my $v = shift // ""; return $1 if $v =~ /round\(\s*nearest\s*,\s*([0-9]+)/; return $1 if $v =~ /^\s*([0-9]+)\s*$/; return undef }
  for my $role (sort keys %want) {
    my ($size_want, $leading_want, $weight_want) = @{$want{$role}};
    my $size_got = px($size{$role});
    my $leading_got = lh($leading{$role});
    my $weight_got = wt($weight{$role});
    my $leading_ratio = $leading_want / $size_want;
    print "--tr-text-$role-size is \x27".($size{$role} // "missing")."\x27; expected ${size_want}px\n" unless defined $size_got && $size_got == $size_want;
    print "--tr-text-$role-leading is \x27".($leading{$role} // "missing")."\x27; expected the unitless ratio $leading_ratio (${leading_want}px at ${size_want}px)\n" unless defined $leading_got && abs($leading_got - $leading_ratio) <= 0.01;
    print "--tr-text-$role-weight is \x27".($weight{$role} // "missing")."\x27; expected $weight_want\n" unless defined $weight_got && $weight_got == $weight_want;
  }
' ui/src/renderer/src/theme.css)"

while IFS= read -r problem; do
  [ -n "$problem" ] || continue
  echo "FAIL: type-scale $problem" >&2
  fail=1
done <<< "$scale_problems"

[ "$fail" -eq 0 ] && echo "ok: type-scale passes"
exit "$fail"
