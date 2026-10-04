#!/usr/bin/env bash
# Runs a command against a throwaway Secret Service (private bus, temp keyrings),
# so tests never touch the host's login keyring. Why bare `--unlock` is unsafe on
# a host: docs/operations/development.md. Usage: oom-shield.sh with-test-keyring.sh cargo test
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "[with-test-keyring] usage: scripts/with-test-keyring.sh <command> [args...]" >&2
  exit 1
fi

for bin in dbus-run-session gnome-keyring-daemon; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "[with-test-keyring] FAIL: '$bin' not found on PATH (install dbus and gnome-keyring)." >&2
    exit 1
  fi
done

kr="$(mktemp -d "${TMPDIR:-/tmp}/houston-test-keyring.XXXXXX")"
trap 'rm -rf -- "$kr"' EXIT

# An unencrypted, pre-created default keyring: the daemon never needs a
# password, so it never prompts and never touches the host's keyrings.
mkdir -p -m 700 "$kr/run" "$kr/data/keyrings"
printf '[keyring]\ndisplay-name=Login\nctime=0\nmtime=0\nlock-on-idle=false\nlock-after=false\n' \
  > "$kr/data/keyrings/login.keyring"
printf 'login' > "$kr/data/keyrings/default"

# No DISPLAY/WAYLAND_DISPLAY: a stray prompt fails instead of popping a dialog.
# The daemon exits with the private bus when dbus-run-session ends.
env -u DISPLAY -u WAYLAND_DISPLAY \
  XDG_DATA_HOME="$kr/data" XDG_RUNTIME_DIR="$kr/run" \
  dbus-run-session -- bash -c '
    gnome-keyring-daemon --start --components=secrets >/dev/null 2>&1
    exec "$@"
  ' _ "$@"
