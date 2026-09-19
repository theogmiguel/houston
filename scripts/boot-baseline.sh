#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
BIN=src-tauri/target/release/houston-tauri
[ -x "$BIN" ] || { echo "no release binary at $BIN -- cargo build --release --features bench" >&2; exit 1; }
OUT=$(mktemp -d); RUNS=${RUNS:-5}; CHANNEL=${CHANNEL:-m9bench}
[ "$CHANNEL" = release ] && { echo "refusing: --channel release is the installed app's live state" >&2; exit 1; }
STATE_DIR="$HOME/.houston-$CHANNEL"
export HOUSTON_DISABLE_SWARM_AUTOLAUNCH=1

stop_channel_daemon() {
  local json port token pid deadline resp
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
    echo "refusing to wipe $STATE_DIR: daemon_shutdown did not report ok:true (response: $resp)" >&2
    exit 1
  fi
  if [ -n "$pid" ]; then
    deadline=$((SECONDS + 10))
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$deadline" ]; then
        echo "refusing to wipe $STATE_DIR: pid $pid still alive 10s after daemon_shutdown reported ok:true" >&2
        exit 1
      fi
      sleep 0.25
    done
  fi
}
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

echo "channel=$CHANNEL runs=$RUNS  state-dir: $STATE_DIR"
echo "results dir: $OUT"

echo
echo "== COLD: $RUNS boots of a wiped, zero-session channel =============="
for i in $(seq 1 "$RUNS"); do
  echo "-- cold run $i/$RUNS --"
  wipe_channel
  seed_workspace
  TR_BENCH_RESULTS_PATH="$OUT/cold-$i.json" "$BIN" --channel "$CHANNEL" --bench=M10 2>&1 \
    | grep -E 'M10 (phase|total)' || true
done

echo
echo "== SEED: one M11 run, to leave sessions for the warm boots ========="
wipe_channel
seed_workspace
TR_BENCH_RESULTS_PATH="$OUT/seed.json" "$BIN" --channel "$CHANNEL" --bench=M11 2>&1 \
  | grep -E 'M11:' || true

echo
echo "== WARM: $RUNS boots restoring those sessions (channel NOT wiped) =="
for i in $(seq 1 "$RUNS"); do
  echo "-- warm run $i/$RUNS --"
  TR_BENCH_RESULTS_PATH="$OUT/warm-$i.json" "$BIN" --channel "$CHANNEL" --bench=M10 2>&1 \
    | grep -E 'M10 (phase|total|WARM)' || true
done

python3 - "$OUT" "$RUNS" <<'PY'
import json, statistics, sys, pathlib
out, runs = pathlib.Path(sys.argv[1]), int(sys.argv[2])

def load(prefix):
    valid, void = [], []
    for i in range(1, runs + 1):
        f = out / f"{prefix}-{i}.json"
        if not f.exists():
            void.append((i, "no results file")); continue
        m = (json.loads(f.read_text()) or {}).get("m10")
        if not m:
            void.append((i, "no m10 block")); continue
        # A run that timed out on any phase is not a slow sample, it is a
        # broken one: the stamp it reports is the deadline, not the event.
        bad = [k for k in ("timedOutWaitingForAppMount", "timedOutWaitingForGrid",
                           "timedOutWaitingForTypeable", "timedOutWaitingForOutput")
               if m.get(k)]
        if bad:
            void.append((i, "timed out: " + ", ".join(bad)))
        else:
            valid.append((i, m))
    return valid, void

def phase_table(valid):
    # Phase deltas, not absolute offsets: boot cost is only actionable
    # per-phase, and an absolute total hides which phase actually moved.
    names = []
    for _, m in valid:
        for n, _us in m["stampsUs"]:
            if n not in names:
                names.append(n)
    rows, prev = [], None
    for n in names:
        vals = []
        for _, m in valid:
            d = dict(m["stampsUs"])
            if n in d and (prev is None or prev in d):
                vals.append((d[n] - (d[prev] if prev else 0)) / 1000)
        if vals:
            rows.append((("" if prev is None else prev + " -> ") + n,
                         statistics.median(vals), min(vals), max(vals)))
        prev = n
    return rows

def report(label, prefix, want_warm):
    valid, void = load(prefix)
    print(f"\n{label}: {len(valid)}/{runs} valid")
    for i, why in void:
        print(f"  run {i}: VOID -- {why}")
    if not valid:
        print(f"  no valid {label} run; nothing to report.")
        return None
    got = [m.get("warmRestore") for _, m in valid]
    if any(w != want_warm for w in got):
        print(f"  ABORT: expected warmRestore={want_warm}, got {got}.")
        print("  A cold run that found sessions (or a warm one that found none) is")
        print("  measuring the other condition, and the two are not comparable.")
        sys.exit(2)
    if want_warm:
        counts = sorted({m["restoredSessions"] for _, m in valid})
        print(f"  restored sessions: {counts}")
        if len(counts) > 1:
            print("  ABORT: the restored-session count moved between runs, so these")
            print("  boots did not measure the same grid.")
            sys.exit(2)
    print(f"  {'phase':<46} {'median':>9}   {'range':>18}")
    for name, med, lo, hi in phase_table(valid):
        print(f"  {name:<46} {med:>7.1f}ms   {lo:>7.1f}-{hi:<7.1f}ms")
    return valid

cold = report("COLD (0 sessions)", "cold", False)
warm = report("WARM (restored grid)", "warm", True)

def med_of(valid, key):
    vals = [m[key] for _, m in valid if m.get(key) is not None]
    return statistics.median(vals) if vals else None

print("\n" + "=" * 72)
print("HEADLINE (median over valid runs)")
if cold:
    print(f"  cold  main-entry -> renderer-app-mounted    {med_of(cold, 'totalMs'):>7.1f} ms")
if warm:
    g = med_of(warm, "gridPaintedMs")
    t = med_of(warm, "focusedPaneTypeableMs")
    o = med_of(warm, "firstOutputPaintedMs")
    if g is not None:
        print(f"  warm  main-entry -> grid-painted           {g:>7.1f} ms")
    if t is not None:
        print(f"  warm  main-entry -> focused-pane-typeable  {t:>7.1f} ms")
    if o is not None:
        print(f"  warm  main-entry -> first-output-painted   {o:>7.1f} ms")
        if t is not None:
            print(f"        (of which the shell's own startup: {o - t:>6.1f} ms —")
            print("         an interactive zsh with oh-my-zsh and a non-lazy nvm is ~1.2s")
            print("         on its own, and Houston's shell integration adds nothing")
            print("         measurable. A big number here is the rc, not the app.)")
print("\nThese are the rows docs/internals/overview.md's budget table carries.")
print("Re-run after any boot-path change; a phase that moved names itself above.")
PY
echo; echo "raw JSON in $OUT"
