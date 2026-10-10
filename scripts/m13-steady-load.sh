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
# Each variant is POLICY@BACKGROUND_PAINT_MS; "default" keeps the built-in interval.
VARIANTS=${VARIANTS:-attached@0 attached@default hibernate-snapshot@default}
echo "channel=$CHANNEL runs=$RUNS per variant, interleaved: $VARIANTS"
echo "results dir: $OUT"
# Samples CPU ticks of the app's process tree and the channel's daemon and supervisor
# (PIDs from their own discovery files) until the app exits.
sample_cpu() {
  python3 -I - "$1" "$STATE_DIR" "$2" <<'PYS'
import json, os, sys, time
app, state, out = int(sys.argv[1]), sys.argv[2], sys.argv[3]
def children(pid):
    kids = []
    try:
        for tid in os.listdir(f"/proc/{pid}/task"):
            with open(f"/proc/{pid}/task/{tid}/children") as f:
                kids += [int(x) for x in f.read().split()]
    except OSError:
        pass
    return kids
def tree(root, stop):
    seen, todo = [], [root]
    while todo:
        p = todo.pop()
        if p in seen or p in stop: continue
        seen.append(p); todo += children(p)
    return seen
def stat(pid):
    try:
        with open(f"/proc/{pid}/stat") as f:
            raw = f.read()
    except OSError:
        return None
    comm = raw[raw.index("(") + 1:raw.rindex(")")]
    fields = raw[raw.rindex(")") + 2:].split()
    return comm, int(fields[11]) + int(fields[12])
def discovered(name):
    try:
        with open(os.path.join(state, name)) as f:
            return int(json.load(f)["pid"])
    except (OSError, ValueError, KeyError):
        return None
with open(out, "w") as f:
    while os.path.exists(f"/proc/{app}"):
        procs = {}
        owned = {r: discovered(n) for r, n in (("daemon", "daemon.json"), ("supervisor", "supervisor.json"))}
        # The daemon's subtree is the shells and load generators, not Houston's cost.
        for pid in tree(app, set(owned.values())):
            s = stat(pid)
            if s: procs[pid] = ["app" if pid == app else ("webkit" if s[0].startswith("WebKitWeb") else "app-child"), s[0], s[1]]
        for role, pid in owned.items():
            s = stat(pid) if pid else None
            if s: procs[pid] = [role, s[0], s[1]]
        f.write(json.dumps({"t": time.time() * 1000, "procs": procs}) + "\n"); f.flush()
        time.sleep(0.5)
PYS
}
for i in $(seq 1 "$RUNS"); do
  for variant in $VARIANTS; do
    policy=${variant%@*}; paint=${variant#*@}
    echo "── run $i/$RUNS $variant ─────────────────────────"
    wipe_channel
    seed_workspace
    paint_env=()
    [ "$paint" = default ] || paint_env=(TR_BENCH_BACKGROUND_PAINT_MS="$paint")
    env "${paint_env[@]}" TR_BENCH_HIDDEN_POLICY="$policy" TR_BENCH_RESULTS_PATH="$OUT/m13-$variant-$i.json" \
      "$BIN" --channel "$CHANNEL" --bench=M13 > "$OUT/m13-$variant-$i.log" 2>&1 &
    app_pid=$!
    sample_cpu "$app_pid" "$OUT/m13-$variant-$i.cpu.ndjson" &
    sampler_pid=$!
    wait "$app_pid" || true
    wait "$sampler_pid" || true
    grep -E 'M13 phase .*:|BENCH FAILED|Cannot attach|houston-tauri: .*(fail|refus|error)' "$OUT/m13-$variant-$i.log" || true
  done
done
python3 - "$OUT" "$RUNS" $VARIANTS <<'PY2'
import json, statistics, sys, pathlib, os
out, runs, variants = pathlib.Path(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
tck = os.sysconf("SC_CLK_TCK")
rows = {}
for policy in variants:
    for i in range(1, runs + 1):
        f = out / f"m13-{policy}-{i}.json"
        if not f.exists():
            print(f"{policy} run {i}: VOID -- no results file"); continue
        m = json.loads(f.read_text()).get("m13") or {}
        why = []
        if m.get("preExistingPanes"): why.append(f"preExistingPanes={m['preExistingPanes']}")
        if not (m.get("renderUnthrottled") or {}).get("valid"): why.append("render throttled")
        if not m.get("phases"): why.append("no phases")
        if why:
            print(f"{policy} run {i}: VOID -- " + ", ".join(why)); continue
        samples = [json.loads(l) for l in (out / f"m13-{policy}-{i}.cpu.ndjson").read_text().splitlines() if l.strip()]
        for ph in m["phases"]:
            # A phase with the window hidden has no frames to speak of; it measures nothing.
            if ph["frame"]["samples"] < 500:
                print(f"{policy} run {i} phase {ph['name']}: VOID -- {ph['frame']['samples']} frames")
                continue
            inside = [s for s in samples if ph["startEpochMs"] <= s["t"] <= ph["endEpochMs"]]
            if len(inside) < 2:
                continue
            a, b = inside[0], inside[-1]
            secs = (b["t"] - a["t"]) / 1000
            cpu = {}
            for pid, (role, _comm, ticks) in b["procs"].items():
                prev = a["procs"].get(pid)
                if prev:
                    cpu[role] = cpu.get(role, 0) + (ticks - prev[2]) / tck / secs * 100
            rows.setdefault((ph["name"], policy), []).append((cpu, ph))
def med(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else float("nan")
order = ["idle", "stream-visible", "stream-expanded", "stream-visible-again"]
print()
print(f"{'phase':<21} {'variant':<26} {'n':>1} {'app%':>6} {'webkit%':>7} {'daemon%':>7} {'total%':>6} {'parse ms':>8} {'paint fr':>8} {'frame p95':>9} {'echo p50':>8} {'p95':>5} {'p99':>5} {'max':>5}")
for name in order:
    for policy in variants:
        rs = rows.get((name, policy))
        if not rs: continue
        g = lambda role: med([c.get(role, 0) for c, _ in rs])
        tot = med([sum(c.values()) for c, _ in rs])
        e = lambda k: med([p["echo"][k] for _, p in rs])
        print(f"{name:<21} {policy:<26} {len(rs):>1} {g('app'):>6.1f} {g('webkit'):>7.1f} {g('daemon'):>7.1f} {tot:>6.1f} "
              f"{med([p['parseMs'] for _, p in rs]):>8.0f} {med([p['paintFrames'] for _, p in rs]):>8.0f} "
              f"{med([p['frame']['p95Ms'] for _, p in rs]):>7.1f}ms {e('p50Ms'):>6.0f}ms {e('p95Ms'):>5.0f} {e('p99Ms'):>5.0f} {e('maxMs'):>5.0f}")
print("""
CPU is % of one core over each 20 s phase (app = main process incl. GTK main thread,
webkit = WebKit web/network processes, daemon = houston-core; total adds the
supervisor and other app children). 11 panes stream 20 lines/s each; the 12th runs
`cat` and receives a typed token every 200 ms -- echo is send -> token painted.""")
PY2
echo; echo "raw JSON and CPU samples in $OUT"
