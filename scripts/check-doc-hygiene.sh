#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0
say() { printf '%s\n' "$*"; }

# The public tree's shape: three doc directories with one job each, the root
# files a repository carries, and the package and fixture READMEs that ship with
# the tree.
allowed='^(AGENTS|CLAUDE|README|CONTRIBUTING|SECURITY|CODE_OF_CONDUCT)\.md$|^docs/README\.md$|^docs/(user|internals|operations)/[^/]+\.md$|^\.github/[^/]+\.md$'
allowed+='|^\.github/triage/PLAYBOOK\.md$|^apps/server/README\.md$|^apps/server/src/orchestration-v2/testkit/fixtures/[^/]+/README\.md$'
allowed+='|^apps/web/src/terminal/ghostty/README\.md$|^apps/web/test/fixtures/usage-limits-hub/README\.md$|^packages/client-runtime/README\.md$'

stray="$(git ls-files -co --exclude-standard '*.md' | grep -vE '/node_modules/|^\.research/|^src-tauri/patches/' | grep -vE "$allowed" || true)"
if [ -n "$stray" ]; then
  fail=1
  say "check-doc-hygiene: Markdown outside the allowed tree (the root files, docs/{user,internals,operations}/, .github/, package and fixture READMEs):"
  say "$stray" | sed 's/^/  /'
  say "  → a plan, a notes file or an agent's scratch file is not committed at all; a durable rule goes in docs/internals/, a task guide in docs/user/, a runbook in docs/operations/"
fi

# .github/triage/PLAYBOOK.md is a prompt kept byte-identical to its source, so it
# carries that source's wording rather than Houston's documentation rules.
mapfile -t docs < <(git ls-files -co --exclude-standard '*.md' | grep -vE '/node_modules/|^\.research/|^src-tauri/patches/|^\.github/triage/PLAYBOOK\.md$')
hit() {
  local out
  out="$(printf '%s\n' "${docs[@]}" | grep -vE "$3" | xargs -r grep -nEi "$2" 2>/dev/null || true)"
  [ -z "$out" ] && return 0
  fail=1
  say "check-doc-hygiene: [$1] $(printf '%s\n' "$out" | wc -l) hit(s) — $4"
  printf '%s\n' "$out" | head -20 | cut -c1-160 | sed 's/^/  /'
}
# Nothing is exempt from these three: the release notes live on GitHub, not in a
# ledger file, so no doc in the tree carries a date or release history.
ledgers='^$'
hit date    '\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b' "$ledgers" 'no dates in docs; describe the current state'
hit phase   '\b(phase|wave|charter|batch|round) *[0-9]|\bstep [0-9]+[a-z]?\b|\bitem [0-9]+\b' "$ledgers" 'no plan/phase/step numbering'
hit diary   '\bparity (pass|work|doctrine|sweep)\b|\bexit report\b|\bdecision diary\b|\breverdict\b|\bruling *[0-9]' "$ledgers" 'no session narrative'
# overview.md carries the one sanctioned attribution to the project Houston began from.
hit product '\b(bridgemind|bridge-mind|bm1|t3 ?code|orca|herdr|overclock)\b' '^docs/internals/overview\.md$' 'no other app names; keep the finding, drop the provenance'
# A bare `.research/` counts, including a prose mention that ends at the slash.
hit pointer '\.research/|IMPLEMENTATION-NOTES-|docs/plans/reverdict|\bthe donor\b' '' 'no pointers into vendored references or deleted plans'

if [ "$fail" -ne 0 ]; then exit 1; fi
say "check-doc-hygiene: ok"
