#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

CHANNEL=probe
KIND=claude
MODEL=sonnet
MODE=real
SUBMIT=0
NO_SUBMIT=0
KEEP=0
YES_DEV=0
VIEW=0
SHOTS=
PROMPT="Answer one question from your own knowledge: what is 6 times 7? Do not read files, do not run commands."
BOOT_TIMEOUT=${BOOT_TIMEOUT:-180}
WAKE_TIMEOUT=${WAKE_TIMEOUT:-90}
WATCH=${WATCH:-45}

usage() {
  cat <<'USAGE'
usage: scripts/probe-orchestration.sh [options]

  --channel <name>   channel to run on (default: probe). `release` is refused;
                     `dev` needs --yes-dev.
  --yes-dev          allow --channel dev. It restarts the dev app and kills
                     every pane in it.
  --real             child is the real CLI named by --kind/--model (default).
  --no-submit        real mode: tell the child in its own brief NOT to call
                     `pane_submit`, which is the failure this probe exists for.
  --stub             child is a PATH-shimmed fake CLI. Needs --kind naming a
                     provider whose launched program is absent here (cursor
                     launches `cursor-agent`), or it is refused by name.
  --submit           stub mode: the stub calls `hs-pane submit`, i.e. the good
                     path, for comparison against the default.
  --kind <kind>      claude|codex|gemini|opencode|cursor|grok (default: claude)
  --model <model>    model for the child (default: sonnet; "" for the CLI's own)
  --prompt <text>    the child's brief (default: a trivial arithmetic question)
  --watch <secs>     keep listening this long after the first wake (default 45)
  --keep             leave the app running afterwards instead of stopping it
  --view             also photograph the real renderer in a headless browser
                     (scripts/probe/view.mjs) once both panes are up
  --shots <dir>      where --view writes its PNGs (implies --view; default
                     <state-dir>/probe-out/shots)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="${2:?--channel needs a name}"; shift 2 ;;
    --yes-dev) YES_DEV=1; shift ;;
    --stub) MODE=stub; shift ;;
    --real) MODE=real; shift ;;
    --submit) SUBMIT=1; shift ;;
    --no-submit) NO_SUBMIT=1; shift ;;
    --kind) KIND="${2:?--kind needs a value}"; shift 2 ;;
    --model) MODEL="${2:?--model needs a value}"; shift 2 ;;
    --prompt) PROMPT="${2:?--prompt needs text}"; shift 2 ;;
    --watch) WATCH="${2:?--watch needs seconds}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --view) VIEW=1; shift ;;
    --shots) SHOTS="${2:?--shots needs a directory}"; VIEW=1; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[probe] unknown flag: '$1'" >&2; usage >&2; exit 1 ;;
  esac
done

if [ "$CHANNEL" = release ]; then
  echo "[probe] refusing --channel release: ~/.houston is the installed app's live state." >&2
  echo "        Run on your own channel (the default, 'probe')." >&2
  exit 1
fi
if [ "$CHANNEL" = dev ] && [ "$YES_DEV" != 1 ]; then
  echo "[probe] refusing --channel dev without --yes-dev: the dev app is somebody's" >&2
  echo "        working session, and starting a second daemon on its state dir, or" >&2
  echo "        stopping the one there, kills every pane in it." >&2
  exit 1
fi
if ! printf '%s' "$CHANNEL" | grep -qE '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; then
  echo "[probe] '$CHANNEL' is not a valid channel name: 1-32 chars of [a-z0-9-], not" >&2
  echo "        starting or ending with '-'." >&2
  exit 1
fi
STATE_DIR="$HOME/.houston-$CHANNEL"

if [ -n "${HOUSTON_SESSION:-}" ] && [ "${HOUSTON_CHANNEL:-release}" = "$CHANNEL" ]; then
  echo "[probe] refusing: this shell is a pane on channel '$CHANNEL' (session $HOUSTON_SESSION)." >&2
  echo "        Probing it would stop the app running this terminal." >&2
  exit 1
fi

if [ -e "$STATE_DIR/daemon.lock" ] && ! flock -n "$STATE_DIR/daemon.lock" true 2>/dev/null; then
  held_pid=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("pid","?"))' \
    "$STATE_DIR/daemon.json" 2>/dev/null || echo '?')
  echo "[probe] refusing: a daemon already holds $STATE_DIR/daemon.lock (pid $held_pid," >&2
  echo "        per that channel's daemon.json). Stop it yourself, or probe another" >&2
  echo "        channel with --channel <name>." >&2
  exit 1
fi

APP="$ROOT/src-tauri/target/debug/houston-tauri"
if [ ! -x "$APP" ]; then
  echo "[probe] no app binary at $APP." >&2
  echo "        dev.sh would build one, but a cold cargo build is a heavy workload and" >&2
  echo "        belongs under scripts/oom-shield.sh: run" >&2
  echo "          scripts/oom-shield.sh sh -c 'cd src-tauri && cargo build'" >&2
  echo "        first (and 'cd ui && bun run build' if the renderer is stale)." >&2
  exit 1
fi

WORKSPACE="$STATE_DIR/probe-workspace"
OUT="$STATE_DIR/probe-out"
SHIM="$STATE_DIR/probe-bin"
rm -rf -- "$OUT" "$SHIM"
mkdir -p "$WORKSPACE" "$OUT" "$SHIM"
APP_LOG="$OUT/app.log"

SPAWN_MATCH="$ROOT/core/houston-core/src/daemon.rs"
if [ "$MODE" = stub ]; then
  ARM="$(printf '%s' "${KIND:0:1}" | tr 'a-z' 'A-Z')${KIND:1}"
  PROGRAM=$(sed -n \
    "s/^[[:space:]]*(proto::AgentKind::${ARM}, _) => (\"\([^\"]*\)\"\.to_string(), Vec::new()),\$/\1/p" \
    "$SPAWN_MATCH")
  arms=$(printf '%s' "$PROGRAM" | grep -c . || true)
  if [ "$arms" != 1 ]; then
    echo "[probe] refusing --stub --kind $KIND: found $arms spawn arms for" >&2
    echo "        proto::AgentKind::$ARM in $SPAWN_MATCH, expected exactly 1. Either" >&2
    echo "        '$KIND' is not one of claude|codex|gemini|opencode|cursor|grok, or that" >&2
    echo "        match changed shape and this probe has to be taught the new one." >&2
    exit 1
  fi
  if command -v "$PROGRAM" >/dev/null 2>&1; then
    echo "[probe] refusing --stub --kind $KIND: the daemon launches '$PROGRAM' for that kind" >&2
    echo "        (per $SPAWN_MATCH), and $PROGRAM is installed at" >&2
    echo "        $(command -v "$PROGRAM"). The daemon merges the login shell's PATH in front" >&2
    echo "        of the one it inherited, so the real CLI would run and the shim would not." >&2
    echo "        Name a provider that is absent here, or drop --stub and probe the real CLI." >&2
    exit 1
  fi
  cat > "$SHIM/$PROGRAM" <<'STUB'
#!/bin/sh
printf 'PROBE-STUB-CHILD up: %s\n' "$(pwd)"
printf 'PROBE-STUB-ANSWER: %s\n' "$PROBE_ANSWER"
if [ -n "$PROBE_STUB_SUBMIT" ]; then
  hs-pane submit "$PROBE_ANSWER" || printf 'PROBE-STUB submit FAILED\n'
fi
# The turn end a real CLI reports. TR_SESSION and HOUSTON_CHANNEL are in every
# pane's environment, which is all the hook client needs to find its channel's
# drop directory.
"$PROBE_HOOK_EXE" hook Stop --agent "$PROBE_STUB_PROVIDER" </dev/null || true
stty -echo 2>/dev/null
exec cat
STUB
  chmod +x "$SHIM/$PROGRAM"
  export PATH="$SHIM:$PATH"
fi

cat > "$OUT/parent.sh" <<'PARENT'
#!/bin/sh
stty -echo 2>/dev/null
printf 'PROBE-PARENT up: %s\n' "$(pwd)"
: > "$PROBE_OUT/parent-stdin.log"
touch "$PROBE_OUT/parent.up"
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$PROBE_OUT/parent-stdin.log"
  case "$line" in
    PROBE:*) eval "${line#PROBE:}" ;;
  esac
done
PARENT
chmod +x "$OUT/parent.sh"

export PROBE_OUT="$OUT"
export PROBE_HOOK_EXE="$APP"
export PROBE_STUB_PROVIDER="$KIND"
export PROBE_ANSWER="42"
[ "$SUBMIT" = 1 ] && export PROBE_STUB_SUBMIT=1

echo "[probe] channel=$CHANNEL state-dir=$STATE_DIR mode=$MODE kind=$KIND${PROGRAM:+ program=$PROGRAM}"
echo "[probe] starting the app (scripts/dev.sh --channel $CHANNEL); log: $APP_LOG"
./scripts/dev.sh --channel "$CHANNEL" > "$APP_LOG" 2>&1 &
APP_PID=$!
echo "$APP_PID" > "$OUT/app.pid"
echo "[probe] app pid $APP_PID (captured; nothing here is ever matched by name)"

stop_app() {
  [ -n "${APP_PID:-}" ] || return 0
  if [ "$KEEP" = 1 ]; then
    echo "[probe] --keep: leaving pid $APP_PID running on channel '$CHANNEL'."
    echo "        Stop it with: kill -TERM $APP_PID   (the pid in $OUT/app.pid)"
    return 0
  fi
  kill -0 "$APP_PID" 2>/dev/null || return 0
  echo "[probe] stopping the app: kill -TERM $APP_PID"
  kill -TERM "$APP_PID" 2>/dev/null || true
  for _ in $(seq 1 30); do
    kill -0 "$APP_PID" 2>/dev/null || { echo "[probe] app stopped"; return 0; }
    sleep 0.5
  done
  echo "[probe] pid $APP_PID ignored SIGTERM for 15s; sending SIGKILL" >&2
  kill -KILL "$APP_PID" 2>/dev/null || true
}
trap stop_app EXIT

echo "[probe] waiting up to ${BOOT_TIMEOUT}s for $STATE_DIR/daemon.json…"
for i in $(seq 1 "$((BOOT_TIMEOUT * 2))"); do
  [ -s "$STATE_DIR/daemon.json" ] && break
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "[probe] the app exited before writing daemon.json. Last of $APP_LOG:" >&2
    tail -20 "$APP_LOG" >&2
    exit 1
  fi
  sleep 0.5
done
[ -s "$STATE_DIR/daemon.json" ] || {
  echo "[probe] no daemon.json after ${BOOT_TIMEOUT}s. Last of $APP_LOG:" >&2
  tail -20 "$APP_LOG" >&2
  exit 1
}
read -r PORT TOKEN PROTOCOL <<EOF
$(python3 -c 'import json,sys
c = json.load(open(sys.argv[1]))
print(c["port"], c["token"], c["protocol"])' "$STATE_DIR/daemon.json")
EOF
echo "[probe] daemon up: port=$PORT protocol=$PROTOCOL"

ws() { bun "$ROOT/scripts/probe/ws.mjs" "$PORT" "$TOKEN" "$PROTOCOL" "$1"; }

send_cmd() {
  local marker="$1" cmd="$2"
  rm -f "$OUT/$marker"
  ws "$(python3 -c 'import json,sys
print(json.dumps([{"op":"input","session":int(sys.argv[1]),
                   "data":"PROBE:" + sys.argv[2] + "; echo done > $PROBE_OUT/" + sys.argv[3] + "\n"}]))' \
    "$PARENT_ID" "$cmd" "$marker")" > /dev/null
}
await_file() {
  local path="$1" what="$2" secs="${3:-30}"
  for _ in $(seq 1 "$((secs * 2))"); do
    [ -e "$path" ] && return 0
    sleep 0.5
  done
  echo "[probe] timed out after ${secs}s waiting for $what ($path)" >&2
  return 1
}

echo "[probe] registering the workspace and its orchestration consent"
ws "$(python3 -c 'import json,sys
ws = sys.argv[1]
print(json.dumps([{"op":"workspace_add","path":ws},{"op":"consent","workspace":ws,"enabled":True}]))' \
  "$WORKSPACE")"

echo "[probe] opening the parent pane"
PARENT_ID=$(ws "$(python3 -c 'import json,sys
print(json.dumps([{"op":"create","agent":"custom","project_dir":sys.argv[1],
                   "cmd":["sh", sys.argv[2]]}]))' "$WORKSPACE" "$OUT/parent.sh")" \
  | python3 -c 'import json,sys
for line in sys.stdin:
    v = json.loads(line)
    if "created" in v: print(v["created"])')
[ -n "$PARENT_ID" ] || { echo "[probe] the parent pane never came up" >&2; exit 1; }
echo "[probe] parent pane: session $PARENT_ID"
await_file "$OUT/parent.up" "the parent pane's reader loop" 30

send_cmd parent-settled.done "\"\$PROBE_HOOK_EXE\" hook Stop --agent claude </dev/null"
await_file "$OUT/parent-settled.done" "the parent's own Stop hook" 30

echo "[probe] spawning the child from inside the parent pane (hs-pane spawn)"
spawn_cmd="hs-pane spawn --kind $KIND --role probe-child"
spawn_cmd="$spawn_cmd --prompt $(printf '%q' "$PROMPT")"
spawn_cmd="$spawn_cmd --output-format $(printf '%q' 'a single line: the answer and nothing else')"
if [ "$NO_SUBMIT" = 1 ]; then
  spawn_cmd="$spawn_cmd --boundaries $(printf '%q' 'Do NOT call pane_submit and do not use any Houston pane tool. Write the answer in this pane and end your turn.')"
fi
[ -n "$MODEL" ] && spawn_cmd="$spawn_cmd --model $MODEL"
send_cmd spawn.done "$spawn_cmd > \$PROBE_OUT/spawn.json 2>&1"
await_file "$OUT/spawn.done" "hs-pane spawn to return" 60
CHILD_ID=$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1])).get("session_id",""))
except Exception:
    print("")' "$OUT/spawn.json")
if [ -z "$CHILD_ID" ]; then
  echo "[probe] spawn did not return a session id. What hs-pane said:" >&2
  cat "$OUT/spawn.json" >&2
  exit 1
fi
echo "[probe] child pane: session $CHILD_ID"

echo "[probe] waiting up to ${WAKE_TIMEOUT}s for the parent to be woken…"
woken=0
for _ in $(seq 1 "$((WAKE_TIMEOUT * 2))"); do
  if grep -q "HoustonSwarm Inbox" "$OUT/parent-stdin.log" 2>/dev/null; then
    woken=1
    break
  fi
  sleep 0.5
done
[ "$woken" = 1 ] && echo "[probe] the parent was woken" \
  || echo "[probe] NO WAKE reached the parent within ${WAKE_TIMEOUT}s"
echo "[probe] listening ${WATCH}s more for further messages…"
sleep "$WATCH"
echo "[probe] messages delivered: $(grep -c 'HoustonSwarm Inbox' "$OUT/parent-stdin.log" 2>/dev/null || echo 0)"

if [ "$VIEW" = 1 ]; then
  echo "[probe] photographing the renderer (scripts/probe/view.mjs)"
  node "$ROOT/scripts/probe/view.mjs" \
    --channel "$CHANNEL" \
    --workspace "$WORKSPACE" \
    --panes "$PARENT_ID,$CHILD_ID" \
    ${SHOTS:+--out "$SHOTS"} \
    || echo "[probe] the renderer capture failed (see above); the rest of the probe stands" >&2
fi

send_cmd get.done "hs-pane get $CHILD_ID > \$PROBE_OUT/delegation.json 2>&1"
await_file "$OUT/get.done" "hs-pane get" 30
send_cmd read.done "hs-pane read $CHILD_ID --lines 30 > \$PROBE_OUT/child-tail.txt 2>&1"
await_file "$OUT/read.done" "hs-pane read" 30

echo
echo "===== delegation record (hs-pane get $CHILD_ID) ====================="
cat "$OUT/delegation.json"
echo
echo "===== the parent's inbox (everything typed at pane $PARENT_ID) ======"
cat "$OUT/parent-stdin.log"
echo
echo "===== the child's own pane (hs-pane read $CHILD_ID) ================="
cat "$OUT/child-tail.txt"
echo
echo "===== verdict ======================================================="
if [ "$woken" = 1 ]; then
  if grep -q "no_handback" "$OUT/parent-stdin.log"; then
    echo "WOKEN by an unstaged turn end: the child never submitted, and the parent"
    echo "got its tail labelled as the child's screen."
  else
    echo "WOKEN by a handback: the child called pane_submit."
  fi
else
  echo "NOT WOKEN. The child ended (or did not end) its turn and nothing reached the"
  echo "parent — which is the bug this probe exists to catch."
fi
echo "artifacts: $OUT"
