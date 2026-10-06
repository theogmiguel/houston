#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src/renderer/src}"
mapfile -t sources < <(find "$ui_src" -type f -name '*.tsx' \
  -not -name '*.test.tsx' -not -path '*/components/ui/*' \
  -not -path '*/generated/*' -not -path '*/stories/*' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

reports="$(perl -e '
  my $proper = qr/(?:Houston|Claude|Codex|OpenCode|Cursor|Antigravity|Grok|ACP|MCP|PR|UI|API|GitHub|Linux|Windows|macOS|OAuth|PTY|SSH|URL|JSON|SQLite|ID|CPU|RAM|GPU|CLI|URL)/;
  for my $f (@ARGV) {
    next if $f =~ m{/components/ui/StatusLabel\.tsx$};
    open my $fh, "<", $f or next;
    my @lines = <$fh>;
    close $fh;
    for my $i (0..$#lines) {
      my $line = $lines[$i];
      next if $line =~ m{^\s*//|/\*|\*/};
      my @hits;
      while ($line =~ /\b(title|label|placeholder|aria-label)\s*=\s*["\x27]([^"\x27]*)["\x27]/g) {
        my ($prop, $s) = ($1, $2);
        (my $plain = $s) =~ s/$proper//g;
        push @hits, ["count", $s] if $s =~ /\(\d+\)|·\s*\d+/;
        push @hits, ["title-case", $s] if $prop ne "placeholder" && $plain =~ /\b[A-Z][a-z]+(?:\s+\b[A-Z][a-z]+){1,}\b/;
        push @hits, ["banned-status", $s] if $s =~ /^\s*(?:Ok|Not there)\s*$/;
      }
      for my $hit (@hits) { print "$hit->[0]\t$f\t" . ($i + 1) . "\t$hit->[1]\n"; }
    }
    my $src = join "", @lines;
    (my $child_src = $src) =~ s/=>/\0/g;
    while ($child_src =~ /<(?:Button|button|h[1-6]|label|MenuItem|Tooltip)(?:\s[^>]*)?>([^<]*)</gs) {
      my ($s, $at) = ($1, $-[1]);
      $s =~ s/\0/=>/g;
      next if length($s) == 0 || $s =~ /^\s*\{/ || $s =~ /^\s+$/;
      $s =~ s/\s+/ /g;
      $s =~ s/^ | $//g;
      my $prefix = substr($child_src, 0, $at);
      next if $prefix =~ m{(?:^|\n)\s*//[^\n]*$};
      my $line = 1 + ($prefix =~ tr/\n//);
      (my $plain = $s) =~ s/$proper//g;
      for my $rule (["count" => $s =~ /\(\d+\)|·\s*\d+/], ["title-case" => $plain =~ /\b[A-Z][a-z]+(?:\s+\b[A-Z][a-z]+){1,}\b/], ["banned-status" => $s =~ /^\s*(?:Ok|Not there)\s*$/]) {
        print "$rule->[0]\t$f\t$line\t$s\n" if $rule->[1];
      }
    }
  }
' "${sources[@]}")"

fail=0
while IFS=$'\t' read -r rule file line value; do
  [ -z "$rule" ] && continue
  case "$rule" in
    title-case) expected="sentence case" ;;
    count) expected="counts expressed with Count, without parenthesized or dotted values" ;;
    banned-status) expected="the approved status vocabulary" ;;
  esac
  echo "FAIL: copy-$rule $file:$line '$value'; expected $expected" >&2
  fail=1
done <<< "$reports"
if [ "$fail" -eq 0 ]; then echo "ok: copy checks pass"; fi
exit "$fail"
