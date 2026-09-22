#!/usr/bin/env bash
# Sweeps stale Cargo artifacts from this checkout and .houston/worktrees/.
# Usage: [--dry-run | --install]; see docs/operations/development.md#disk-usage.
set -euo pipefail

# Artifacts untouched for 3 days belong to a branch nobody is building; the next
# build of that branch recompiles only what it needs.
SWEEP_DAYS="${HOUSTON_SWEEP_DAYS:-3}"

common_dir="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"
ROOT="$(dirname "$common_dir")"

cargo_bin="$(command -v cargo || true)"
if [ -z "$cargo_bin" ]; then
  echo "[sweep-targets] FAIL: cargo not found on PATH (expected ~/.cargo/bin/cargo)." >&2
  exit 1
fi
if ! "$cargo_bin" sweep --version >/dev/null 2>&1; then
  echo "[sweep-targets] FAIL: cargo-sweep is not installed — run: cargo install cargo-sweep" >&2
  exit 1
fi

# --hidden: the worktrees live under .houston/, which --recursive skips otherwise.
sweep() {
  "$cargo_bin" sweep --recursive --hidden "$@" --time "$SWEEP_DAYS" "$ROOT"
  "$cargo_bin" sweep --recursive --hidden "$@" --installed "$ROOT"
}

install() {
  local units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local cargo_dir
  cargo_dir="$(dirname "$cargo_bin")"
  mkdir -p "$units"
  # The unit carries the commands itself rather than calling this script, so it
  # keeps working while the checkout sits on a branch that predates the script.
  cat >"$units/houston-sweep-targets.service" <<EOF
[Unit]
Description=Sweep stale Cargo artifacts in $ROOT and its worktrees

[Service]
Type=oneshot
Nice=19
IOSchedulingClass=idle
Environment=PATH=$cargo_dir:/usr/local/bin:/usr/bin:/bin
ExecStart=$cargo_bin sweep --recursive --hidden --time $SWEEP_DAYS $ROOT
ExecStart=$cargo_bin sweep --recursive --hidden --installed $ROOT
EOF
  cat >"$units/houston-sweep-targets.timer" <<EOF
[Unit]
Description=Daily sweep of stale Cargo artifacts in $ROOT

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now houston-sweep-targets.timer
  echo "[sweep-targets] installed houston-sweep-targets.timer ($units)"

  # Cargo reads config from every parent directory, so this reaches each agent
  # worktree's build and not the main checkout's. Incremental caches are a large
  # share of target/ and buy little for the few builds an agent worktree sees.
  local worktree_config="$ROOT/.houston/worktrees/.cargo/config.toml"
  mkdir -p "$(dirname "$worktree_config")"
  if [ ! -f "$worktree_config" ]; then
    printf '[build]\nincremental = false\n' >"$worktree_config"
    echo "[sweep-targets] wrote $worktree_config"
  else
    echo "[sweep-targets] kept existing $worktree_config"
  fi
}

case "${1:-}" in
  "") sweep ;;
  --dry-run) sweep --dry-run ;;
  --install) install ;;
  *)
    echo "[sweep-targets] unknown argument '$1' — expected no argument, --dry-run or --install" >&2
    exit 1
    ;;
esac
