#!/usr/bin/env bash

# Direct process-environment access only goes down; daemon code reads it through HostEnv.
# Counts: scripts/env-ratchet.baseline. Sanctioned readers: host_env.rs, tests/common/mod.rs.
# Grep, not only clippy: a blanket `allow(clippy::disallowed_methods)` hides new calls.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

baseline="scripts/env-ratchet.baseline"
pattern='std::env::(var|var_os|vars|vars_os|set_var|remove_var)\b|dirs::home_dir\(|home_dir::home_dir\('

counts() {
  grep -rEc "$pattern" --include='*.rs' core/houston-core/src core/houston-core/tests \
    | grep -v ':0$' \
    | grep -v -e '^core/houston-core/src/host_env.rs:' -e '^core/houston-core/tests/common/mod.rs:' \
    | sed -E 's/^(.*):([0-9]+)$/\2 \1/' \
    | LC_ALL=C sort -k2
}

current="$(counts)"

if [ "${1:-}" = "--update" ]; then
  printf '%s\n' "$current" > "$baseline"
  echo "wrote $baseline ($(wc -l < "$baseline") files, $(awk '{s+=$1} END{print s+0}' "$baseline") call sites)"
  exit 0
fi

if [ ! -f "$baseline" ]; then
  echo "FAIL: $baseline is missing; run scripts/check-env-ratchet.sh --update." >&2
  exit 1
fi

fail=0
while read -r n path; do
  [ -n "$path" ] || continue
  was="$(awk -v p="$path" '$2 == p {print $1}' "$baseline")"
  if [ -z "$was" ]; then
    echo "FAIL: $path reads the process environment $n time(s) and is not in the baseline." >&2
    echo "      Use HostEnv (core/houston-core/src/host_env.rs) instead." >&2
    fail=1
  elif [ "$n" -gt "$was" ]; then
    echo "FAIL: $path: $n direct environment accesses, baseline $was." >&2
    echo "      Use HostEnv instead of std::env; the ratchet may only go down." >&2
    fail=1
  elif [ "$n" -lt "$was" ]; then
    echo "FAIL: $path: $n direct environment accesses, baseline $was (stale)." >&2
    echo "      Lower the baseline: scripts/check-env-ratchet.sh --update." >&2
    fail=1
  fi
done <<< "$current"

while read -r was path; do
  [ -n "$path" ] || continue
  if ! grep -qF " $path" <<< "$current"; then
    echo "FAIL: $path no longer reads the environment directly but is still in the baseline." >&2
    echo "      Lower the baseline: scripts/check-env-ratchet.sh --update." >&2
    fail=1
  fi
done < "$baseline"

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "ok: $(awk '{s+=$1} END{print s+0}' "$baseline") direct environment accesses in $(wc -l < "$baseline") files, none added"
