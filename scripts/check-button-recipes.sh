#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

ui_src="ui/src"
chrome_owner="ui/src/renderer/src/components/buttonChrome.ts"

PRIVATE_DECL_ALLOWLIST=()
BARE_ALLOWLIST=(
  "ui/src/renderer/src/components/settings/DiagnosticsSection.tsx"
)

is_allowlisted() {
  local needle="$1"
  shift
  local x
  for x in "$@"; do
    [ "$x" = "$needle" ] && return 0
  done
  return 1
}

mapfile -t sources < <(find "$ui_src" -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -name '*.test.ts' -not -name '*.test.tsx' \
  -not -path '*/node_modules/*' -not -path '*/dist/*' | sort)

report="$(perl -e '
  my $owner = shift @ARGV;
  # Overlays on `.btn`, so a call site must spell the literal class too.
  # The other recipes are self-sufficient or a deliberate partial piece.
  my @overlay_names = qw(BTN_PRIMARY BTN_DANGER_SOLID BTN_GHOST BTN_GHOST_DANGER_HOVER BTN_GHOST_DANGER_ARM);
  my $overlay_re = join("|", @overlay_names);

  for my $f (@ARGV) {
    open my $fh, "<", $f or next;
    local $/ = undef;
    my $src = <$fh>;
    close $fh;

    # Rule 1: only buttonChrome.ts may declare a BTN_* constant.
    if ($f ne $owner) {
      while ($src =~ /^\s*(?:export\s+)?const\s+(BTN_[A-Z0-9_]*)\s*=/mg) {
        print "shadow\t$f\t$1\n";
      }
    }

    # Rule 2: a template literal using one of the overlay constants must
    # also carry the literal `btn` class somewhere in the same literal.
    while ($src =~ /`([^`]*)`/gs) {
      my $lit = $1;
      next unless $lit =~ /\$\{($overlay_re)\}/;
      next if $lit =~ /\bbtn\b/;
      my $const = $1;
      print "bare\t$f\t$const\n";
    }
  }
' "$chrome_owner" "${sources[@]}")"

fail=0
shadow_hit_files=()
bare_hit_files=()

if [ -n "$report" ]; then
  shadow_lines="$(grep -P '^shadow\t' <<< "$report" || true)"
  bare_lines="$(grep -P '^bare\t' <<< "$report" || true)"

  new_shadow=()
  while IFS=$'\t' read -r _ f name; do
    [ -z "$f" ] && continue
    if is_allowlisted "$f" "${PRIVATE_DECL_ALLOWLIST[@]}"; then
      shadow_hit_files+=("$f")
    else
      new_shadow+=("$f -- declares its own $name")
    fi
  done <<< "$shadow_lines"

  new_bare=()
  while IFS=$'\t' read -r _ f name; do
    [ -z "$f" ] && continue
    if is_allowlisted "$f" "${BARE_ALLOWLIST[@]}"; then
      bare_hit_files+=("$f")
    else
      new_bare+=("$f -- \${$name} with no 'btn' in the same class string")
    fi
  done <<< "$bare_lines"

  if [ "${#new_shadow[@]}" -gt 0 ]; then
    fail=1
    echo "FAIL: private BTN_* declarations outside buttonChrome.ts:" >&2
    printf '  %s\n' "${new_shadow[@]}" >&2
    echo "      Import the shared constant from components/buttonChrome.ts instead." >&2
  fi

  if [ "${#new_bare[@]}" -gt 0 ]; then
    fail=1
    echo "FAIL: overlay button constant used without the base 'btn' class:" >&2
    printf '  %s\n' "${new_bare[@]}" >&2
    echo "      An overlay constant (BTN_PRIMARY, BTN_DANGER_SOLID, BTN_GHOST and its" >&2
    echo "      two danger-cue variants) is a documented overlay on '.btn' (border" >&2
    echo "      width/style, padding, font, radius) — without it the override has" >&2
    echo "      nothing to override. Add 'btn' to the class string." >&2
  fi
fi

for f in "${PRIVATE_DECL_ALLOWLIST[@]}"; do
  if ! is_allowlisted "$f" "${shadow_hit_files[@]}"; then
    fail=1
    echo "FAIL: stale PRIVATE_DECL_ALLOWLIST entry, no longer violates: $f" >&2
    echo "      Remove it from scripts/check-button-recipes.sh." >&2
  fi
done
for f in "${BARE_ALLOWLIST[@]}"; do
  if ! is_allowlisted "$f" "${bare_hit_files[@]}"; then
    fail=1
    echo "FAIL: stale BARE_ALLOWLIST entry, no longer violates: $f" >&2
    echo "      Remove it from scripts/check-button-recipes.sh." >&2
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "ok: no button-recipe violations"
