#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"
source scripts/check-type-scale-widened-baseline.sh

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
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

if [ "${1:-}" = "--baseline" ]; then
  echo "WIDENED_BASELINE=("
  awk -F '\t' '$1 == "WIDE" { count[$2]++ } END { for (f in count) printf "  \"%s %d\"\n", f, count[f] }' <<< "$reports" | sort
  echo ")"
  echo "FLOOR_BASELINE=("
  awk -F '\t' '$1 == "FLOOR" { count[$2]++ } END { for (f in count) printf "  \"%s %d\"\n", f, count[f] }' <<< "$reports" | sort
  echo ")"
  exit 0
fi

fail=0
while IFS=$'\t' read -r kind file line value; do
  [ -n "$kind" ] || continue
  case "$kind" in
    OLD)
      echo "FAIL: type-scale $file:$line found '$value'; expected one of the eight --tr-text-<step> tokens" >&2
      fail=1
      ;;
  esac
done <<< "$reports"

for spec in "WIDE WIDENED_BASELINE type-scale-widened" "FLOOR FLOOR_BASELINE type-scale-floor"; do
  read -r kind array label <<< "$spec"
  declare -n baseline="$array"
  declare -A pinned=() actual=() locations=()
  for entry in "${baseline[@]}"; do pinned["${entry% *}"]="${entry##* }"; done
  while IFS=$'\t' read -r report_kind file line value; do
    [ "$report_kind" = "$kind" ] || continue
    actual["$file"]=$(( ${actual[$file]:-0} + 1 ))
    locations["$file"]+="${file}:$line '$value'; "
  done <<< "$reports"
  for file in "${!actual[@]}"; do
    if [ "${actual[$file]}" -gt "${pinned[$file]:-0}" ]; then
      expected="--tr-text-<step>-size / --tr-text-<step>-weight"
      [ "$kind" = "FLOOR" ] && expected="a type token or a size of at least 11px"
      echo "FAIL: $label ${locations[$file]} expected $expected (found ${actual[$file]}, pin ${pinned[$file]:-0})" >&2
      fail=1
    fi
  done
  for file in "${!pinned[@]}"; do
    if [ "${actual[$file]:-0}" -lt "${pinned[$file]}" ]; then
      echo "FAIL: $array pins ${pinned[$file]} in $file, but only ${actual[$file]:-0} remain; lower or delete the pin" >&2
      fail=1
    fi
  done
  unset pinned actual locations
 done

[ "$fail" -eq 0 ] && echo "ok: no type-scale violations above widened and floor baselines"
exit "$fail"
