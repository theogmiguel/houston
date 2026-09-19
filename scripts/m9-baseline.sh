#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=src-tauri/target/release/houston-tauri
[ -x "$BIN" ] || { echo "no release binary at $BIN -- cargo build --release --features bench" >&2; exit 1; }
export HOUSTON_DAEMON_BIN_DIR="${HOUSTON_DAEMON_BIN_DIR:-$PWD/src-tauri/target/release}"
for side in houston-core houston-supervisor; do
  [ -x "$HOUSTON_DAEMON_BIN_DIR/$side" ] || { echo "no $side at $HOUSTON_DAEMON_BIN_DIR -- stage the release sidecars first (scripts/build-app.sh)" >&2; exit 1; }
done
OUT=$(mktemp -d); RUNS=${RUNS:-5}; CHANNEL=${CHANNEL:-m9bench}
[ "$CHANNEL" = release ] && { echo "refusing: --channel release is the installed app's live state" >&2; exit 1; }
STATE_DIR="$HOME/.houston-$CHANNEL"
export HOUSTON_DISABLE_AUTO_RESTORE=1
export HOUSTON_DISABLE_SWARM_AUTOLAUNCH=1
stop_daemon() {
  local abort_on_failure="$1" json port token pid deadline resp
  json="$STATE_DIR/daemon.json"
  [ -f "$json" ] || return 0
  port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$json")"
  token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$json")"
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$json")"
  [ -n "$port" ] && [ -n "$token" ] || return 0
  resp="$(curl -sS -m 10 -X POST "http://127.0.0.1:$port/manage" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{"manage_version":1,"verb":"daemon_shutdown"}' 2>&1 || true)"
  if ! printf '%s' "$resp" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    echo "failed to stop the $CHANNEL channel's daemon: daemon_shutdown did not report ok:true (response: $resp)" >&2
    [ "$abort_on_failure" = 1 ] && exit 1
    return 1
  fi
  if [ -n "$pid" ]; then
    deadline=$((SECONDS + 10))
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "failed to stop the $CHANNEL channel's daemon: pid $pid still alive 10s after daemon_shutdown reported ok:true" >&2
        [ "$abort_on_failure" = 1 ] && exit 1
        return 1
      fi
      sleep 0.25
    done
  fi
}
stop_channel_daemon() { stop_daemon 1; }
trap 'stop_daemon 0' EXIT
wipe_channel() {
  [ "$CHANNEL" = m9bench ] || return 0
  [ -e "$STATE_DIR" ] || return 0
  stop_channel_daemon
  if [ -e "$STATE_DIR/daemon.lock" ] && ! flock -n "$STATE_DIR/daemon.lock" true 2>/dev/null; then
    echo "refusing to wipe $STATE_DIR: a live daemon holds daemon.lock" >&2
    exit 1
  fi
  rm -rf -- "$STATE_DIR"
}
seed_workspace() {
  [ "$CHANNEL" = m9bench ] || return 0
  mkdir -p "$STATE_DIR/bench-workspace"
  python3 - "$STATE_DIR" <<'PYSEED'
import sqlite3, sys
state = sys.argv[1]
db = sqlite3.connect(state + "/houston.db")
db.execute("CREATE TABLE IF NOT EXISTS workspaces (path TEXT PRIMARY KEY, name TEXT NOT NULL, added_at INTEGER NOT NULL)")
db.execute("INSERT OR REPLACE INTO workspaces (path, name, added_at) VALUES (?, 'm9bench', strftime('%s','now'))",
           (state + "/bench-workspace",))
db.commit(); db.close()
PYSEED
}
echo "channel=$CHANNEL runs=$RUNS burst-budget=${TR_BENCH_WRITE_BURST_MS:-default} state-dir wiped per run: $([ "$CHANNEL" = m9bench ] && echo yes || echo "NO (non-default channel is never wiped)")"
echo "results dir: $OUT"
for i in $(seq 1 "$RUNS"); do
  echo "── run $i/$RUNS ────────────────────────────────"
  wipe_channel
  seed_workspace
  TR_BENCH_RESULTS_PATH="$OUT/m9-$i.json" "$BIN" --channel "$CHANNEL" --bench=M9 2>&1 \
    | grep -E 'M9: (frames|FLOOR)' || true
done
python3 - "$OUT" "$RUNS" <<'PY'
import json, statistics, sys, pathlib
out, runs = pathlib.Path(sys.argv[1]), int(sys.argv[2])
valid, void = [], []
for i in range(1, runs + 1):
    f = out / f"m9-{i}.json"
    if not f.exists():
        void.append((i, "no results file")); continue
    d = json.loads(f.read_text()); m = d.get("m9") or d
    bad = [k for k in ("allFloodsExited", "engineAttached") if not m.get(k)]
    # windowFocused is informational: Wayland gives a script no
    # compositor-side activation, so a bench window often never gains real
    # focus while painting. renderUnthrottled measures the rAF cadence.
    ru = m.get("renderUnthrottled") or {}
    if not ru.get("valid"):
        bad.append("renderUnthrottled (%.1fHz)" % ru.get("hz", 0))
    (void.append((i, "not " + ", not ".join(bad))) if bad else valid.append((i, m)))
dirty = [(i, m["preExistingPanes"]) for i, m in valid if m.get("preExistingPanes")]
print()
print(f"valid runs: {len(valid)}/{runs}")
for i, why in void:
    print(f"  run {i}: VOID -- {why}")
if not valid:
    print("\nNo valid run. Nothing to compare; the gate is still unrun."); sys.exit(1)
if dirty:
    print("\nABORT: the grid was not clean, so these runs are not comparable to")
    print("§9.5's baseline and a median over them would be meaningless.")
    for i, n in dirty:
        print(f"  run {i}: preExistingPanes={n} -- the flood measured {n + 12} panes, not 12")
    print("\nThe state dir is wiped before every run, so these panes were created")
    print("DURING the run by something this script does not control.")
    sys.exit(2)
def med(f): return statistics.median(f(m) for _, m in valid)
def rng(f):
    v = sorted(f(m) for _, m in valid); return f"{v[0]:g}-{v[-1]:g}"
print(f"""
                      this build        §9.5 ghostty baseline
p50 median            {med(lambda m: m['frame']['p50Ms']):>6.0f} ms          68 ms
p95 median            {med(lambda m: m['frame']['p95Ms']):>6.0f} ms         243 ms   (floor 450)
p95 range             {rng(lambda m: m['frame']['p95Ms']):>9} ms     231-299 ms
frame samples         {rng(lambda m: m['frame']['samples']):>9}
flood drain           {med(lambda m: m['floodDurationMs'])/1000:>6.2f} s        7.1-8.1 s
RSS peak              {med(lambda m: m['rssMib']['peak']):>6.0f} MiB       429-444 MiB
parse                 {med(lambda m: m['ghosttyPaint']['parseMsPerMiB']):>6.1f} ms/MiB    31.5-32.6 ms/MiB
parse calls           {rng(lambda m: m['ghosttyPaint']['parseCalls']):>9}
KB per parse call     {med(lambda m: m['ghosttyPaint']['parseBytes']/m['ghosttyPaint']['parseCalls']/1024):>6.0f} KB
ms blocked per call   {med(lambda m: m['ghosttyPaint']['parseMs']/m['ghosttyPaint']['parseCalls']):>6.2f} ms       budget is 8 ms -- see below
pre-existing panes    {rng(lambda m: m['preExistingPanes']):>9}          (aborts above if not 0)
ws gap frames         {rng(lambda m: (m.get('wsGap') or {}).get('gaps', 0)):>9}          P7: a drop is a gap, never silent
ws reattaches         {rng(lambda m: (m.get('wsGap') or {}).get('reattaches', 0)):>9}

NOTE: §9.5's own runs carried 2 pre-existing panes (their saved JSONs record
preExistingPanes=2 -- a 14-pane grid), so this clean 12-pane grid is slightly
FAVORABLE vs the baseline column. That is fine for the 450 ms regression
floor; a marginal comparison against the 243 ms number itself would need
§9.5's side re-run on this channel first.""")
per_call = med(lambda m: m['ghosttyPaint']['parseMs'] / m['ghosttyPaint']['parseCalls'])
print(f"\nAt {per_call:.2f} ms of blocking per parse call, the 8 ms budget lets "
      f"{8 / per_call:.1f} call(s) run per\nevent-loop turn. Near 1.0 means it degenerates to "
      "a yield per chunk (charter §13.8's\nrejected shape); much above ~4 means the tail is "
      "back to being unbounded.")
p95 = med(lambda m: m['frame']['p95Ms'])
print(f"\nVERDICT: p95 median {p95:.0f} ms vs floor 450 ms -- "
      + ("PASS" if p95 <= 450 else "FAIL"))
PY
echo; echo "raw JSON in $OUT"
