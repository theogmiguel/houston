#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export HOUSTON_CHANNEL="${HOUSTON_CHANNEL-release}"

APP="${TR_APP:-$ROOT/src-tauri/target/release/houston}"

[ -x "$APP" ] || {
  echo "packaged app missing at $APP — run: ./scripts/build-app.sh" >&2
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
