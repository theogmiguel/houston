#!/usr/bin/env bash
set -euo pipefail
# Isolate activation environment before starting the test Secret Service.
scratch=$(mktemp -d "${TMPDIR:-/tmp}/houston-exit-bus.XXXXXX")
trap 'rm -rf -- "$scratch"' EXIT
mkdir -m 700 "$scratch/home" "$scratch/config" "$scratch/cache"
env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u GNOME_KEYRING_CONTROL \
  -u DBUS_STARTER_ADDRESS -u DBUS_STARTER_BUS_TYPE HOME="$scratch/home" \
  XDG_CONFIG_HOME="$scratch/config" XDG_CACHE_HOME="$scratch/cache" \
  GIO_USE_VFS=local GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 \
  "$(dirname "$0")/with-test-keyring.sh" \
  env DISPLAY="${DISPLAY:?an isolated X11 display is required}" \
  bun "$(dirname "$0")/test-native-exit.mjs" "$@"
