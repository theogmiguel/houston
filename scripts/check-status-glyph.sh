#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

if [ -n "${SCAN_ROOT:-}" ]; then
  scan_roots=("$SCAN_ROOT")
else
  scan_roots=(ui/src/renderer/src)
fi

mapfile -t sources < <(find "${scan_roots[@]}" -type f -name '*.tsx' \
  -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

counts="$(perl -e '
  # A status image is a rounded element with a status fill that presents as
  # one (role="img", agent-dot, grid-state-dot, data-status-glyph).
  my $STATUS_FILL = qr/bg-\[(?:var\(--(?:warn|danger|stop|ok|success|accent|info)\)|color-mix\(in_srgb,var\(--(?:warn|danger|stop|ok|success|accent|info)\))/;
  my $PRESENTS = qr/(?:role=["\x27]img["\x27]|(?<![\w-])agent-dot(?![\w-])|grid-state-dot|data-status-glyph)/;
  for my $f (@ARGV) {
    next if $f =~ m{components/ui/StatusGlyph\.tsx$};
    # The unread pip is read state, not a lifecycle status; it keeps its own
    # 6px accent dot rather than borrowing a status glyph.
    next if $f =~ m{components/ui/rail/GridRailTitleRow\.tsx$};
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    $src =~ s{/\*.*?\*/}{}gs;
    $src =~ s{//.*}{}g;
    my (@hits, %seen);
    while ($src =~ /<[A-Za-z][A-Za-z0-9.]*((?:[^<>{}]|\{(?:[^{}]|\{[^{}]*\})*\})*?)\/?>/gs) {
      my $attrs = $1;
      next unless $attrs =~ /rounded-full/;
      next unless $attrs =~ /$STATUS_FILL/;
      next unless $attrs =~ /$PRESENTS/;
      my $line = 1 + (substr($src, 0, pos($src)) =~ tr/\n//);
      push @hits, $line unless $seen{$line}++;
    }
    print scalar(@hits) . "\t$f\t" . join(",", @hits) . "\n" if @hits;
  }
' "${sources[@]}")"

if [ -n "$counts" ]; then
  echo "FAIL: status-glyph violations:" >&2
  while IFS=$'\t' read -r n f lines; do
    [ -n "$f" ] && echo "  $f:$lines -- $n rounded status image(s) outside StatusGlyph" >&2
  done <<< "$counts"
  echo "      A rounded element that paints a status fill (warn/danger/stop/ok/" >&2
  echo "      success/accent/info) and presents as a status image must render" >&2
  echo "      <StatusGlyph state={statusGlyphState(source)} label=... />." >&2
  exit 1
fi

echo "ok: status images use StatusGlyph"
