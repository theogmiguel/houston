#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src/renderer/src}"
mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/components/ui/*' -not -path '*/generated/*' \
  -not -path '*/stories/*' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

# className expressions are read to their balanced closing brace, template literals and their
# `${…}` interpolations included, so a class after an interpolation is still seen.
reports="$(perl - "${sources[@]}" <<'PERL'
use strict; use warnings;
my $layout = qr/^(?:flex|inline-flex|grid|col-[\w-]+|row-[\w-]+|items-[\w-]+|justify-[\w-]+|self-[\w-]+|place-[\w-]+|min-w-0|min-h-0|flex-1|flex-none|shrink(?:-[\w-]+)?|grow|truncate|hidden|relative|absolute|inset-[\w-]+|w-full|h-full|overflow-[\w-]+)$/;
our ($file, $line);
sub report {
  my ($value) = @_;
  while ($value =~ /([^\s"'`]+)/g) {
    my $class = $1;
    $class =~ s/^[,;]+|[,;]+$//g;
    next unless $class =~ /^[a-z][a-z0-9-]*(?:-\[[^\]]+\])?$|^\[[^\]]+\]$/;
    next if $class =~ /^(?:const|return|undefined|true|false|and|or|plus|clsx|cn)$/;
    my $token = $class;
    1 while $token =~ s/^(?:sm|md|lg|xl|2xl|dark|hover|focus|focus-visible|active|disabled|group-hover|group-focus|peer-hover|peer-focus):+//;
    next if $token =~ $layout || $token =~ /^gap-\[var\(--space-[\w.-]+\)\]$/;
    print "$file\t$line\t$class\n";
  }
}
# The text of every string literal in an expression; a template literal contributes its quasis,
# and the literals inside its interpolations are collected recursively.
sub literals {
  my ($e) = @_;
  my @out;
  my ($i, $n) = (0, length $e);
  while ($i < $n) {
    my $c = substr($e, $i, 1);
    if ($c eq '"' || $c eq "'") {
      my $j = $i + 1;
      $j += substr($e, $j, 1) eq '\\' ? 2 : 1 while $j < $n && substr($e, $j, 1) ne $c;
      push @out, substr($e, $i + 1, $j - $i - 1);
      $i = $j + 1;
    } elsif ($c eq '`') {
      my $text = '';
      $i++;
      while ($i < $n && substr($e, $i, 1) ne '`') {
        if (substr($e, $i, 2) eq '${') {
          my ($depth, $k) = (1, $i + 2);
          while ($k < $n && $depth > 0) {
            my $d = substr($e, $k, 1);
            $depth++ if $d eq '{';
            $depth-- if $d eq '}';
            $k++;
          }
          push @out, literals(substr($e, $i + 2, $k - $i - 3));
          $text .= ' ';
          $i = $k;
        } else {
          $text .= substr($e, $i, 1);
          $i++;
        }
      }
      push @out, $text;
      $i++;
    } else {
      $i++;
    }
  }
  return @out;
}
# The index just past the brace that closes the `{` before $start, skipping strings and
# template literals so a brace inside them does not end the expression.
sub close_brace {
  my ($code, $start) = @_;
  my ($k, $n, @stack) = ($start, length $code, 'brace');
  while ($k < $n && @stack) {
    my $c = substr($code, $k, 1);
    if ($stack[-1] eq 'template') {
      if ($c eq '\\') { $k += 2; next }
      if ($c eq '`') { pop @stack; $k++; next }
      if (substr($code, $k, 2) eq '${') { push @stack, 'brace'; $k += 2; next }
      $k++;
      next;
    }
    if ($c eq '"' || $c eq "'") {
      my $j = $k + 1;
      $j += substr($code, $j, 1) eq '\\' ? 2 : 1 while $j < $n && substr($code, $j, 1) ne $c;
      $k = $j + 1;
      next;
    }
    if ($c eq '`') { push @stack, 'template' }
    elsif ($c eq '{') { push @stack, 'brace' }
    elsif ($c eq '}') { pop @stack }
    $k++;
  }
  return $k;
}
for my $f (@ARGV) {
  open my $fh, '<', $f or next;
  local $/ = undef;
  my $src = <$fh>;
  close $fh;
  (my $code = $src) =~ s{/\*.*?\*/}{}gs;
  $code =~ s{//[^\n]*}{}g;
  $file = $f;
  while ($code =~ /^(?:export\s+)?const\s+\w+_CLS\s*=\s*([\s\S]*?)(?=^(?:export\s+)?(?:const|function|type|interface)\b|\z)/gm) {
    my ($value, $start) = ($1, $-[1]);
    while ($value =~ /(?:"[^"\n]*"|'[^'\n]*'|`[^`]*`)/g) {
      $line = 1 + (substr($code, 0, $start + $-[0]) =~ tr/\n//);
      report($_) for literals(substr($value, $-[0], $+[0] - $-[0]));
    }
  }
  while ($code =~ /\bclassName\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|(\{))/g) {
    $line = 1 + (substr($code, 0, $-[0]) =~ tr/\n//);
    if (defined $3) {
      my $open = pos($code);
      my $end = close_brace($code, $open);
      report($_) for literals(substr($code, $open, $end - 1 - $open));
      pos($code) = $open;
    } else {
      report(defined $1 ? $1 : $2);
    }
  }
}
PERL
)"

# Feature files not yet composed from components/ui roles, with their violation counts. A listed
# file fails above its count, and a count that falls must be lowered or removed, so the list only
# shrinks. A fixture scan (SCAN_ROOT) reads its entries from UI_BOUNDARY_PENDING instead.
PENDING=(
  "ui/src/renderer/src/components/git/WorktreeCleanupSection.tsx 33"
  "ui/src/renderer/src/components/git/WorktreesDialog.tsx 57"
)
if [ -n "${SCAN_ROOT:-}" ]; then
  PENDING=()
  while IFS= read -r entry; do [ -n "$entry" ] && PENDING+=("$entry"); done <<< "${UI_BOUNDARY_PENDING:-}"
fi
declare -A pinned=() actual=()
for entry in "${PENDING[@]}"; do pinned["${entry% *}"]="${entry##* }"; done

fail=0
while IFS=$'\t' read -r file line class; do
  [ -z "$file" ] && continue
  if [ -n "${pinned[$file]:-}" ]; then
    actual["$file"]=$(( ${actual[$file]:-0} + 1 ))
    continue
  fi
  echo "FAIL: ui-boundary $file:$line '$class'; expected layout-only utilities outside components/ui; use a primitive or variant in components/ui" >&2
  fail=1
done <<< "$reports"

for file in "${!pinned[@]}"; do
  if [ "${actual[$file]:-0}" -gt "${pinned[$file]}" ]; then
    echo "FAIL: ui-boundary PENDING allows ${pinned[$file]} violation(s) in $file, found ${actual[$file]}; expected at most ${pinned[$file]}; compose the new markup from components/ui" >&2
    fail=1
  elif [ "${actual[$file]:-0}" -lt "${pinned[$file]}" ]; then
    echo "FAIL: ui-boundary PENDING allows ${pinned[$file]} violation(s) in $file, found ${actual[$file]:-0}; lower the entry to ${actual[$file]:-0}, or delete it at 0" >&2
    fail=1
  fi
done

mapfile -t stylesheets < <(find "$ui_src" -type f -name '*.css' \
  -not -path '*/components/ui/*' -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)
for file in "${stylesheets[@]}"; do
  case "$file" in
    */theme.css|*/tailwind.css|*/keyframes.css|*/base.css) ;;
    *) echo "FAIL: stylesheet $file; expected one of theme.css, tailwind.css, keyframes.css or base.css outside components/ui" >&2; fail=1; continue ;;
  esac
  [ "${file##*/}" = base.css ] || continue
  while IFS=$'\t' read -r line selector; do
    [ -z "$selector" ] && continue
    echo "FAIL: base stylesheet $file:$line '$selector'; expected element, pseudo-element, attribute or html/body document-state selectors only; move component styling to components/ui" >&2
    fail=1
  done < <(perl -e '''
    my $f = shift; open my $fh, "<", $f or exit 0; local $/ = undef; my $s = <$fh>;
    $s =~ s{/\*.*?\*/}{}gs;
    while ($s =~ /([^{}]+)\{/g) {
      my $sel = $1; my $at = $-[1]; $sel =~ s/^\s+|\s+$//g;
      my $line = 1 + (substr($s, 0, $at) =~ tr/\n//);
      for my $part (split /,/, $sel) {
        $part =~ s/^\s+|\s+$//g;
        next unless $part =~ /\.[A-Za-z_-][\w-]*/;
        next if $part =~ /^(?:html|body)\.[A-Za-z_-][\w-]*(?:\s|:|\[|$)/;
        print "$line\t$part\n";
      }
    }
  ''' "$file")
done

if [ "$fail" -eq 0 ]; then echo "ok: UI boundary passes (no feature visual classes or disallowed stylesheets; ${#PENDING[@]} pending file(s))"; fi
exit "$fail"
