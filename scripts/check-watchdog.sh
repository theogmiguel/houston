#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/src-tauri"

fail=0

if cargo tree -e features -i tauri 2>/dev/null | grep -qE '^\S*\s*tauri feature "tracing"'; then
  echo "FAIL: tauri's \`tracing\` feature is enabled somewhere in the tree." >&2
  echo "      It makes eval_script_with_callback block the watchdog's supervisor" >&2
  echo "      thread on the event loop. Find the enabler with:" >&2
  echo "        cargo tree -e features -i tauri | grep -B5 'feature \"tracing\"'" >&2
  fail=1
else
  echo "ok: tauri \`tracing\` feature is off (probes stay non-blocking)"
fi

offenders="$(grep -rln 'SystemTime' src/watchdog/ | grep -v 'src/watchdog/clocks.rs' || true)"
if [ -n "$offenders" ]; then
  echo "FAIL: SystemTime used outside src/watchdog/clocks.rs:" >&2
  echo "$offenders" >&2
  echo "      Every watchdog deadline must be monotonic (spec §4)." >&2
  fail=1
else
  echo "ok: wall clock confined to clocks.rs (deadlines stay monotonic)"
fi

blocking="$(grep -nE 'self\.window\.(is_visible|is_minimized|is_focused|scale_factor|inner_position|outer_position|inner_size|outer_size)\(' src/watchdog/*.rs || true)"
if [ -n "$blocking" ]; then
  echo "FAIL: blocking window getter called from the supervisor thread:" >&2
  echo "$blocking" >&2
  echo "      Move it inside the run_on_main_thread closure in poll_platform." >&2
  fail=1
else
  echo "ok: no blocking window getter off the main thread"
fi

exit "$fail"
