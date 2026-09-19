#!/usr/bin/env bash
set -euo pipefail

DISTRO="${LINUX_VM_DISTRO:-Ubuntu-24.04}"
VM_REPO="${LINUX_VM_REPO:-\$HOME/Houston}"

command -v wsl.exe >/dev/null 2>&1 || {
  echo "[linux-vm] wsl.exe not on PATH -- this script runs from the WINDOWS host" >&2
  exit 1
}

VM_PREAMBLE='
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
vmcd() {
  cd "$1" || { echo "[linux-vm] FATAL: cd to $1 failed" >&2; exit 1; }
  case "$PWD" in
    /mnt/*)
      echo "[linux-vm] FATAL: landed in $PWD (the 9p-mounted Windows tree)," >&2
      echo "[linux-vm]        not the VM clone -- refusing to continue" >&2
      exit 1
      ;;
  esac
}
'

vm_bootstrap_env() {
  printf '%s\n' "$VM_PREAMBLE" |
    wsl.exe -d "$DISTRO" -- bash -lc "tr -d '\r' > \$HOME/.linux-vm-env.sh"
}

vm() {
  vm_bootstrap_env
  printf '%s\n' "$1" |
    wsl.exe -d "$DISTRO" -- bash -lc \
      "tr -d '\r' > \$HOME/.linux-vm-inline.sh && . \$HOME/.linux-vm-env.sh && . \$HOME/.linux-vm-inline.sh"
}

vm_exec_file() {
  local local_path="$1" remote="${2:-\$HOME/.linux-vm-task.sh}"
  [ -f "$local_path" ] || { echo "[linux-vm] no such script: $local_path" >&2; exit 1; }
  vm_bootstrap_env
  wsl.exe -d "$DISTRO" -- bash -lc \
    "tr -d '\r' > $remote && . \$HOME/.linux-vm-env.sh && . $remote" < "$local_path"
}

vm_detach() {
  local name="$1" body="$2"
  vm "rm -f \$HOME/$name.log \$HOME/$name.status
      cat > \$HOME/$name.sh <<'LVMEOF'
$body
LVMEOF
      setsid nohup bash -lc 'trap \"echo \\\$? > \$HOME/$name.status\" EXIT; . \$HOME/.linux-vm-env.sh; . \$HOME/$name.sh' \
        > \$HOME/$name.log 2>&1 < /dev/null &
      sleep 2; echo '[linux-vm] $name started'"
}

vm_wait() {
  local name="${1:-build}"
  echo "[linux-vm] waiting on \$HOME/$name.status ..."
  vm "while [ ! -f \$HOME/$name.status ]; do sleep 20; done
      echo \"EXIT_CODE=\$(cat \$HOME/$name.status)\"
      tail -30 \$HOME/$name.log"
}

case "${1:-}" in
  status)
    vm "echo '--- distro ---'; grep PRETTY_NAME /etc/os-release
        echo '--- systemd (oom-shield needs it) ---'; systemctl is-system-running || true
        echo '--- wslg sockets (empty => wsl --shutdown and relaunch) ---'
        ls /mnt/wslg/.X11-unix/ 2>&1; ls /mnt/wslg/runtime-dir/ 2>&1 | head -4
        echo '--- toolchain ---'; echo \"cargo=\$(command -v cargo || echo MISSING)  bun=\$(command -v bun || echo MISSING)  node=\$(command -v node || echo MISSING)\"
        echo '--- clone ---'; vmcd $VM_REPO && git log --oneline -1 && git status --short | head"
    ;;

  sync)
    if [ "${2:-}" = "--force" ]; then
      vm "vmcd $VM_REPO && git checkout -- . && git fetch origin && git pull --ff-only && git log --oneline -1"
    else
      vm "vmcd $VM_REPO
          if [ -n \"\$(git status --porcelain)\" ]; then
            echo '[linux-vm] clone is DIRTY -- refusing to pull over it:'
            git status --short
            echo '[linux-vm] re-run with: linux-vm.sh sync --force  (discards the above)'
            exit 1
          fi
          git fetch origin && git pull --ff-only && git log --oneline -1"
    fi
    ;;

  run)
    [ $# -ge 2 ] || { echo "[linux-vm] run needs a command" >&2; exit 1; }
    vm "vmcd $VM_REPO && $2"
    ;;

  exec)
    [ $# -ge 2 ] || { echo "[linux-vm] exec needs a local script path" >&2; exit 1; }
    vm_exec_file "$2"
    ;;

  gate)
    vm "set -uo pipefail
        vmcd $VM_REPO
        fail=0
        step() {
          local label=\"\$1\"; shift
          echo ''
          echo \"=== \$label ===\"
          if \"\$@\"; then
            echo \"--- PASS: \$label\"
          else
            local rc=\$?
            echo \"--- FAIL: \$label (exit \$rc)\"
            fail=1
          fi
        }
        echo \"### HEAD: \$(git rev-parse --short HEAD)\"

        step 'core: cargo fmt --check' \
          cargo fmt --manifest-path core/Cargo.toml --all -- --check
        step 'core: clippy -D warnings' \
          cargo clippy --manifest-path core/Cargo.toml --all-targets -- -D warnings
        step 'core: cargo test (shielded, with Secret Service)' \
          env HOUSTON_CHANNEL=dev ./scripts/oom-shield.sh \
              dbus-run-session -- bash -c \
                'eval \"\$(echo -n \"\" | gnome-keyring-daemon --unlock --components=secrets 2>/dev/null)\"
                 cargo test --manifest-path core/Cargo.toml'

        step 'src-tauri: fmt --check' \
          cargo fmt --manifest-path src-tauri/Cargo.toml --check
        step 'src-tauri: clippy -D warnings' \
          cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
        step 'src-tauri: clippy --features bench' \
          cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --features bench -- -D warnings
        step 'src-tauri: cargo test (shielded)' \
          env HOUSTON_CHANNEL=dev ./scripts/oom-shield.sh \
              cargo test --manifest-path src-tauri/Cargo.toml

        step 'ui: bun install'   bash -c 'cd ui && bun install --frozen-lockfile'
        step 'ui: typecheck'     bash -c 'cd ui && bun run typecheck'
        step 'ui: test'          bash -c 'cd ui && bun run test'
        step 'ui: build'         bash -c 'cd ui && bun run build'
        step 'ui: check:css'     bash -c 'cd ui && bun run check:css'
        step 'ui: check:bundle'  bash -c 'cd ui && bun run check:bundle'

        for s in check-watchdog check-dev-channel check-kill-guard check-protocol-sync \
                 check-loop-spawn-sync check-title-tooltip-guard \
                 check-spawn-window; do
          step \"safety: \$s\" \"./scripts/\$s.sh\"
        done

        echo ''
        if [ \"\$fail\" -eq 0 ]; then
          echo '=== GATE OK ==='
        else
          echo '=== GATE FAILED -- see FAIL lines above ==='
        fi
        exit \"\$fail\""
    ;;

  build)
    vm_detach build "vmcd $VM_REPO
(cd ui && bun install --frozen-lockfile)
./scripts/build-app.sh --bundles appimage,deb"
    echo "[linux-vm] follow with: ./scripts/linux-vm.sh wait build"
    ;;

  wait)
    vm_wait "${2:-build}"
    ;;

  app)
    vm "set -e; vmcd $VM_REPO
        deb=\$(find src-tauri/target/release/bundle/deb -name '*.deb' | head -1)
        [ -n \"\$deb\" ] || { echo 'no .deb -- run: linux-vm.sh build'; exit 1; }
        sudo dpkg -i \"\$deb\" >/dev/null 2>&1 || sudo apt-get -f install -y -qq
        ldd /usr/bin/houston | grep -i 'not found' && echo 'MISSING LIBS' || echo 'libs OK'
        export WEBKIT_DISABLE_DMABUF_RENDERER=1
        setsid nohup /usr/bin/houston > \$HOME/app.log 2>&1 < /dev/null &
        echo \$! > \$HOME/app.pid
        sleep 12
        if kill -0 \$(cat \$HOME/app.pid) 2>/dev/null; then
          ps -o pid,rss,etime,comm -p \$(cat \$HOME/app.pid); echo ALIVE
        else
          echo 'DIED'; tail -20 \$HOME/app.log
        fi"
    echo
    echo "[linux-vm] the window is on the WINDOWS desktop. Confirm it from PowerShell:"
    echo "  Get-Process | Where-Object { \$_.MainWindowTitle -ne '' } | Select Name,MainWindowTitle"
    echo "  -> expect: msrdc   Houston ($DISTRO)"
    echo "  (wmctrl/xwininfo will NOT see it: GTK takes the Wayland backend under WSLg)"
    ;;

  app-stop)
    vm "p=\$(cat \$HOME/app.pid 2>/dev/null || true)
        if [ -n \"\$p\" ] && kill -0 \"\$p\" 2>/dev/null; then
          kill \"\$p\" && echo \"[linux-vm] stopped \$p\"
        else
          echo '[linux-vm] nothing recorded in ~/app.pid is alive'
        fi"
    ;;

  *)
    sed -n '2,25p' "$0"
    exit 1
    ;;
esac
