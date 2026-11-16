#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HOUSTON_CHANNEL="${HOUSTON_CHANNEL-release}"

resolve_app() {
  if [ -n "${TR_APP:-}" ]; then
    printf '%s\n' "$TR_APP"
    return
  fi
  local unpacked="$ROOT/release/linux-unpacked/houston"
  if [ -x "$unpacked" ]; then
    printf '%s\n' "$unpacked"
    return
  fi
  local candidate
  candidate="$(find "$ROOT/release" -maxdepth 1 -type f -name 'Houston-*.AppImage' 2>/dev/null | sort | tail -1)"
  if [ -n "$candidate" ]; then
    printf '%s\n' "$candidate"
    return
  fi
  printf '%s\n' "$ROOT/release/linux-unpacked/houston"
}

APP="$(resolve_app)"

[ -x "$APP" ] || {
  echo "packaged app missing at $APP — run: pnpm dist:desktop:linux" >&2
  echo "(or set TR_APP to an installed copy; install-desktop.sh does this)" >&2
  exit 1
}

caller_set_channel=0
for arg in "$@"; do
  case "$arg" in
    --channel|--channel=*) caller_set_channel=1; break ;;
  esac
done

if [ "$caller_set_channel" = "1" ]; then
  exec "$APP" "$@"
else
  exec "$APP" --channel "$HOUSTON_CHANNEL" "$@"
fi
