#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="${SCAN_ROOT:-ui/src}"
tailwind_css="ui/src/renderer/src/tailwind.css"
fail=0

BASELINE=(
  "ui/src/renderer/src/App.tsx 1"
  "ui/src/renderer/src/components/AgentProfiles.tsx 3"
  "ui/src/renderer/src/components/AppearancePicker.tsx 1"
  "ui/src/renderer/src/components/AttachmentChip.tsx 2"
  "ui/src/renderer/src/components/BrowserActConfirm.tsx 7"
  "ui/src/renderer/src/components/browserFullscreenChrome.ts 3"
  "ui/src/renderer/src/components/BrowserPane.tsx 4"
  "ui/src/renderer/src/components/browserPickerChrome.ts 3"
  "ui/src/renderer/src/components/BrowserPicker.tsx 1"
  "ui/src/renderer/src/components/browserTabs.tsx 3"
  "ui/src/renderer/src/components/CommandPalette.tsx 1"
  "ui/src/renderer/src/components/FirstRun.tsx 1"
  "ui/src/renderer/src/components/HandoffOverlay.tsx 1"
  "ui/src/renderer/src/components/HostKeyModal.tsx 2"
  "ui/src/renderer/src/components/LayoutView.tsx 1"
  "ui/src/renderer/src/components/markdownPipeline.tsx 1"
  "ui/src/renderer/src/components/McpManager.tsx 1"
  "ui/src/renderer/src/components/nav/navChrome.tsx 2"
  "ui/src/renderer/src/components/NewSessionComposer.tsx 1"
  "ui/src/renderer/src/components/panelChrome.ts 1"
  "ui/src/renderer/src/components/QuestionCard.tsx 1"
  "ui/src/renderer/src/components/settings/AboutSection.tsx 1"
  "ui/src/renderer/src/components/settings/AppearanceSection.tsx 2"
  "ui/src/renderer/src/components/settings/DiagnosticsSection.tsx 3"
  "ui/src/renderer/src/components/settings/OrchestrationSection.tsx 2"
  "ui/src/renderer/src/components/settings/PrivacySection.tsx 1"
  "ui/src/renderer/src/components/settings/shared.tsx 2"
  "ui/src/renderer/src/components/settings/ShortcutsSection.tsx 1"
  "ui/src/renderer/src/components/settings/TerminalSection.tsx 2"
  "ui/src/renderer/src/components/settings/VoiceSection.tsx 4"
  "ui/src/renderer/src/components/Sidebar.tsx 12"
  "ui/src/renderer/src/components/SkillsView.tsx 8"
  "ui/src/renderer/src/components/SshConnectModal.tsx 2"
  "ui/src/renderer/src/components/UsageSection.tsx 2"
  "ui/src/renderer/src/components/WindowControls.tsx 1"
  "ui/src/renderer/src/components/WorkspacesEmpty.tsx 2"
  "ui/src/renderer/src/editor/editorChrome.ts 1"
  "ui/src/renderer/src/global.css 1"
  "ui/src/renderer/src/pane/TerminalPane.tsx 3"
  "ui/src/renderer/src/voice/DictationIndicator.tsx 1"
)

mapped_steps="$(perl -e '
  my $f = shift;
  open my $fh, "<", $f or exit 0;
  local $/ = undef;
  my $src = <$fh>;
  close $fh;
  # The @theme block, brace-matched shallowly: it holds only declarations.
  while ($src =~ /\@theme\s*\{(.*?)\n\}/sg) {
    my $body = $1;
    while ($body =~ /--radius-([a-z0-9]+)\s*:\s*([^;]*);/g) {
      # Copied out before the value is matched: a bare `$2 =~ //` in an `if`
      # modifier runs first and clears $1 with its own (group-less) capture.
      my ($step, $value) = ($1, $2);
      print "$step\n" if $value =~ /--tr-radius-/;
    }
  }
' "$tailwind_css" | sort -u | tr '\n' ' ')"

banned_steps=()
for step in xs sm md lg xl 2xl 3xl 4xl; do
  case " $mapped_steps " in *" $step "*) ;; *) banned_steps+=("$step") ;; esac
done
banned_alt="$(IFS='|'; echo "${banned_steps[*]}")"

mapfile -t sources < <(git ls-files --cached --others --exclude-standard "$ui_src" \
  | grep -E '\.(ts|tsx|css)$' \
  | grep -v '\.test\.tsx\?$' \
  | sort -u)

counts="$(BANNED="$banned_alt" perl -e '
  my $banned = $ENV{BANNED};
  # rule 1 -- a numeric arbitrary value on `rounded` or any corner variant.
  # `[0-9.]` right after the bracket is what separates it from var()/calc()/
  # inherit/50%.
  my $LIT = qr/\brounded(?:-[a-z]{1,2})?-\[[0-9][0-9.]*(?:px|rem|em|pt)\]/;
  # rule 2 -- a framework step, as a whole word so `rounded-md-thing` and a
  # `--radius-md` declaration do not match. Empty when every step is mapped.
  my $UTIL = length($banned)
    ? qr/(?<![\w-])rounded-(?:$banned)(?![\w-])/
    : undef;
  # rule 3 -- a hand-typed length in a stylesheet. `0`, var(), calc() and
  # inherit all fail the leading `[1-9]|0\.` test.
  my $CSS = qr/border-radius\s*:[^;]*?(?<![\w.-])[0-9][0-9.]*(?:px|rem|em|pt|%)/;
  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;
    # Comments are stripped first: this house writes `rounded-md` in prose to
    # explain why it is not used, and a doc comment is not a call site. `//`
    # only outside .css, where it is not a comment.
    $src =~ s{/\*.*?\*/}{}gs;
    $src =~ s{//.*}{}g unless $f =~ /\.css$/;
    my (%hit, %val);
    while ($src =~ /$LIT/g) { $hit{pos($src)} = 1; $val{$&} = 1; }
    if (defined $UTIL) {
      while ($src =~ /$UTIL/g) { $hit{pos($src)} = 1; $val{$&} = 1; }
    }
    if ($f =~ /\.css$/) {
      while ($src =~ /$CSS/g) { $hit{pos($src)} = 1; my $m = $&; $m =~ s/\s+/ /g; $val{$m} = 1; }
    }
    my $n = scalar keys %hit;
    next unless $n > 0;
    my @v = sort keys %val;
    @v = (@v[0..3], "…") if @v > 5;
    print "$n\t$f\t" . join(", ", @v) . "\n";
  }
' "${sources[@]}")"

if [ "${1:-}" = "--baseline" ]; then
  echo "BASELINE=("
  while IFS=$'\t' read -r n f _; do
    [ -n "$f" ] && echo "  \"$f $n\""
  done <<< "$counts"
  echo ")"
  exit 0
fi

declare -A actual=() offending=()
while IFS=$'\t' read -r n f v; do
  [ -n "$f" ] && actual["$f"]="$n" && offending["$f"]="$v"
done <<< "$counts"

declare -A pinned=()
for entry in "${BASELINE[@]}"; do
  pinned["${entry% *}"]="${entry##* }"
done

regressions=()
for f in "${!actual[@]}"; do
  have="${actual[$f]}"
  want="${pinned[$f]:-0}"
  [ "$have" -gt "$want" ] && regressions+=("$f")
done
if [ "${#regressions[@]}" -gt 0 ]; then
  echo "FAIL: radius literals above the pinned baseline:" >&2
  while read -r f; do
    echo "  $f -- ${actual[$f]} literal(s), baseline pins ${pinned[$f]:-0}" >&2
    echo "      offending: ${offending[$f]}" >&2
  done < <(printf '%s\n' "${regressions[@]}" | sort)
  echo "      Expected shape: rounded-[var(--tr-radius-<rung>)] in a class" >&2
  echo "      string, border-radius: var(--tr-radius-<rung>) in CSS. The rungs" >&2
  echo "      are input 4, sm 6, button 8, md 10, card 12, panel 16, pill 9999" >&2
  echo "      (theme.css; STYLEGUIDE 'Radius'). A framework rounded-sm/md/lg/xl" >&2
  echo "      is the FRAMEWORK's scale, not this app's, while tailwind.css's" >&2
  echo "      @theme leaves --radius-* unmapped." >&2
  echo "      The baseline only shrinks; it is not somewhere to add a line." >&2
  fail=1
else
  echo "ok: no radius literal above the baseline (${#pinned[@]} files pinned)"
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
  echo "      ./scripts/check-radius-tokens.sh --baseline prints the new block." >&2
  fail=1
else
  echo "ok: every baseline entry still pins a real literal count"
fi

if [ -z "$banned_alt" ]; then
  echo "ok: tailwind.css @theme maps every --radius-* step onto --tr-radius-*"
else
  echo "ok: rounded-{${banned_alt//|/,}} banned — tailwind.css @theme leaves those unmapped"
fi

exit "$fail"
