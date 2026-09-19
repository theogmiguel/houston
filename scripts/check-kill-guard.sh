#!/usr/bin/env bash

# The kill(2) broadcast guard: an unchecked u32 pid cast to pid_t turned
# u32::MAX into -1 and signalled every process the user owned. Raw kill calls
# are forbidden outside core/houston-core/src/pid.rs; comment lines are exempt.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

fail=0

offenders="$(grep -rn 'libc::kill(' core/ src-tauri/ \
  --include='*.rs' \
  | grep -v '^core/houston-core/src/pid\.rs:' \
  | grep -vE ':[[:space:]]*(//|\*)' \
  || true)"
if [ -n "$offenders" ]; then
  echo "FAIL: raw libc::kill( found outside core/houston-core/src/pid.rs:" >&2
  echo "$offenders" >&2
  echo "      kill(2) never receives an unchecked pid. Route this call through" >&2
  echo "      houston_core::pid (checked_pid / checked_process_group /" >&2
  echo "      signal_process / signal_process_group / signal_process_checked /" >&2
  echo "      process_is_alive / process_comm) instead of calling libc::kill" >&2
  echo "      directly. See core/houston-core/src/pid.rs's module doc comment" >&2
  echo "      for why: a u32 pid cast straight to kill(2)'s signed pid_t can" >&2
  echo "      become a broadcast (kill(-1,..) = every process you may signal," >&2
  echo "      kill(0,..) = your whole process group)." >&2
  fail=1
else
  echo "ok: no raw libc::kill( outside core/houston-core/src/pid.rs"
fi

offenders="$(grep -rln 'nix::sys::signal\|syscall(' core/ src-tauri/ --include='*.rs' || true)"
if [ -n "$offenders" ]; then
  echo "FAIL: an alternate route to the kill(2)/signal(7) syscall was found:" >&2
  echo "$offenders" >&2
  echo "      Route through core/houston-core/src/pid.rs instead." >&2
  fail=1
else
  echo "ok: no nix::sys::signal or direct syscall( route around the guard"
fi

offenders="$(grep -rn 'OpenProcess(\|TerminateProcess(\|taskkill' core/ src-tauri/ ui/ \
  --include='*.rs' \
  | grep -v '^core/houston-core/src/pid\.rs:' \
  | grep -vE ':[[:space:]]*(//|\*)' \
  || true)"
if [ -n "$offenders" ]; then
  echo "FAIL: raw Win32 process call found outside core/houston-core/src/pid.rs:" >&2
  echo "$offenders" >&2
  echo "      OpenProcess/TerminateProcess/taskkill are this platform's kill(2)." >&2
  echo "      Route through houston_core::pid instead -- see pid.rs's module doc" >&2
  echo "     : a recycled or broadcast-equivalent value" >&2
  echo "      must hit the checked_pid gate before any OS call does." >&2
  fail=1
else
  echo "ok: no raw Win32 process calls outside core/houston-core/src/pid.rs"
fi

exit "$fail"
