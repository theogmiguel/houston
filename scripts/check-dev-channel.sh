#!/usr/bin/env bash
set -euo pipefail

# NEVER run this against a real $HOME: every dev.sh call below runs with HOME
# pointed at a throwaway sandbox so a pre-fix script cannot reach a live state
# dir or kill a real daemon. Cleaned up on exit; no rm -rf, only rm -r.

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV_SH="${DEV_SH:-$repo_root/scripts/dev.sh}"

SANDBOX_HOME="$(mktemp -d)"
cleanup() {
  rm -r "$SANDBOX_HOME" 2>/dev/null || true
}
trap cleanup EXIT

TIMEOUT_S=20

fail=0

run_and_check() {
  local label="$1" expected_channel="$2" expected_state_dir="$3"
  shift 3
  local out
  local rc=0
  out="$(HOME="$SANDBOX_HOME" timeout "$TIMEOUT_S" "$@" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if [ "$rc" = 124 ]; then
      echo "FAIL: $label — $DEV_SH did not exit within ${TIMEOUT_S}s (timed out)." >&2
      echo "      This usually means --print-target fell through to a real build/spawn." >&2
    else
      echo "FAIL: $label — $DEV_SH exited non-zero. Output:" >&2
      echo "$out" >&2
    fi
    fail=1
    return
  fi
  local line
  line="$(printf '%s\n' "$out" | grep -E '^\[dev\] --print-target:' || true)"
  if [ -z "$line" ]; then
    echo "FAIL: $label — no '[dev] --print-target:' line in output. Got:" >&2
    echo "$out" >&2
    fail=1
    return
  fi
  local got_channel got_state_dir
  got_channel="$(printf '%s\n' "$line" | sed -E 's/.*channel=([^ ]+).*/\1/')"
  got_state_dir="$(printf '%s\n' "$line" | sed -E 's/.*state_dir=(.*)$/\1/')"
  if [ "$got_channel" != "$expected_channel" ]; then
    echo "FAIL: $label — expected channel '$expected_channel', got '$got_channel'." >&2
    echo "      Full line: $line" >&2
    fail=1
  else
    echo "ok: $label — channel=$got_channel"
  fi
  if [ -n "$expected_state_dir" ] && [ "$got_state_dir" != "$expected_state_dir" ]; then
    echo "FAIL: $label — expected state dir '$expected_state_dir', got '$got_state_dir'." >&2
    fail=1
  fi
}

expect_rejected() {
  local label="$1" needle="$2"
  shift 2
  local out
  if out="$(HOME="$SANDBOX_HOME" timeout "$TIMEOUT_S" "$@" 2>&1)"; then
    echo "FAIL: $label — expected non-zero exit, got success. Output:" >&2
    echo "$out" >&2
    fail=1
    return
  fi
  local rc=$?
  if [ "$rc" = 124 ]; then
    echo "FAIL: $label — $DEV_SH did not exit within ${TIMEOUT_S}s (timed out)." >&2
    fail=1
    return
  fi
  if printf '%s\n' "$out" | grep -qF -- "$needle"; then
    echo "ok: $label — rejected and named '$needle'"
  else
    echo "FAIL: $label — rejected, but error did not name '$needle'. Got:" >&2
    echo "$out" >&2
    fail=1
  fi
}

run_and_check "inherited release, no flag" "dev" "$SANDBOX_HOME/.houston-dev" \
  env HOUSTON_CHANNEL=release "$DEV_SH" --print-target

run_and_check "inherited dev, no flag" "dev" "$SANDBOX_HOME/.houston-dev" \
  env HOUSTON_CHANNEL=dev "$DEV_SH" --print-target

run_and_check "no variable, no flag" "dev" "$SANDBOX_HOME/.houston-dev" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --print-target

run_and_check "--channel release" "release" "$SANDBOX_HOME/.houston" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --channel release --print-target

run_and_check "--channel release --fresh --print-target" "release" "$SANDBOX_HOME/.houston" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --channel release --fresh --print-target

run_and_check "--fresh --channel release --print-target" "release" "$SANDBOX_HOME/.houston" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --fresh --channel release --print-target

unknown_out_file="$(mktemp)"
if HOME="$SANDBOX_HOME" timeout "$TIMEOUT_S" env -u HOUSTON_CHANNEL "$DEV_SH" --bogus-flag --print-target >"$unknown_out_file" 2>&1; then
  echo "FAIL: unknown flag '--bogus-flag' did not exit non-zero." >&2
  fail=1
else
  if grep -q -- '--bogus-flag' "$unknown_out_file"; then
    echo "ok: unknown flag rejected, and named in the error"
  else
    echo "FAIL: unknown flag rejected, but the error did not name '--bogus-flag'. Got:" >&2
    cat "$unknown_out_file" >&2
    fail=1
  fi
fi
rm -f "$unknown_out_file"

expect_rejected "--channel traversal attempt" "x/../.houston" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --channel 'x/../.houston' --print-target

expect_rejected "--channel uppercase name" "RELEASE" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --channel 'RELEASE' --print-target

expect_rejected "--channel empty value" "empty" \
  env -u HOUSTON_CHANNEL "$DEV_SH" --channel '' --print-target

expect_rejected "--fresh from its own channel" "refusing --fresh" \
  env HOUSTON_CHANNEL=dev HOUSTON_SESSION=7 "$DEV_SH" --fresh

sandbox_contents="$(find "$SANDBOX_HOME" -mindepth 1 2>/dev/null || true)"
if [ -n "$sandbox_contents" ]; then
  echo "FAIL: --print-target had side effects — sandbox home is not empty:" >&2
  echo "$sandbox_contents" >&2
  fail=1
else
  echo "ok: --print-target left the sandbox home untouched (no mkdir/daemon.json/build/spawn)"
fi

if ! python3 - "$DEV_SH" "$SANDBOX_HOME" <<'PY'
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

source, sandbox = map(Path, sys.argv[1:])
repo = sandbox / "checkout"
for directory in ("scripts", "ui", "core", "src-tauri/target/debug", "mock-bin"):
    (repo / directory).mkdir(parents=True, exist_ok=True)
shutil.copyfile(source, repo / "scripts/dev.sh")
state = sandbox / ".houston-dev"
state.mkdir()
discovery = state / "daemon.json"
log = sandbox / "build-log"

mock = '''#!/usr/bin/env python3
import os
from pathlib import Path
import sys
name = Path(sys.argv[0]).name
state = Path(os.environ["HOME"]) / ".houston-dev/daemon.json"
if name == "houston-tauri":
    assert not state.exists(), "fresh cleanup must finish before app launch"
else:
    assert state.exists(), "fresh replaced daemon state before builds completed"
with Path(os.environ["DEV_TEST_LOG"]).open("a") as f:
    f.write(name + " " + " ".join(sys.argv[1:]) + "\\n")
if name == "bun" and os.environ.get("DEV_TEST_FAIL_BUILD"):
    sys.exit(23)
'''
for name in ("mock-bin/bun", "mock-bin/cargo", "src-tauri/target/debug/houston-tauri"):
    path = repo / name
    path.write_text(mock)
    path.chmod(0o755)

env = dict(os.environ, HOME=str(sandbox), HOUSTON_CHANNEL="release",
           PATH=str(repo / "mock-bin") + os.pathsep + os.environ["PATH"],
           DEV_TEST_LOG=str(log))
for fails in (False, True):
    # A stale discovery file needs no process, port or real daemon.
    discovery.write_text(json.dumps({"protocol": 112}))
    log.write_text("")
    env["DEV_TEST_FAIL_BUILD"] = "1" if fails else ""
    result = subprocess.run(["bash", str(repo / "scripts/dev.sh"), "--fresh"],
                            env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == (23 if fails else 0), result.stdout + result.stderr
    calls = log.read_text().splitlines()
    if fails:
        assert discovery.exists() and calls == ["bun run build"], calls
    else:
        assert calls == [
            "bun run build",
            "cargo build --bin houston-core --bin houston-supervisor --bin tr-helper",
            "cargo build",
            "houston-tauri --channel dev",
        ], calls
print("ok: fresh builds all sidecars before replacement; failed builds preserve daemon state")
PY
then
  fail=1
fi

exit "$fail"
