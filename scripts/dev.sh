#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

FRESH=0
PRINT_TARGET=0
CHANNEL_ARG=""
CHANNEL_ARG_SET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fresh)
      FRESH=1
      shift
      ;;
    --print-target)
      PRINT_TARGET=1
      shift
      ;;
    --channel)
      if [ $# -lt 2 ]; then
        echo "[dev] --channel requires a value (got none). Expected: --channel <name>, e.g. --channel release" >&2
        exit 1
      fi
      CHANNEL_ARG="$2"
      CHANNEL_ARG_SET=1
      shift 2
      ;;
    --channel=*)
      CHANNEL_ARG="${1#*=}"
      CHANNEL_ARG_SET=1
      shift
      ;;
    *)
      echo "[dev] unknown flag: '$1'. Accepted flags: --fresh, --channel <name>, --print-target" >&2
      exit 1
      ;;
  esac
done

PANE_CHANNEL="${HOUSTON_CHANNEL-release}"

if [ "$CHANNEL_ARG_SET" = "1" ]; then
  if [ -z "$CHANNEL_ARG" ]; then
    echo "[dev] --channel was given an empty value. Expected: 1-32 characters of [a-z0-9-]" \
         "(not starting or ending with '-'), or the literal 'release'." >&2
    exit 1
  fi
  if [ "$CHANNEL_ARG" = "release" ]; then
    :
  elif ! printf '%s' "$CHANNEL_ARG" | grep -qE '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'; then
    echo "[dev] --channel '$CHANNEL_ARG' is not a valid channel name. Expected: 1-32" \
         "characters of [a-z0-9-], not starting or ending with '-', or the literal" \
         "'release'." >&2
    exit 1
  fi
  TARGET_CHANNEL="$CHANNEL_ARG"
else
  TARGET_CHANNEL="dev"
fi
export HOUSTON_CHANNEL="$TARGET_CHANNEL"

if [ "$HOUSTON_CHANNEL" = "release" ]; then
  STATE_DIR="$HOME/.houston"
  if [ "$PRINT_TARGET" = "1" ]; then
    echo "[dev] WARNING: --channel release requested — a real run would drive the" >&2
    echo "      INSTALLED APP's own daemon and live state dir ($STATE_DIR)." >&2
  else
    echo "[dev] WARNING: --channel release requested — this drives the INSTALLED APP's" >&2
    echo "      own daemon and live state dir ($STATE_DIR). This is the shared," >&2
    echo "      dangerous mode: it can touch sessions the installed app owns." >&2
  fi
else
  STATE_DIR="$HOME/.houston-$HOUSTON_CHANNEL"
fi
echo "[dev] channel: $HOUSTON_CHANNEL — state dir $STATE_DIR"

if [ "$PRINT_TARGET" = "1" ]; then
  echo "[dev] --print-target: channel=$HOUSTON_CHANNEL state_dir=$STATE_DIR"
  exit 0
fi

if [ "$FRESH" = "1" ]; then
  if [ -n "${HOUSTON_SESSION:-}" ] && [ "${PANE_CHANNEL:-release}" = "$HOUSTON_CHANNEL" ]; then
    echo "[dev] refusing --fresh: this shell runs inside a '$HOUSTON_CHANNEL' channel pane (session $HOUSTON_SESSION)." >&2
    echo "      Restarting that app would kill this terminal and every other session on the channel." >&2
    echo "      Run it from a pane on another channel (e.g. the installed app), or a terminal outside both." >&2
    exit 1
  fi

  proc_creation_token() {
    local stat rest
    stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
    rest="${stat##*)}"
    printf '%s\n' "$rest" | awk '{print $20}'
  }

  DAEMON_JSON="$STATE_DIR/daemon.json"
  SUPERVISOR_JSON="$STATE_DIR/supervisor.json"
  HANDOFF_DONE=0
  FRESH_PORT=""
  FRESH_TOKEN=""
  FRESH_PID=""
  if [ -f "$DAEMON_JSON" ]; then
    JSON_TEXT="$(cat "$DAEMON_JSON")"
    FRESH_PORT="$(printf '%s' "$JSON_TEXT" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')"
    FRESH_TOKEN="$(printf '%s' "$JSON_TEXT" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    FRESH_PID="$(printf '%s' "$JSON_TEXT" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')"
    FRESH_PID_CREATION="$(printf '%s' "$JSON_TEXT" | sed -n 's/.*"pid_creation"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p')"

    DAEMON_ALIVE=0
    if [ -n "$FRESH_PID" ]; then
      if [ -n "$FRESH_PID_CREATION" ]; then
        LIVE_TOKEN="$(proc_creation_token "$FRESH_PID")"
        if [ -n "$LIVE_TOKEN" ] && [ "$LIVE_TOKEN" = "$FRESH_PID_CREATION" ]; then
          DAEMON_ALIVE=1
        fi
      else
        if kill -0 "$FRESH_PID" 2>/dev/null; then
          DAEMON_ALIVE=1
        fi
      fi
    fi

    if [ "$DAEMON_ALIVE" -eq 0 ]; then
      echo "[dev] daemon.json names pid ${FRESH_PID:-unknown} which is gone (the daemon reaped itself or crashed); removing the stale daemon.json and supervisor.json and proceeding."
      rm -f "$DAEMON_JSON" "$SUPERVISOR_JSON"
      HANDOFF_DONE=1
    fi
  fi

  if [ "$HANDOFF_DONE" -eq 0 ] && [ "$(uname -s)" = "Linux" ]; then
    if [ -n "$FRESH_PORT" ] && [ -n "$FRESH_TOKEN" ]; then
      echo "[dev] --fresh: asking the '$HOUSTON_CHANNEL' daemon (pid ${FRESH_PID:-unknown}, port $FRESH_PORT) for a live handoff…"
      HANDOFF_RESP="$(curl -sS -m 10 -X POST "http://127.0.0.1:$FRESH_PORT/manage" \
        -H "Authorization: Bearer $FRESH_TOKEN" -H 'Content-Type: application/json' \
        -d '{"manage_version":1,"verb":"daemon_handoff"}' 2>&1 || true)"
      if printf '%s' "$HANDOFF_RESP" | grep -q '"accepted"[[:space:]]*:[[:space:]]*true'; then
        echo "[dev] handoff accepted -- a new daemon generation now owns every live session."
        if [ -n "$FRESH_PID" ]; then
          FRESH_DEADLINE=$((SECONDS + 10))
          while kill -0 "$FRESH_PID" 2>/dev/null; do
            if [ "$SECONDS" -ge "$FRESH_DEADLINE" ]; then
              echo "[dev] refusing --fresh: the old daemon (pid $FRESH_PID) is still alive 10s after an accepted handoff." >&2
              echo "      Refusing to start a second daemon on top of it. Investigate before retrying." >&2
              exit 1
            fi
            sleep 0.25
          done
        fi
        HANDOFF_DONE=1
      else
        echo "[dev] handoff unavailable, falling back to an orderly stop: $HANDOFF_RESP"
      fi
    fi
  fi

  if [ "$HANDOFF_DONE" -eq 0 ]; then
    if [ -n "$FRESH_PORT" ] && [ -n "$FRESH_TOKEN" ]; then
      echo "[dev] --fresh: requesting an orderly stop of the '$HOUSTON_CHANNEL' daemon (pid ${FRESH_PID:-unknown}, port $FRESH_PORT)…"
      FRESH_RESP="$(curl -sS -m 10 -X POST "http://127.0.0.1:$FRESH_PORT/manage" \
        -H "Authorization: Bearer $FRESH_TOKEN" -H 'Content-Type: application/json' \
        -d '{"manage_version":1,"verb":"daemon_shutdown"}' 2>&1)" && CURL_STATUS=0 || CURL_STATUS=$?
      if [ "$CURL_STATUS" -ne 0 ]; then
        echo "[dev] refusing --fresh: pid $FRESH_PID is alive but /manage on port $FRESH_PORT did not answer (curl exit $CURL_STATUS): $FRESH_RESP" >&2
        echo "      The pid is alive; the port is not -- investigate which of the two is wrong before retrying." >&2
        echo "      Never falling back to a bare kill (AGENTS.md, danger #1)." >&2
        exit 1
      fi
      if ! printf '%s' "$FRESH_RESP" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
        echo "[dev] refusing --fresh: daemon_shutdown did not report ok:true." >&2
        echo "      response: $FRESH_RESP" >&2
        echo "      Never falling back to a bare kill (AGENTS.md, danger #1) -- stop it manually and investigate." >&2
        exit 1
      fi
      if [ -n "$FRESH_PID" ]; then
        FRESH_DEADLINE=$((SECONDS + 10))
        while kill -0 "$FRESH_PID" 2>/dev/null; do
          if [ "$SECONDS" -ge "$FRESH_DEADLINE" ]; then
            echo "[dev] refusing --fresh: pid $FRESH_PID is still alive 10s after daemon_shutdown reported ok:true." >&2
            echo "      Refusing to start a second daemon on top of it. Stop it manually and investigate." >&2
            exit 1
          fi
          sleep 0.25
        done
      fi
      echo "[dev] daemon stopped."
    elif [ -f "$DAEMON_JSON" ]; then
      echo "[dev] $DAEMON_JSON has no readable port/token -- treating as stale, proceeding."
    else
      echo "[dev] no daemon.json at $STATE_DIR -- nothing to stop."
    fi
  fi
fi

APP="$ROOT/src-tauri/target/debug/houston-tauri"

echo "[dev] building the renderer…"
(cd "$ROOT/ui" && bun run build)

echo "[dev] building the daemon and supervisor (debug)…"
(cd "$ROOT/core" && cargo build --bin houston-core --bin houston-supervisor)

echo "[dev] building the app (debug)…"
(cd "$ROOT/src-tauri" && cargo build)

[ -x "$APP" ] || { echo "[dev] app binary missing at $APP after a successful build — did the bin name change in src-tauri/Cargo.toml?" >&2; exit 1; }

export HOUSTON_DAEMON_BIN_DIR="$ROOT/core/target/debug"

ARGS=(--channel "$HOUSTON_CHANNEL")

echo "[dev] starting the app on channel '$HOUSTON_CHANNEL'… (Ctrl+C ends the app; sessions and the daemon keep running)"
exec "$APP" "${ARGS[@]}"
