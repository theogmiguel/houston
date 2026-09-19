#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "[oom-shield] usage: scripts/oom-shield.sh <command> [args...]" >&2
  exit 1
fi

if ! command -v systemd-run >/dev/null 2>&1; then
  echo "[oom-shield] FAIL: systemd-run not found on PATH — cannot shield '$*'." >&2
  echo "              Refusing to run it unshielded (a silent cap is worse than no cap)." >&2
  exit 1
fi

# MemoryMax=12G / MemoryHigh=10G sit ~3x / ~2.5x above the measured 4.1 GiB
# cold-build peak: high enough not to trip a real build, low enough to be a
# tripwire a runaway can actually hit. Left at their defaults deliberately.
MEMORY_HIGH="${OOM_SHIELD_MEMORY_HIGH:-10G}"
MEMORY_MAX="${OOM_SHIELD_MEMORY_MAX:-12G}"
MEMORY_SWAP_MAX="${OOM_SHIELD_MEMORY_SWAP_MAX:-}"

LOCK_FILE="${XDG_RUNTIME_DIR:-/tmp}/oom-shield.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[oom-shield] waiting: another shielded workload holds $LOCK_FILE (D5: never two concurrently)" >&2
  flock 9
fi

UNIT="oom-shield-$$-${RANDOM}${RANDOM}"

echo "[oom-shield] unit=$UNIT MemoryHigh=$MEMORY_HIGH MemoryMax=$MEMORY_MAX nice=19" >&2
echo "[oom-shield] running: $*" >&2

CGROUP_LINE_FILE="$(mktemp)"
PEAK_FILE="$(mktemp)"
trap 'rm -f "$CGROUP_LINE_FILE" "$PEAK_FILE"' EXIT

INNER='
cg="$(sed -n "s/^0::\\(.*\\)\$/\\1/p" /proc/self/cgroup)"
echo "$cg" > "$1"
peakfile="$2"
shift 2
nice -n 19 "$@"
status=$?
if [ -f "/sys/fs/cgroup${cg}/memory.peak" ]; then
  cat "/sys/fs/cgroup${cg}/memory.peak" > "$peakfile" 2>/dev/null || true
fi
exit "$status"
'

SWAP_PROP=()
if [ -n "$MEMORY_SWAP_MAX" ]; then
  SWAP_PROP=(-p "MemorySwapMax=$MEMORY_SWAP_MAX")
fi

set +e
systemd-run --user --scope --quiet \
  -p "MemoryAccounting=yes" \
  -p "MemoryHigh=$MEMORY_HIGH" \
  -p "MemoryMax=$MEMORY_MAX" \
  "${SWAP_PROP[@]}" \
  --unit="$UNIT" \
  -- bash -c "$INNER" _ "$CGROUP_LINE_FILE" "$PEAK_FILE" "$@" 9>&-
status=$?
set -e

cgroup_path=""
peak_line=""
if [ -s "$CGROUP_LINE_FILE" ]; then
  cgroup_rel="$(tr -d '\n' < "$CGROUP_LINE_FILE")"
  if [ -n "$cgroup_rel" ]; then
    cgroup_path="/sys/fs/cgroup${cgroup_rel}"
  fi
fi

peak_report="memory.peak: unavailable (could not derive/verify the cgroup path)"
if [ -n "$cgroup_path" ]; then
  if [ -s "$PEAK_FILE" ]; then
    peak_bytes="$(tr -d '\n' < "$PEAK_FILE")"
    peak_mib="$(LC_NUMERIC=C awk -v b="$peak_bytes" 'BEGIN { printf "%.1f", b / 1048576 }')"
    peak_report="peak memory: ${peak_mib} MiB (from $cgroup_path/memory.peak)"
    peak_line="$peak_mib"
  elif [ -f "$cgroup_path/memory.peak" ]; then
    peak_bytes="$(cat "$cgroup_path/memory.peak" 2>/dev/null || echo "")"
    if [ -n "$peak_bytes" ]; then
      peak_mib="$(LC_NUMERIC=C awk -v b="$peak_bytes" 'BEGIN { printf "%.1f", b / 1048576 }')"
      peak_report="peak memory: ${peak_mib} MiB (from $cgroup_path/memory.peak, read after exit)"
      peak_line="$peak_mib"
    else
      peak_report="memory.peak: not captured from $cgroup_path/memory.peak (file did not exist inside the cgroup — kernel may lack it, or the scope was torn down before this script could read it)"
    fi
  else
    peak_report="memory.peak: not captured from $cgroup_path/memory.peak (file did not exist inside the cgroup — kernel may lack it, or the scope was torn down before this script could read it)"
  fi
fi

cap_note=""
oom_logged=""
if [ "$status" -ne 0 ]; then
  for _ in $(seq 1 10); do
    oom_logged="$(journalctl --user -u "$UNIT.scope" --no-pager 2>/dev/null | grep "Failed with result 'oom-kill'" || true)"
    [ -n "$oom_logged" ] && break
    sleep 0.5
  done
fi
if [ -n "$oom_logged" ]; then
  cap_note=" — OOM-killed by the cgroup's MemoryMax=$MEMORY_MAX cap (systemd logged Result=oom-kill for $UNIT, peak ${peak_line:-unknown} MiB, wrapper exit $status)"
elif [ "$status" -eq 137 ]; then
  cap_note=" — likely OOM-killed by the cgroup's MemoryMax=$MEMORY_MAX cap (SIGKILL exit, peak ${peak_line:-unknown} MiB)"
fi

echo "[oom-shield] unit=$UNIT exit=$status $peak_report$cap_note" >&2

exit "$status"
