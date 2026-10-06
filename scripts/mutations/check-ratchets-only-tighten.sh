#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/work/scripts" "$tmp/work/ui"
cp "$root/scripts/check-ratchets-only-tighten.sh" "$tmp/work/scripts/"
cat > "$tmp/work/ui/complexity-baseline.json" <<'JSON'
{
  "max": 20,
  "files": {
    "src/A.tsx": { "count": 1, "worst": 30 },
    "src/B.tsx": { "count": 1, "worst": 25 }
  }
}
JSON

cd "$tmp/work"
git init -q .
git add -A
git -c user.email=mutation@local -c user.name=mutation commit -q -m pins --no-verify
# Never copy the scratch repo's .git: on newer Git a detached
# `git maintenance --auto` can remove .git/objects/maintenance.lock mid-`cp`,
# aborting the mutation. The pristine copy restores only scripts/ and ui/.
mkdir -p "$tmp/pristine"
cp -r "$tmp/work/scripts" "$tmp/work/ui" "$tmp/pristine/"

fails=0
if ! env -u GITHUB_BASE_REF GITHUB_EVENT_NAME=push \
  bash scripts/check-ratchets-only-tighten.sh >/dev/null 2>&1; then
  echo "check-ratchets-only-tighten: a root commit must establish the first baseline" >&2
  fails=1
fi
if bash scripts/check-ratchets-only-tighten.sh missing-ref >/dev/null 2>&1; then
  echo "check-ratchets-only-tighten: an explicit missing ref must still fail" >&2
  fails=1
fi

expect() {
  local want="$1" label="$2" got=pass
  bash scripts/check-ratchets-only-tighten.sh HEAD >/dev/null 2>&1 || got=fail
  if [ "$got" != "$want" ]; then
    echo "check-ratchets-only-tighten: $label -- wanted $want, got $got" >&2
    fails=1
  fi
  cp -rf "$tmp/pristine/scripts" "$tmp/pristine/ui" "$tmp/work/"
}

sed -i 's|"worst": 30|"worst": 31|' ui/complexity-baseline.json
expect fail "a raised pin must be refused"

sed -i 's|"src/B.tsx": { "count": 1, "worst": 25 }|"src/B.tsx": { "count": 1, "worst": 25 },\n    "src/C.tsx": { "count": 1, "worst": 40 }|' ui/complexity-baseline.json
expect fail "a brand-new pin must be refused"

sed -i 's|"src/B.tsx"|"src/D.tsx"|' ui/complexity-baseline.json
expect pass "a rename that keeps the value is a move"

sed -i 's|"worst": 30|"worst": 29|' ui/complexity-baseline.json
expect pass "a lowered pin is the ratchet working"

sed -i 's|"files": {|"modules": {|' ui/complexity-baseline.json
expect fail "a baseline block that no longer parses must be refused"

rm ui/complexity-baseline.json
expect fail "a listed ratchet whose baseline is gone must be refused"

exit "$fails"
