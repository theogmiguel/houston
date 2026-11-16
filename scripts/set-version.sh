#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# One command writes all three, because three hand edits is two chances to disagree
# and `version-guard` only tells you afterwards, once a tag has already been pushed.
# `--check` performs the same three reads and writes nothing.
usage() {
  cat >&2 <<'EOF'
usage: scripts/set-version.sh <X.Y.Z[-rc.N]>
       scripts/set-version.sh --check <X.Y.Z[-rc.N]>

Writes the version into the three manifests:
  apps/desktop/package.json   .version
  apps/server/package.json    .version
  apps/web/package.json       .version

With --check it writes nothing: each of the three must already read the version,
or the script names the file that disagrees and exits 1.

The native crates under apps/desktop/native and native keep their own independent
versions and lockfiles; they do not ship under the release version.

It writes nothing else: no tag, no commit, no release notes.
EOF
  exit 2
}

check=0
case "${1:-}" in
  --check) check=1; shift ;;
  -h | --help | "") usage ;;
  -*) echo "set-version: unknown flag '$1'. Accepted: --check" >&2; usage ;;
esac
[ $# -eq 1 ] || usage
version="$1"

# Semver under 0.x plus the rc series the cut-release workflow produces. A typo
# here becomes a tag, and a tag is the one act in this repo nothing can undo.
if ! printf '%s' "$version" | grep -qE '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.[1-9][0-9]*)?$'; then
  echo "set-version: \"$version\" is not a version this repo can carry." >&2
  echo "  expected X.Y.Z or X.Y.Z-rc.N, each component a number with no leading zero" >&2
  exit 1
fi

manifest_json_version() {
  jq -r --arg key "$2" '.[$key] // empty' "$1"
}

verify_version() {
  expected="$1"
  bad=0

  for file in apps/desktop/package.json apps/server/package.json apps/web/package.json; do
    got="$(manifest_json_version "$file" version)"
    if [ "$got" != "$expected" ]; then
      echo "set-version: $file .version reads \"${got:-<missing>}\", expected \"$expected\"" >&2
      bad=1
    fi
  done

  return "$bad"
}

if [ "$check" = "1" ]; then
  verify_version "$version" || exit 1
  echo "set-version --check: the three manifests all read $version"
  exit 0
fi

python3 - "$version" <<'PY'
import json, re, sys
from pathlib import Path

version = sys.argv[1]
changed = []

def write_json(path):
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    doc = json.loads(raw)
    if doc.get("version") == version:
        return
    # Rewrite the one line rather than re-serialising: these files' formatting is
    # hand-kept, and json.dump would reflow them.
    pattern = re.compile(r'("version"\s*:\s*)"[^"]*"')
    new, n = pattern.subn(rf'\g<1>"{version}"', raw, count=1)
    if n != 1:
        sys.exit(f'set-version: {path} has no single "version" line to rewrite')
    p.write_text(new, encoding="utf-8")
    changed.append(path)

for path in ("apps/desktop/package.json", "apps/server/package.json", "apps/web/package.json"):
    write_json(path)

print("\n".join(changed) if changed else "(manifests already at this version)")
PY

# The write proves itself: a silent miss in any of the three would otherwise
# surface as a release whose runtime version disagrees with its filename.
verify_version "$version" || exit 1

echo "set-version: every manifest now reads $version"
