#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# MIN_COVERED is an inverse ratchet: it is the number of checks that had a
# mutation when this landed and only ever grows. Lowering it is a withdrawal
# that belongs in the commit message.
MIN_COVERED=6

mapfile -t checks < <(
  {
    find scripts -maxdepth 1 -name 'check-*.sh' -printf '%f\n' | sed 's/\.sh$//'
    echo "check-complexity"
  } | sort -u
)

covered=() uncovered=() failed=()

for check in "${checks[@]}"; do
  [ "$check" = "check-mutations" ] && continue
  mutation="scripts/mutations/$check.sh"
  if [ ! -f "$mutation" ]; then
    uncovered+=("$check")
    continue
  fi
  covered+=("$check")
  if ! output="$(bash "$mutation" 2>&1)"; then
    failed+=("$check")
    echo "FAIL: $check's mutation did not confirm the check fires." >&2
    echo "      $mutation planted a violation and the check either passed anyway" >&2
    echo "      or failed without naming it. A guard that does not fire on its own" >&2
    echo "      fixture is guarding nothing." >&2
    [ -n "$output" ] && sed 's/^/        /' <<< "$output" >&2
  fi
done

fail=0

if [ "${#failed[@]}" -gt 0 ]; then
  fail=1
else
  echo "ok: ${#covered[@]} mutation(s) confirmed their check fires"
fi

if [ "${#covered[@]}" -lt "$MIN_COVERED" ]; then
  echo "FAIL: ${#covered[@]} check(s) have a mutation, MIN_COVERED requires $MIN_COVERED." >&2
  echo "      Coverage only grows. A mutation was deleted, or a covered check was" >&2
  echo "      renamed without its mutation following it." >&2
  fail=1
elif [ "${#covered[@]}" -gt "$MIN_COVERED" ]; then
  echo "FAIL: ${#covered[@]} check(s) have a mutation but MIN_COVERED still says $MIN_COVERED." >&2
  echo "      Raise it to ${#covered[@]} — an inverse ratchet that is not tightened" >&2
  echo "      stops being one." >&2
  fail=1
fi

if [ "${#uncovered[@]}" -gt 0 ]; then
  echo "note: ${#uncovered[@]} check(s) have no mutation yet, so nothing proves they fire:"
  printf '      %s\n' "${uncovered[@]}"
fi

exit "$fail"
