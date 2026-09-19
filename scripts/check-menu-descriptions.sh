#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"

mapfile -t candidates < <(
  find "$ui_src" \( -name '*.tsx' -o -name '*.ts' \) \
    ! -name '*.test.tsx' ! -name '*.test.ts' -print0 \
    | xargs -0 -r grep -lE 'role="menuitem"' \
    | sort
)

report="$(perl -e '
  my $WRAP_SAFE = qr/whitespace-normal|line-clamp-\d+|break-words|whitespace-pre-wrap/;
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    # Scope to one `role="menuitem"` block before hunting the label and
    # description, so an unrelated `<strong>`/`<span>` in the same file
    # (an error banner, a loading state) is not read as the pair.
    while ($src =~ m{<button\b[^>]*role="menuitem"[^>]*>(.*?)</button>}gs) {
      my $block = $1;
      my $block_start = pos($src) - length($&);
      while ($block =~ m{<strong\b[^>]*>.*?</strong>\s*<(span|small|p)\b([^>]*)>}gs) {
        my ($tag, $attrs) = ($1, $2);
        my $tag_start = $block_start + pos($block) - length($&);
        my $line = 1 + (substr($src, 0, $tag_start) =~ tr/\n//);
        my $cls = "";
        if ($attrs =~ /className=\{?`([^`]*)`/) { $cls = $1; }
        elsif ($attrs =~ /className="([^"]*)"/) { $cls = $1; }
        my $has_maxw = ($cls =~ /max-w-/) ? 1 : 0;
        my $has_nowrap = ($cls =~ /whitespace-nowrap/) ? 1 : 0;
        my $has_truncate = ($cls =~ /\btruncate\b/) ? 1 : 0;
        my $has_wrap_safe = ($cls =~ /$WRAP_SAFE/) ? 1 : 0;
        my $reason = "";
        if ($has_nowrap && !$has_maxw) { $reason = "whitespace-nowrap with no max-w-* bound"; }
        elsif ($has_truncate && !$has_maxw) { $reason = "truncate with no max-w-* bound"; }
        elsif (!$has_wrap_safe && !$has_truncate) { $reason = "no wrapping class at all"; }
        if ($reason) {
          print "$f\t$line\t<$tag>\t$reason\n";
        }
      }
    }
  }
' "${candidates[@]}")"

if [ -n "$report" ]; then
  echo "FAIL: menu item description does not wrap or truncate on purpose (STYLEGUIDE, Menus):" >&2
  while IFS=$'\t' read -r f line tag reason; do
    [ -n "$f" ] && echo "  $f:$line $tag -- $reason" >&2
  done <<< "$report"
  echo "      Use whitespace-normal / line-clamp-N, or truncate paired with max-w-*." >&2
  exit 1
fi

echo "check-menu-descriptions: OK — every menu item description wraps or truncates on purpose"
