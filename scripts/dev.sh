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
fi

APP="$ROOT/src-tauri/target/debug/houston-tauri"

echo "[dev] building the v2 web renderer."
(cd "$ROOT" && npx -y pnpm@12.14.0 --filter @t3tools/web build)

echo "[dev] building the v2 server."
(cd "$ROOT" && npx -y pnpm@12.14.0 --filter houston build:bundle)

echo "[dev] building the app (debug)…"
(cd "$ROOT/src-tauri" && cargo build)

[ -x "$APP" ] || { echo "[dev] app binary missing at $APP after a successful build — did the bin name change in src-tauri/Cargo.toml?" >&2; exit 1; }

ARGS=(--channel "$HOUSTON_CHANNEL")

echo "[dev] starting the app on channel '$HOUSTON_CHANNEL'… (Ctrl+C ends the app; sessions and the daemon keep running)"
exec "$APP" "${ARGS[@]}"
