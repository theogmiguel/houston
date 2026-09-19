# Linux testbed (WSL2)

Houston is Linux-first; developing from Windows means everything behind
`#[cfg(target_os = "linux")]` (`gtk_host.rs`, `webkit.rs`,
`watchdog/gtk_signals.rs`, …) never compiles on the host machine — only a
Linux compile catches a break there. `scripts/linux-vm.sh` drives a WSL2
clone from the Windows side for exactly that.

```
./scripts/linux-vm.sh status
./scripts/linux-vm.sh sync [--force]
./scripts/linux-vm.sh run '<shell command>'
./scripts/linux-vm.sh exec <local-script.sh>
./scripts/linux-vm.sh gate
./scripts/linux-vm.sh build
./scripts/linux-vm.sh wait [build|gate]
./scripts/linux-vm.sh app
./scripts/linux-vm.sh app-stop
```

Runs from Git Bash on the Windows host (`wsl.exe` must be on `PATH`). Distro
name and VM-side clone path override via `LINUX_VM_DISTRO`/`LINUX_VM_REPO`
(defaults `Ubuntu-24.04` / `$HOME/Houston`).

## Safety constraints enforced by the script

- **PATH.** `bash -lc` is a login shell, but Ubuntu's `~/.bashrc`
  early-returns for non-interactive shells before reaching the cargo/bun
  exports, so a naive login shell never sees either. Every remote command
  sources `~/.cargo/env` and prepends `~/.bun/bin` explicitly first.
- **Wrong directory.** A `cd` that silently no-ops leaves later commands
  running against the 9p-mounted `/mnt/c/...` view of the Windows tree
  instead of the VM's own clone — every file there reads as modified over 9p
  (false "dirty"), and a real `gate`/`build` would compile the wrong tree
  entirely, with `target/` sitting on 9p. The shared `vmcd` helper does the
  `cd` and then asserts the landing directory is never under `/mnt/`,
  aborting loudly if it is.
- **Argv corruption on multi-line/`$(...)` commands.** Passing a command as
  an inline `wsl.exe -d "$DISTRO" -- bash -lc "$STRING"` argument corrupts
  across the Windows→WSL hop for anything multi-line or containing command
  substitution — a `cd` could report success and then later commands ran as
  if it hadn't happened. Every remote command instead goes over **stdin**
  into a file, which is then sourced — never passed as an inline argv
  string.
- **Detached jobs: sentinel file, never `pgrep`.** `build` runs detached via
  a sentinel-status-file pattern (`vm_detach`/`vm_wait`). Never poll
  `pgrep -f` for completion — a watcher whose own command line contains the
  search pattern can match itself and wait indefinitely after the build has
  already exited.
- **`WEBKIT_DISABLE_DMABUF_RENDERER=1`.** WSLg maps no GPU, so
  `linux-vm.sh app` exports this to avoid a blank WebKitGTK window;
  libEGL/MESA warnings in the resulting log are expected software-rendering
  noise. Never measure UI performance in this VM.
- **Stop by recorded pid only.** `app-stop` kills only the pid `app`
  recorded to `~/app.pid` — never by pattern (AGENTS.md danger #1).

## `sync --force`

`sync` pulls from GitHub; the VM cannot see uncommitted Windows-side work, so
push first. Plain `sync` refuses on a dirty VM clone rather than discarding
it. `sync --force` runs `git checkout -- .` on the VM clone before pulling —
it discards whatever is sitting there uncommitted, on the VM only.

## `gate`

Runs, sequentially (core and src-tauri never concurrently — AGENTS.md's
"never two cargo workloads at once" extends across the VM boundary too):
`core` (`fmt --check`, `clippy -D warnings`, `cargo test` shielded under
`oom-shield.sh` + `dbus-run-session` + unlocked `gnome-keyring`), `src-tauri`
(`fmt --check`, `clippy` default + `--features bench`, `cargo test`
shielded), `ui` (`bun install --frozen-lockfile`, `typecheck`, `test`,
`build`, `check:css`, `check:bundle` — build before `check:bundle`, since
that reads `bundle-stats.json`, which build emits).

**Drift**: after the crate/UI steps, `gate` loops over only **seven**
safety scripts — `check-watchdog`, `check-dev-channel`, `check-kill-guard`,
`check-protocol-sync`, `check-loop-spawn-sync`, `check-title-tooltip-guard`,
`check-spawn-window` — missing eighteen more that CI's `safety-checks` job
runs, `check-icon-imports` and `check-native-select` among them. A green
`linux-vm.sh gate` is not a green CI; it silently skips those eighteen
checks. See `docs/operations/development.md` for the full twenty-five and
`docs/operations/release.md` for where this bites a local release.

`set -uo pipefail`, not `-e`: every step runs regardless of earlier
failures, so one `gate` run reports everything wrong instead of stopping at
the first `FAIL`.

## VM prerequisites

- **Node/toolchain**: needs a current Node — an old Node 18 breaks
  `check:css`/vitest. Confirm via `linux-vm.sh status`, which prints
  `cargo`/`bun`/`node` resolution.
- **Secret Service / gnome-keyring**: `voice::cloud`'s tests talk to a Secret
  Service; `gate`'s core test step runs under `dbus-run-session` with
  `gnome-keyring-daemon --unlock` for this reason — same fix CI's `core` job
  uses. Order matters: the shield (`oom-shield.sh`, needs the **real**
  session bus via `systemd-run --user`) wraps `dbus-run-session` (which
  replaces the bus with a private one), never the reverse — the reverse
  cannot reach the user manager.

## `app` / `app-stop`

`app` installs the built `.deb` and proves it boots — `check-renderer-fresh.sh`
cannot ("once a bundle exists, it will boot and write"; only actually running
it proves anything). Reads `~/.linux-vm-task.sh`-style state, launches with
`WEBKIT_DISABLE_DMABUF_RENDERER=1`, records the pid to `~/app.pid`, and
reports whether the process is alive after a short wait. The window surfaces
on the Windows desktop through WSLg (not visible to `wmctrl`/`xwininfo` — GTK
takes the Wayland backend under WSLg). `app-stop` kills only that recorded
pid.
