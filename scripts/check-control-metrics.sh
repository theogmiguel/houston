#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"
fail=0

BASELINE=(
  "ui/src/renderer/src/components/AttachmentChip.tsx 1"
  "ui/src/renderer/src/components/browserFullscreenChrome.ts 2"
  "ui/src/renderer/src/components/browserPickerChrome.ts 1"
  "ui/src/renderer/src/components/BrowserPicker.tsx 1"
  "ui/src/renderer/src/components/browserTabs.tsx 1"
  "ui/src/renderer/src/components/Chip.tsx 1"
  "ui/src/renderer/src/components/FilesPane.tsx 1"
  "ui/src/renderer/src/components/nav/navChrome.tsx 10"
  "ui/src/renderer/src/components/NewSessionComposer.tsx 3"
  "ui/src/renderer/src/components/pickerChrome.ts 1"
  "ui/src/renderer/src/components/settingsPrimitives.tsx 1"
  "ui/src/renderer/src/components/SkillsView.tsx 1"
  "ui/src/renderer/src/editor/editorChrome.ts 1"
)

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

counts="$(perl -e '
  # Walk to the tag'\''s own `>`, tracking quotes and brace depth: a naive stop
  # at the first `>` closes early on an arrow function or a generic. Comments
  # are skipped first, or an apostrophe in one opens a string never closed.
  sub tag_end {
    my ($src, $i) = @_;
    my $len = length($src);
    my $depth = 0;
    my $quote = "";
    while ($i < $len) {
      my $c = substr($src, $i, 1);
      if ($quote ne "") {
        if ($c eq "\\") { $i += 2; next; }
        if ($c eq $quote) { $quote = ""; }
        $i++;
        next;
      }
      if (substr($src, $i, 2) eq "//") {
        my $nl = index($src, "\n", $i);
        $i = ($nl < 0) ? $len : $nl + 1;
        next;
      }
      if (substr($src, $i, 2) eq "/*") {
        my $endc = index($src, "*/", $i + 2);
        $i = ($endc < 0) ? $len : $endc + 2;
        next;
      }
      if ($c eq "\"" || $c eq "'\''" || $c eq "`") { $quote = $c; $i++; next; }
      if ($c eq "{") { $depth++; $i++; next; }
      if ($c eq "}") { $depth--; $i++; next; }
      if ($depth <= 0 && $c eq ">") { return $i; }
      $i++;
    }
    return -1;
  }
  my $HGT = qr/(?:(?:min-|max-)?h|size)-\[[0-9.]+(?:px|rem)\]/;
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my %hit;
    # scope 1 -- HEIGHT literals in the attributes of an interactive tag
    while ($src =~ /<(?:button|input|select|textarea|a)\b/g) {
      my $start = pos($src);
      my $end = tag_end($src, $start);
      next if $end < 0;
      my $attrs = substr($src, $start, $end - $start);
      while ($attrs =~ /$HGT/g) { $hit{$start + pos($attrs)} = 1; }
      pos($src) = $end + 1;
    }
    # scope 2 -- heights in a chrome-constant file
    if ($f =~ /[Cc]hrome\.tsx?$/) {
      while ($src =~ /$HGT/g) { $hit{pos($src)} = 1; }
    }
    my $n = scalar keys %hit;
    print "$n\t$f\n" if $n > 0;
  }
' "${sources[@]}")"

rule_a="$(perl -e '
  my $LADDER = qr/(?:(?:min-|max-)?h)-\[(?:22|26|28)px\]/;
  for my $f (@ARGV) {
    next if $f =~ m{components/hitTarget\.ts$};
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my $n = () = $src =~ /$LADDER/g;
    print "$n\t$f\n" if $n > 0;
  }
' "${sources[@]}")"

if [ "${1:-}" = "--baseline" ]; then
  echo "BASELINE=("
  while IFS=$'\t' read -r n f; do
    [ -n "$f" ] && echo "  \"$f $n\""
  done <<< "$counts"
  echo ")"
  exit 0
fi

declare -A actual=()
while IFS=$'\t' read -r n f; do
  [ -n "$f" ] && actual["$f"]="$n"
done <<< "$counts"

declare -A pinned=()
for entry in "${BASELINE[@]}"; do
  pinned["${entry% *}"]="${entry##* }"
done

regressions=()
for f in "${!actual[@]}"; do
  have="${actual[$f]}"
  want="${pinned[$f]:-0}"
  [ "$have" -gt "$want" ] && regressions+=("$f $have $want")
done
if [ "${#regressions[@]}" -gt 0 ]; then
  echo "FAIL: control-metric literals above the pinned baseline:" >&2
  while read -r f have want; do
    echo "  $f -- $have literals, baseline pins $want" >&2
  done < <(printf '%s\n' "${regressions[@]}" | sort)
  echo "      A control's height comes from a --h-* token: h-[var(--h-ctl)]," >&2
  echo "      --h-row, --h-pill, --h-pane-head. STYLEGUIDE, 'Spacing & control" >&2
  echo "      metrics' -- and the 28px floor before inventing a height." >&2
  echo "      The baseline only shrinks; it is not somewhere to add a line." >&2
  fail=1
else
  echo "ok: no control-metric literal above the baseline (${#pinned[@]} files pinned)"
fi

stale=()
for f in "${!pinned[@]}"; do
  have="${actual[$f]:-0}"
  [ "$have" -lt "${pinned[$f]}" ] && stale+=("$f $have ${pinned[$f]}")
done
if [ "${#stale[@]}" -gt 0 ]; then
  echo "FAIL: baseline entry pins more than the file has -- lower or delete it:" >&2
  while read -r f have want; do
    if [ "$have" -eq 0 ]; then
      echo "  $f -- now clean, delete the entry" >&2
    else
      echo "  $f -- now $have, pin says $want" >&2
    fi
  done < <(printf '%s\n' "${stale[@]}" | sort)
  echo "      ./scripts/check-control-metrics.sh --baseline prints the new block." >&2
  fail=1
else
  echo "ok: every baseline entry still pins a real literal count"
fi

if [ -n "$rule_a" ]; then
  echo "FAIL: a height literal spells a control-ladder value (22/26/28):" >&2
  while IFS=$'\t' read -r n f; do
    [ -n "$f" ] && echo "  $f -- $n literal(s)" >&2
  done <<< "$rule_a"
  echo "      There is a token for that number: h-[var(--h-ctl)], --h-row," >&2
  echo "      --h-pane-head, --h-pill, --h-ctl-mini." >&2
  echo "      A square icon box wants CONTROL_SIZE_SQUARE_CLS instead." >&2
  fail=1
else
  echo "ok: no control-ladder literal anywhere under ui/src (rule A)"
fi

exit "$fail"
