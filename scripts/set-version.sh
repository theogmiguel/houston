#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# One command writes all six, because six hand edits is five chances to disagree
# and `version-guard` only tells you afterwards, once a tag has already been pushed.
# `--check` performs the same six reads and writes nothing.
usage() {
  cat >&2 <<'EOF'
usage: scripts/set-version.sh <X.Y.Z[-rc.N]>
       scripts/set-version.sh --check <X.Y.Z[-rc.N]>

Writes the version into the four manifests and both lockfiles:
  src-tauri/tauri.conf.json   .version
  src-tauri/Cargo.toml        [package] version
  ui/package.json             .version
  core/Cargo.toml             [workspace.package] version
  core/Cargo.lock             the workspace crates' entries
  src-tauri/Cargo.lock        the workspace crates' entries

With --check it writes nothing: each of the six must already read the version,
or the script names the file that disagrees and exits 1.

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

# The reads below mirror the writes above. An empty read is a failure too: a
# manifest that lost its version line is worse than one carrying the wrong one.
manifest_json_version() {
  jq -r --arg key "$2" '.[$key] // empty' "$1"
}

manifest_toml_version() {
  awk -v table="$2" '
    $0 == "[" table "]" { inside = 1; next }
    inside && /^\[/ { exit }
    inside && /^version[[:space:]]*=/ {
      sub(/^version[[:space:]]*=[[:space:]]*"/, "")
      sub(/".*$/, "")
      print
      exit
    }
  ' "$1"
}

# Every `houston-*` package entry in a lockfile is a workspace crate (the write
# path is `cargo update --workspace`), and each one must carry the version.
lock_versions() {
  awk '
    /^\[\[package\]\]/ { name = ""; next }
    /^name = "/ {
      name = $0; sub(/^name = "/, "", name); sub(/"$/, "", name)
      next
    }
    /^version = "/ && name ~ /^houston-/ {
      version = $0; sub(/^version = "/, "", version); sub(/"$/, "", version)
      print name " " version
    }
  ' "$1"
}

verify_version() {
  expected="$1"
  bad=0

  for file in src-tauri/tauri.conf.json ui/package.json; do
    got="$(manifest_json_version "$file" version)"
    if [ "$got" != "$expected" ]; then
      echo "set-version: $file .version reads \"${got:-<missing>}\", expected \"$expected\"" >&2
      bad=1
    fi
  done

  got="$(manifest_toml_version src-tauri/Cargo.toml package)"
  if [ "$got" != "$expected" ]; then
    echo "set-version: src-tauri/Cargo.toml [package] version reads \"${got:-<missing>}\", expected \"$expected\"" >&2
    bad=1
  fi

  got="$(manifest_toml_version core/Cargo.toml workspace.package)"
  if [ "$got" != "$expected" ]; then
    echo "set-version: core/Cargo.toml [workspace.package] version reads \"${got:-<missing>}\", expected \"$expected\"" >&2
    bad=1
  fi

  for lock in core/Cargo.lock src-tauri/Cargo.lock; do
    entries="$(lock_versions "$lock")"
    if [ -z "$entries" ]; then
      echo "set-version: $lock carries no houston-* package at all; expected the workspace crates at \"$expected\"" >&2
      bad=1
      continue
    fi
    while read -r name got; do
      if [ "$got" != "$expected" ]; then
        echo "set-version: $lock entry $name reads \"$got\", expected \"$expected\"" >&2
        bad=1
      fi
    done <<< "$entries"
  done

  return "$bad"
}

if [ "$check" = "1" ]; then
  verify_version "$version" || exit 1
  echo "set-version --check: the four manifests and both lockfiles all read $version"
  exit 0
fi

python3 - "$version" <<'PY'
import json, re, sys
from pathlib import Path

version = sys.argv[1]
changed = []

def write_json(path, key):
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    doc = json.loads(raw)
    if doc.get(key) == version:
        return
    # Rewrite the one line rather than re-serialising: these files carry comments
    # nowhere but their formatting is hand-kept, and json.dump would reflow them.
    pattern = re.compile(rf'("{key}"\s*:\s*)"[^"]*"')
    new, n = pattern.subn(rf'\g<1>"{version}"', raw, count=1)
    if n != 1:
        sys.exit(f'set-version: {path} has no single "{key}" line to rewrite')
    p.write_text(new, encoding="utf-8")
    changed.append(path)

def write_toml_version(path, table):
    p = Path(path)
    raw = p.read_text(encoding="utf-8")
    # Scoped to the named table: an unscoped first match would hit a `version = `
    # under [workspace.dependencies], which is what version-guard warns about.
    start = raw.find(f"[{table}]")
    if start == -1:
        sys.exit(f"set-version: {path} has no [{table}] table")
    end = raw.find("\n[", start + 1)
    end = len(raw) if end == -1 else end
    section = raw[start:end]
    new_section, n = re.subn(r'(?m)^version\s*=\s*"[^"]*"', f'version = "{version}"', section, count=1)
    if n != 1:
        sys.exit(f"set-version: [{table}] in {path} has no single version line")
    if new_section != section:
        p.write_text(raw[:start] + new_section + raw[end:], encoding="utf-8")
        changed.append(path)

write_json("src-tauri/tauri.conf.json", "version")
write_json("ui/package.json", "version")
write_toml_version("src-tauri/Cargo.toml", "package")
write_toml_version("core/Cargo.toml", "workspace.package")

print("\n".join(changed) if changed else "(manifests already at this version)")
PY

# The lockfiles carry the workspace crates' own versions. `cargo update -w` rewrites
# exactly those entries and touches no dependency, so a version bump never becomes a
# dependency bump by accident.
cargo update --workspace --manifest-path core/Cargo.toml --quiet
cargo update --workspace --manifest-path src-tauri/Cargo.toml --quiet

# The write proves itself: a silent miss in any of the six would otherwise
# surface as a release whose runtime version disagrees with its filename.
verify_version "$version" || exit 1

echo "set-version: every manifest and both lockfiles now read $version"
