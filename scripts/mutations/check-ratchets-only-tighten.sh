#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/work/scripts" "$tmp/work/ui"
cp "$root/scripts/check-ratchets-only-tighten.sh" "$tmp/work/scripts/"

cat > "$tmp/work/scripts/check-radius-tokens.sh" <<'EOF'
BASELINE=(
  "ui/src/A.tsx 4"
  "ui/src/B.tsx 2"
)
EOF
for stub in check-control-metrics check-spacing-tokens; do
  printf 'BASELINE=(\n  "ui/src/A.tsx 1"\n)\n' > "$tmp/work/scripts/$stub.sh"
done
printf 'EXEMPT_COUNTS=(\n  "ui/src/A.tsx 1"\n)\n' > "$tmp/work/scripts/check-focus-visible.sh"
cat > "$tmp/work/ui/complexity-baseline.json" <<'EOF'
{
  "max": 20,
  "files": {
    "src/A.tsx": { "count": 1, "worst": 30 }
  }
}
EOF

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

sed -i 's|"ui/src/A.tsx 4"|"ui/src/A.tsx 5"|' scripts/check-radius-tokens.sh
expect fail "a raised bash pin must be refused"

sed -i 's|"ui/src/B.tsx 2"|"ui/src/B.tsx 2"\n  "ui/src/C.tsx 9"|' scripts/check-radius-tokens.sh
expect fail "a brand-new bash pin must be refused"

sed -i 's|"worst": 30|"worst": 31|' ui/complexity-baseline.json
expect fail "a raised json pin must be refused"

sed -i 's|"ui/src/A.tsx 4"|"ui/src/A.tsx 3"|' scripts/check-radius-tokens.sh
expect pass "a lowered pin is the ratchet working"

sed -i 's|^BASELINE=(|BASELINE_RENAMED=(|' scripts/check-radius-tokens.sh
expect fail "a baseline block that no longer parses must be refused"

exit "$fails"
