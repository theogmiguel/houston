#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"
fail=0
source scripts/check-spacing-tokens-widened-baseline.sh

BASELINE=(
  "ui/src/renderer/src/App.tsx 0"
  "ui/src/renderer/src/BootstrapGate.tsx 0"
  "ui/src/renderer/src/components/BrowserActConfirm.tsx 1"
  "ui/src/renderer/src/components/browserTabs.tsx 1"
  "ui/src/renderer/src/components/ui/ActionEmptyState.tsx 2"
  "ui/src/renderer/src/components/FirstRun.tsx 0"
  "ui/src/renderer/src/components/HandoffOverlay.tsx 1"
  "ui/src/renderer/src/components/nav/SkillsSurface.tsx 1"
  "ui/src/renderer/src/components/nav/navChrome.tsx 2"
  "ui/src/renderer/src/components/settings/AboutSection.tsx 0"
  "ui/src/renderer/src/components/settings/DiagnosticsSection.tsx 7"
  "ui/src/renderer/src/components/ui/settingsPrimitives.tsx 1"
  "ui/src/renderer/src/components/settings/PrivacySection.tsx 2"
  "ui/src/renderer/src/components/settings/VoiceSection.tsx 2"
  "ui/src/renderer/src/components/ShortcutSheet.tsx 0"
  "ui/src/renderer/src/components/SkillsView.tsx 4"
  "ui/src/renderer/src/components/WorkspaceEmpty.tsx 1"
  "ui/src/renderer/src/components/WorkspacesEmpty.tsx 2"
  "ui/src/renderer/src/pane/TerminalPane.tsx 0"
)

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) \
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

if [ "${1:-}" = "--baseline" ]; then
  echo "WIDENED_BASELINE=("
  awk -F '\t' '$1 == "WIDE" { count[$2]++ } END { for (f in count) printf "  \"%s %d\"\n", f, count[f] }' <<< "$reports" | sort
  echo ")"
  exit 0
fi

check_category() {
  local kind="$1" array="$2" label="$3"
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
      echo "FAIL: $label ${locations[$file]} expected --space-* tokens for padding, margin and gap (found ${actual[$file]}, pin ${pinned[$file]:-0})" >&2
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
}

check_category OLD BASELINE spacing-token
check_category WIDE WIDENED_BASELINE spacing-token-widened

if [ "$fail" -ne 0 ]; then
  echo "      A stack's rhythm belongs to its container: delete the margin and" >&2
  echo "      put gap-* on the flex/grid parent (gap-2, gap-[var(--space-2)])." >&2
  echo "      STYLEGUIDE, 'Spacing & control metrics'. ml-auto/mr-auto are" >&2
  echo "      alignment and a -0 value is a reset; neither is counted." >&2
  echo "      The baseline only shrinks; it is not somewhere to add a line." >&2
else
  echo "ok: spacing guards pass (old ${#BASELINE[@]} pins, widened ${#WIDENED_BASELINE[@]} pins)"
fi

exit "$fail"
