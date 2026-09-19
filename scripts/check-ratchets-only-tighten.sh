#!/usr/bin/env bash

# A ratchet only falls. A rename or move that keeps the total flat passes; a
# rise is new debt wherever the line was added. Fixing the rule means changing
# the rule, not raising the pin.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

RATCHETS=(
  "scripts/check-radius-tokens.sh BASELINE bash"
  "scripts/check-control-metrics.sh BASELINE bash"
  "scripts/check-spacing-tokens.sh BASELINE bash"
  "scripts/check-focus-visible.sh EXEMPT_COUNTS bash"
  "ui/complexity-baseline.json files json"
)

ref="${1:-}"
if [ -z "$ref" ]; then
  if [ -n "${GITHUB_BASE_REF:-}" ]; then
    ref="origin/$GITHUB_BASE_REF"
  elif [ "${GITHUB_EVENT_NAME:-}" = "push" ]; then
    ref="HEAD~1"
  else
    ref="HEAD"
  fi
fi
if ! git rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
  echo "FAIL: cannot resolve the comparison ref \"$ref\" -- nothing to compare the" >&2
  echo "      pins against, so this guard has no evidence either way." >&2
  echo "      Expected a resolvable commit-ish. In CI, actions/checkout needs" >&2
  echo "      fetch-depth: 0 (the default depth-1 clone has no history and no" >&2
  echo "      origin/<base>). Locally, pass a ref explicitly." >&2
  exit 1
fi

extract() {
  local name="$1" kind="$2"
  perl -e '
    my ($name, $kind) = (shift, shift);
    local $/ = undef;
    my $src = <STDIN>;
    if ($kind eq "bash") {
      # Non-greedy to the first line that is exactly `)`, so a later array in
      # the same file cannot be swallowed into this one.
      if ($src =~ /^\Q$name\E=\((.*?)^\)/ms) {
        my $body = $1;
        while ($body =~ /"([^"\s]+)\s+(\d+)"/g) { print "$1\t$2\n" }
      }
      exit 0;
    }
    # json: the named object, then each "path": { total, worst, over }. The
    # two ratcheting fields become their own keys so a rise in either is named.
    if ($src =~ /"\Q$name\E"\s*:\s*\{(.*?)\n  \}/s) {
      my $body = $1;
      while ($body =~ /"([^"]+)"\s*:\s*\{([^}]*)\}/g) {
        my ($path, $fields) = ($1, $2);
        while ($fields =~ /"(worst|over)"\s*:\s*(\d+)/g) {
          print "$path#$1\t$2\n";
        }
      }
    }
  ' "$name" "$kind"
}

fail=0
total_pins=0
renames=0

for entry in "${RATCHETS[@]}"; do
  read -r file name kind <<< "$entry"

  if [ ! -f "$file" ]; then
    echo "FAIL: $file is listed as a ratchet but does not exist -- a guard whose" >&2
    echo "      baseline has been deleted enforces nothing. Remove the RATCHETS" >&2
    echo "      entry in the same commit that removes the gate." >&2
    fail=1
    continue
  fi

  declare -A now=() before=()
  while IFS=$'\t' read -r k v; do [ -n "$k" ] && now["$k"]="$v"; done < <(extract "$name" "$kind" < "$file")

  if ! git cat-file -e "$ref:$file" 2>/dev/null; then
    echo "ok: $file ($name) is new at $ref -- ${#now[@]} pin(s) recorded, nothing to compare"
    total_pins=$((total_pins + ${#now[@]}))
    unset now before
    continue
  fi
  while IFS=$'\t' read -r k v; do [ -n "$k" ] && before["$k"]="$v"; done \
    < <(git show "$ref:$file" | extract "$name" "$kind")

  if [ "${#now[@]}" -eq 0 ] && [ "${#before[@]}" -gt 0 ]; then
    echo "FAIL: $file -- the $name block parsed as ${#before[@]} pin(s) at $ref and 0 now." >&2
    echo "      Either every pin was removed (say so in the commit, and delete this" >&2
    echo "      RATCHETS entry if the baseline is gone) or the block's shape changed" >&2
    echo "      and this guard can no longer read it. A baseline this script cannot" >&2
    echo "      parse is a baseline it cannot enforce." >&2
    fail=1
    unset now before
    continue
  fi

  for k in "${!now[@]}"; do
    if [ -n "${before[$k]:-}" ] && [ "${now[$k]}" -gt "${before[$k]}" ]; then
      echo "FAIL: $file ($name) -- \"$k\" pinned at ${before[$k]} in $ref, now ${now[$k]}." >&2
      echo "      A ratchet only falls. Fix the code the pin is standing in for; if the" >&2
      echo "      rule itself is wrong, change the rule and say so, do not raise the pin." >&2
      fail=1
    fi
  done

  added=() removed=() unpaired=()
  for k in "${!now[@]}"; do [ -z "${before[$k]:-}" ] && added+=("$k"); done
  for k in "${!before[@]}"; do [ -z "${now[$k]:-}" ] && removed+=("$k"); done

  declare -A claimed=()
  for a in "${added[@]:-}"; do
    [ -z "$a" ] && continue
    paired=""
    for r in "${removed[@]:-}"; do
      [ -z "$r" ] && continue
      [ -n "${claimed[$r]:-}" ] && continue
      if [ "${before[$r]}" = "${now[$a]}" ]; then
        claimed["$r"]=1
        paired="$r"
        break
      fi
    done
    if [ -n "$paired" ]; then
      renames=$((renames + 1))
      echo "ok: $file ($name) -- \"$paired\" -> \"$a\" at ${now[$a]}, read as a rename"
    else
      unpaired+=("$a")
    fi
  done

  if [ "${#unpaired[@]}" -gt 0 ]; then
    declare -A sum_now=() sum_before=()
    for k in "${!now[@]}"; do
      g="${k#*#}"; [ "$g" = "$k" ] && g="_"
      sum_now["$g"]=$(( ${sum_now[$g]:-0} + ${now[$k]} ))
    done
    for k in "${!before[@]}"; do
      g="${k#*#}"; [ "$g" = "$k" ] && g="_"
      sum_before["$g"]=$(( ${sum_before[$g]:-0} + ${before[$k]} ))
    done
    risen_groups=()
    for g in "${!sum_now[@]}"; do
      [ "${sum_now[$g]}" -gt "${sum_before[$g]:-0}" ] && risen_groups+=("$g")
    done
    if [ "${#risen_groups[@]}" -eq 0 ]; then
      echo "ok: $file ($name) -- ${#unpaired[@]} entr(ies) added, total did not rise: a move"
      for a in "${unpaired[@]}"; do echo "      + $a at ${now[$a]}"; done
    else
      echo "FAIL: $file ($name) -- ${#unpaired[@]} new pin(s) AND the total rose:" >&2
      for g in "${risen_groups[@]}"; do
        label="$name"; [ "$g" != "_" ] && label="$g"
        echo "      $label: ${sum_before[$g]:-0} -> ${sum_now[$g]}" >&2
      done
      for a in "${unpaired[@]}"; do echo "      new: $a at ${now[$a]}" >&2 ; done
      echo "      A split that moves existing debt keeps the total flat and passes. A" >&2
      echo "      total that rises is new debt, wherever the line was added." >&2
      fail=1
    fi
    unset sum_now sum_before
  fi

  total_pins=$((total_pins + ${#now[@]}))
  unset now before claimed
done

if [ "$fail" -eq 0 ]; then
  msg="ok: ${#RATCHETS[@]} ratchet(s), $total_pins pin(s), none raised since $ref"
  [ "$renames" -gt 0 ] && msg="$msg ($renames rename(s))"
  echo "$msg"
fi

exit "$fail"
