#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src/renderer/src}"
mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/components/ui/*' -not -path '*/generated/*' \
  -not -path '*/stories/*' -not -path '*/p5-harness/*' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

reports="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    (my $code = $src) =~ s{/\*.*?\*/}{}gs;
    $code =~ s{//[^\n]*}{}g;
    my @values;
    while ($code =~ /^(?:export\s+)?const\s+\w+_CLS\s*=\s*([\s\S]*?)(?=^(?:export\s+)?(?:const|function|type|interface)\b|\z)/gm) {
      my ($value, $start) = ($1, $-[0]);
      my $base_line = 1 + (substr($code, 0, $start) =~ tr/\n//);
      while ($value =~ /(?:"([^"\n]*)"|\x27([^\x27\n]*)\x27|`([^`]*)`)/g) {
        push @values, [defined($1) ? $1 : defined($2) ? $2 : $3, $base_line + (substr($value, 0, $-[0]) =~ tr/\n//)];
      }
    }
    while ($code =~ /\bclassName\s*=\s*(?:"([^"\n]*)"|\x27([^\x27\n]*)\x27|\{([^}]*)\})/gs) {
      my ($double, $single, $expr) = ($1, $2, $3);
      my $at = 1 + (substr($code, 0, $-[0]) =~ tr/\n//);
      if (defined $double || defined $single) {
        push @values, [defined($double) ? $double : $single, $at];
      } else {
        my $inside = $expr // "";
        while ($inside =~ /(?:"([^"\n]*)"|\x27([^\x27\n]*)\x27|`([^`]*)`)/g) {
          push @values, [defined($1) ? $1 : defined($2) ? $2 : $3, $at];
        }
      }
    }
    for my $entry (@values) {
      my ($value, $line) = @$entry;
      $value =~ s/\$\{[^}]*\}//g;
      while ($value =~ /([^\s"\x27`]+)/g) {
        my $class = $1;
        $class =~ s/^[,;]+|[,;]+$//g;
        next unless $class =~ /^[a-z][a-z0-9-]*(?:-\[[^\]]+\])?$|^\[[^\]]+\]$/;
        next if $class =~ /^(?:const|return|undefined|true|false|and|or|plus|clsx|cn)$/;
        my $token = $class;
        1 while $token =~ s/^(?:sm|md|lg|xl|2xl|dark|hover|focus|focus-visible|active|disabled|group-hover|group-focus|peer-hover|peer-focus):+//;
        my $allowed = $token =~ /^(?:flex|inline-flex|grid|col-[\w-]+|row-[\w-]+|items-[\w-]+|justify-[\w-]+|self-[\w-]+|place-[\w-]+|min-w-0|min-h-0|flex-1|flex-none|shrink(?:-[\w-]+)?|grow|truncate|hidden|relative|absolute|inset-[\w-]+|w-full|h-full|overflow-[\w-]+)$/
          || $token =~ /^gap-\[var\(--space-[\w.-]+\)\]$/;
        next if $allowed;
        print "$f\t$line\t$class\n";
      }
    }
  }
' "${sources[@]}")"

if [ "${1:-}" = "--baseline" ]; then
  echo "BASELINE=("
  awk -F '\t' '{ count[$1]++ } END { for (file in count) printf "  \"%s %d\"\n", file, count[file] }' <<< "$reports" | sort
  echo ")"
  exit 0
fi

source scripts/check-ui-boundary-baseline.sh
fail=0
declare -A pinned=() actual=() locations=() shown=()
for entry in "${BASELINE[@]}"; do pinned["${entry% *}"]="${entry##* }"; done
while IFS=$'\t' read -r file line class; do
  [ -z "$file" ] && continue
  actual["$file"]=$(( ${actual[$file]:-0} + 1 ))
  if [ "${shown[$file]:-0}" -lt 3 ]; then
    locations["$file"]+="$file:$line '$class'; "
    shown["$file"]=$(( ${shown[$file]:-0} + 1 ))
  fi
done <<< "$reports"
for file in "${!actual[@]}"; do
  if [ "${actual[$file]}" -gt "${pinned[$file]:-0}" ]; then
    echo "FAIL: ui-boundary ${locations[$file]} expected -- layout only outside components/ui; use <Primitive> or add a variant in components/ui (found ${actual[$file]}, pin ${pinned[$file]:-0})" >&2
    fail=1
  fi
done
for file in "${!pinned[@]}"; do
  if [ "${actual[$file]:-0}" -lt "${pinned[$file]}" ]; then
    echo "FAIL: BASELINE pins ${pinned[$file]} in $file, but only ${actual[$file]:-0} remain; lower or delete it" >&2
    fail=1
  fi
done
if [ "$fail" -eq 0 ]; then echo "ok: UI boundary passes (${#BASELINE[@]} file pins)"; fi
exit "$fail"
