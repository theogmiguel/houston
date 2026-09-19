#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"
fail=0

BASELINE=(
  "ui/src/renderer/src/App.tsx 2"
  "ui/src/renderer/src/BootstrapGate.tsx 1"
  "ui/src/renderer/src/components/AgentProfiles.tsx 3"
  "ui/src/renderer/src/components/BrowserActConfirm.tsx 1"
  "ui/src/renderer/src/components/browserTabs.tsx 1"
  "ui/src/renderer/src/components/EmptyState.tsx 2"
  "ui/src/renderer/src/components/FirstRun.tsx 1"
  "ui/src/renderer/src/components/HandoffOverlay.tsx 2"
  "ui/src/renderer/src/components/markdownPipeline.tsx 1"
  "ui/src/renderer/src/components/McpManager.tsx 1"
  "ui/src/renderer/src/components/nav/navChrome.tsx 8"
  "ui/src/renderer/src/components/nav/RoutineEditor.tsx 4"
  "ui/src/renderer/src/components/nav/RoutineRow.tsx 1"
  "ui/src/renderer/src/components/nav/SkillsSurface.tsx 1"
  "ui/src/renderer/src/components/NewSessionComposer.tsx 7"
  "ui/src/renderer/src/components/settings/AboutSection.tsx 1"
  "ui/src/renderer/src/components/settings/AppearanceSection.tsx 2"
  "ui/src/renderer/src/components/SettingsDetail.tsx 6"
  "ui/src/renderer/src/components/settings/DiagnosticsSection.tsx 9"
  "ui/src/renderer/src/components/settings/NotificationsSection.tsx 2"
  "ui/src/renderer/src/components/settings/OrchestrationSection.tsx 7"
  "ui/src/renderer/src/components/settingsPrimitives.tsx 1"
  "ui/src/renderer/src/components/settings/PrivacySection.tsx 4"
  "ui/src/renderer/src/components/settings/ShortcutsSection.tsx 3"
  "ui/src/renderer/src/components/settings/TerminalSection.tsx 2"
  "ui/src/renderer/src/components/settings/VoiceSection.tsx 2"
  "ui/src/renderer/src/components/ShortcutSheet.tsx 2"
  "ui/src/renderer/src/components/SkillsView.tsx 4"
  "ui/src/renderer/src/components/UsageChart.tsx 2"
  "ui/src/renderer/src/components/UsageSection.tsx 17"
  "ui/src/renderer/src/components/WorkspaceEmpty.tsx 1"
  "ui/src/renderer/src/components/WorkspacesEmpty.tsx 2"
  "ui/src/renderer/src/pane/TerminalPane.tsx 1"
)

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

counts="$(perl -e '
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    my $n = 0;
    while ($src =~ /(\[&[^\]]*\]:)?(?<![\w-])(-?)(?:mt|mr|mb|ml)-(\[[^\]]+\]|[\w.]+)/g) {
      my ($variant, $sign, $value) = ($1 // "", $2, $3);
      next if $variant =~ /^\[&_/;            # 4. prose we did not author
      next if $value eq "auto";               # 1. alignment
      next if $sign eq "-" || $value =~ /^\[-/;  # 3. a pull, not a gap
      next if $value =~ /^(?:0|\[0(?:px|rem|em)?\])$/;  # 2. a reset
      $n++;
    }
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
  echo "FAIL: directional margins above the pinned baseline:" >&2
  while read -r f have want; do
    echo "  $f -- $have margin(s), baseline pins $want" >&2
    perl -e '
      my %seen;
      open my $fh, "<", $ARGV[0] or exit;
      my $ln = 0;
      while (my $line = <$fh>) {
        $ln++;
        while ($line =~ /(\[&[^\]]*\]:)?(?<![\w-])(-?)((?:mt|mr|mb|ml)-(?:\[[^\]]+\]|[\w.]+))/g) {
          my ($variant, $sign, $util) = ($1 // "", $2, $3);
          next if $variant =~ /^\[&_/;
          next if $util =~ /-auto$/;
          next if $sign eq "-" || $util =~ /-\[-/;
          next if $util =~ /-(?:0|\[0(?:px|rem|em)?\])$/;
          next if $seen{$util}++;
          print "        $ARGV[0]:$ln  $util\n";
        }
      }
    ' "$f" >&2
  done < <(printf '%s\n' "${regressions[@]}" | sort)
  echo "      A stack's rhythm belongs to its container: delete the margin and" >&2
  echo "      put gap-* on the flex/grid parent (gap-2, gap-[var(--space-2)])." >&2
  echo "      STYLEGUIDE, 'Spacing & control metrics'. ml-auto/mr-auto are" >&2
  echo "      alignment and a -0 value is a reset; neither is counted." >&2
  echo "      The baseline only shrinks; it is not somewhere to add a line." >&2
  fail=1
else
  echo "ok: no directional margin above the baseline (${#pinned[@]} files pinned)"
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
  echo "      ./scripts/check-spacing-tokens.sh --baseline prints the new block." >&2
  fail=1
else
  echo "ok: every baseline entry still pins a real margin count"
fi

exit "$fail"
