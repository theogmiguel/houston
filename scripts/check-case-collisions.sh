#!/usr/bin/env bash
# Windows and macOS resolve paths case-insensitively, so two tracked paths that differ only in
# letter case resolve to one file there. Extensionless module imports widen this: `Foo.tsx` and
# `foo.ts` in one directory are both `./foo` to the resolver, and the build breaks.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

offenders="$(
  git ls-files \
    | sed -E 's/\.(tsx|ts|jsx|js|mjs|cjs)$//' \
    | sort -u \
    | awk '{ key = tolower($0); seen[key] = seen[key] ? seen[key] "\n  " $0 : "  " $0; n[key]++ }
           END { for (k in n) if (n[k] > 1) print seen[k] }'
)"

if [[ -n "$offenders" ]]; then
  echo "check-case-collisions: these paths differ only in letter case (module extension ignored):" >&2
  echo "$offenders" >&2
  echo "expected: every tracked path, and every module path without its extension, unique ignoring case" >&2
  exit 1
fi

echo "check-case-collisions: ok"
