#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=src-tauri/target/release/houston-tauri
[ -x "$BIN" ] || { echo "no release binary at $BIN -- cargo build --release --features bench" >&2; exit 1; }
export HOUSTON_DAEMON_BIN_DIR="${HOUSTON_DAEMON_BIN_DIR:-$PWD/src-tauri/target/release}"
for side in houston-core houston-supervisor; do
  [ -x "$HOUSTON_DAEMON_BIN_DIR/$side" ] || { echo "no $side at $HOUSTON_DAEMON_BIN_DIR -- stage the release sidecars first (scripts/build-app.sh)" >&2; exit 1; }
done
OUT=$(mktemp -d); RUNS=${RUNS:-3}; CHANNEL=${CHANNEL:-m9bench}
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
VARIANTS=${VARIANTS:-attached hibernate hibernate-snapshot}
echo "channel=$CHANNEL runs=$RUNS per policy, interleaved: $VARIANTS"
echo "results dir: $OUT"
for i in $(seq 1 "$RUNS"); do
  for policy in $VARIANTS; do
    echo "── run $i/$RUNS $policy ─────────────────────────"
    wipe_channel
    seed_workspace
    TR_BENCH_HIDDEN_POLICY="$policy" TR_BENCH_RESULTS_PATH="$OUT/m12-$policy-$i.json" \
      "$BIN" --channel "$CHANNEL" --bench=M12 2>&1 | grep -E 'M12 |BENCH FAILED|Cannot attach|houston-tauri: .*(fail|refus|error)' || true
  done
done
python3 - "$OUT" "$RUNS" $VARIANTS <<'PY2'
import json, statistics, sys, pathlib
out, runs, variants = pathlib.Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
by = {}
for policy in variants:
    for i in range(1, runs + 1):
        f = out / f"m12-{policy}-{i}.json"
        if not f.exists():
            print(f"{policy} run {i}: VOID -- no results file"); continue
        m = json.loads(f.read_text()).get("m12") or {}
        why = []
        if m.get("preExistingPanes"): why.append(f"preExistingPanes={m['preExistingPanes']}")
        if not (m.get("renderUnthrottled") or {}).get("valid"): why.append("render throttled (window hidden or unfocused)")
        if not m.get("rounds"): why.append("no rounds")
        if why:
            print(f"{policy} run {i}: VOID -- " + ", ".join(why)); continue
        for r in m["rounds"]:
            by.setdefault((r["floodMiB"], policy), []).append(r)
def med(rs, f):
    vals = [f(r) for r in rs if f(r) is not None]
    return statistics.median(vals) if vals else float("nan")
print()
print(f"{'MiB':>3} {'policy':<18} {'n':>1} {'hidParse':>9} {'flood p95':>9} {'reveal p50':>10} {'max':>6} {'revFr p95':>9} "
      f"{'blank':>5} {'interm':>6} {'skel':>4} {'complete':>8} {'minKept':>8} {'gaps':>4} {'corr':>4}")
for (mib, policy) in sorted(by, key=lambda k: (k[0], variants.index(k[1]))):
    rs = by[(mib, policy)]
    print(f"{mib:>3} {policy:<18} {len(rs):>1} "
          f"{med(rs, lambda r: r['hiddenParse']['ms']):>7.0f}ms "
          f"{med(rs, lambda r: r['floodFrame']['p95Ms']):>7.0f}ms "
          f"{med(rs, lambda r: r['reveal']['p50Ms']):>8.0f}ms "
          f"{med(rs, lambda r: r['reveal']['maxMs']):>4.0f}ms "
          f"{med(rs, lambda r: r['reveal']['frameP95Ms']):>7.0f}ms "
          f"{med(rs, lambda r: r['reveal']['blankPaints']):>5.0f} "
          f"{med(rs, lambda r: r['reveal']['intermediatePaints']):>6.0f} "
          f"{med(rs, lambda r: r['reveal']['panesWithSkeleton']):>4.0f} "
          f"{med(rs, lambda r: r['content']['panesComplete']):>5.0f}/{rs[0]['hiddenPanes']:<2} "
          f"{med(rs, lambda r: r['content']['minRetainedLines']):>8.0f} "
          f"{max(r['content']['gaps'] for r in rs):>4} {max(r['content']['corrupt'] for r in rs):>4}")
print("""
hidParse: client parse time while the 11 panes were hidden (process-wide).
reveal: collapse keypress -> each pane painted its final line. revFr: frame interval
during the reveal. blank/interm: paints that showed an empty or not-yet-final screen.
skel: panes that dropped to the loading skeleton. minKept: fewest flood lines left in
a pane's buffer (the scrollback setting caps both policies). gaps/corr: worst run.""")
PY2
echo; echo "raw JSON in $OUT"
