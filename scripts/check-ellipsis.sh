#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"

mapfile -t sources < <( {
  find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
    -not -name '*.test.ts' -not -name '*.test.tsx' \
    -not -path '*/node_modules/*' -not -path '*/dist/*'
  echo "ui/src/renderer/index.html"
} | sort)

hits="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    # Blank out every comment, keeping newlines so line numbers hold. A
    # state machine, not a regex: a naive `//` match fires inside a string
    # like \x27http://...\x27, the false positive this pass exists to avoid.
    my @c = split //, $src;
    my $out = "";
    my $i = 0;
    my $n = @c;
    my $state = "code"; # code | line_comment | block_comment | sq | dq | tpl
    while ($i < $n) {
      my $ch = $c[$i];
      my $two = ($i + 1 < $n) ? $ch . $c[$i + 1] : "";
      if ($state eq "code") {
        if ($two eq "//") { $state = "line_comment"; $out .= "  "; $i += 2; next; }
        if ($two eq "/*") { $state = "block_comment"; $out .= "  "; $i += 2; next; }
        if ($ch eq "\x27") { $state = "sq"; $out .= $ch; $i++; next; }
        if ($ch eq "\x22") { $state = "dq"; $out .= $ch; $i++; next; }
        if ($ch eq "\x60") { $state = "tpl"; $out .= $ch; $i++; next; }
        $out .= $ch; $i++; next;
      }
      if ($state eq "line_comment") {
        if ($ch eq "\n") { $state = "code"; $out .= $ch; $i++; next; }
        $out .= " "; $i++; next;
      }
      if ($state eq "block_comment") {
        if ($two eq "*/") { $state = "code"; $out .= "  "; $i += 2; next; }
        $out .= ($ch eq "\n" ? "\n" : " "); $i++; next;
      }
      if ($state eq "sq" || $state eq "dq" || $state eq "tpl") {
        my $q = $state eq "sq" ? "\x27" : $state eq "dq" ? "\x22" : "\x60";
        if ($ch eq "\\") { $out .= substr($src, $i, 2); $i += 2; next; }
        if ($ch eq $q) { $state = "code"; $out .= $ch; $i++; next; }
        $out .= $ch; $i++; next;
      }
    }
    my @lines;
    my $ln = 0;
    for (split /\n/, $out) {
      $ln++;
      # Not-followed-by an identifier char, `(`, `[`, `{`, or `)` -- the
      # shapes spread/rest always takes. Everything else is prose.
      push @lines, $ln if /\.\.\.(?![A-Za-z0-9_$([{)])/;
    }
    print "$f:$_\n" for @lines;
  }
' "${sources[@]}")"

if [ -n "$hits" ]; then
  echo "FAIL: ASCII ellipsis (\"...\") in user-facing text:" >&2
  while IFS=: read -r f line; do
    [ -n "$f" ] && echo "  $f:$line" >&2
  done <<< "$hits"
  echo "      Use the real ellipsis character (…), never \"...\". A \"...\"" >&2
  echo "      followed by an identifier, (, [, {, or ) is spread/rest and" >&2
  echo "      is not what this guard flags -- if this fires on one, the" >&2
  echo "      character right after it doesn't match that shape; check it." >&2
  exit 1
fi

echo "ok: no ASCII ellipsis in user-facing text"
