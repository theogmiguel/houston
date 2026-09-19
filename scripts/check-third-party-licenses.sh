#!/usr/bin/env bash
set -euo pipefail

# The committed inventory is generated and the generator is deterministic. This
# gate regenerates it beside the committed copy and diffs the two, so a changed
# dependency graph with a stale inventory stops CI; it never writes the file.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

COMMITTED="src-tauri/resources/third-party-licenses.json"
GENERATOR="scripts/gen-third-party-licenses.mjs"

fail() {
  echo "check-third-party-licenses: $*" >&2
  exit 1
}

# The generator walks ui's production closure through node_modules; without the
# install it sees no npm packages at all and would pass a short inventory.
[ -d ui/node_modules ] || fail "ui/node_modules is missing — the generator cannot see the renderer's dependency closure and would inventory a package set that does not ship. Run: cd ui && bun install --frozen-lockfile"

command -v node >/dev/null 2>&1 || fail "node is not on PATH — scripts/gen-third-party-licenses.mjs runs under Node. Install Node and re-run."

[ -f "$COMMITTED" ] || fail "$COMMITTED is missing — regenerate it with \`node scripts/gen-third-party-licenses.mjs\` and commit the result"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

node "$GENERATOR" --out "$tmp"

if diff -q "$tmp" "$COMMITTED" >/dev/null 2>&1; then
  echo "check-third-party-licenses: ok"
  exit 0
fi

# A diff of this file runs to more lines than a CI log should carry, so report
# what changed by shape and hand the reader the one command that fixes it.
diff_out="$(diff "$COMMITTED" "$tmp" || true)"
changed="$(printf '%s\n' "$diff_out" | grep -cE '^[<>]' || true)"
sample="$(printf '%s\n' "$diff_out" | head -20 | cut -c1-160 || true)"

{
  echo "check-third-party-licenses: the committed inventory is stale."
  echo "  A dependency was added, removed or bumped, and $COMMITTED did not follow."
  echo "  $changed lines differ between the committed and regenerated inventory:"
  printf '%s\n' "$sample" | sed 's/^/    /'
  echo "  Regenerate it and commit the result:"
  echo "    node scripts/gen-third-party-licenses.mjs"
  echo "    git add $COMMITTED"
} >&2
exit 1
