# Development

Everything a contributor needs from a fresh checkout to a green gate: building, running,
the dev/release channel split, the check cadence, and what each OS's build produces.
Production launch is `scripts/start.sh` ([release](release.md)); the WSL2 testbed is
[linux-testbed](linux-testbed.md).

## First checkout

### Linux prerequisites

Installed once on a bare Debian/Ubuntu machine (another distribution's package names will
differ):

1. Rust toolchain via rustup, `https://rustup.rs` (CI uses the `stable` toolchain).
2. Node.js at the version in the root `package.json`, and pnpm 12.14.0 (or
   `npx -y pnpm@12.14.0`).
3. The pinned Tauri CLI: `cargo install tauri-cli --version 2.11.4 --locked`.
4. Linux system packages:

   ```sh
   sudo apt-get install -y \
     build-essential pkg-config libdbus-1-dev libwebkit2gtk-4.1-dev \
     librsvg2-dev patchelf libfuse2 libayatana-appindicator3-dev \
     gnome-keyring dbus-x11 minisign
   ```

   `patchelf` and `libfuse2` are only needed to bundle an AppImage. Ubuntu 22.04 is the
   release baseline, and it names the FUSE 2 runtime `libfuse2`. `gnome-keyring` and
   `dbus-x11` provide the private Secret Service that `scripts/with-test-keyring.sh` starts
   for host tests. `minisign` is required by `python3 scripts/test-update-manifest.py` and
   the release manifest generator.
5. Workspace dependencies, once per clone and whenever `pnpm-lock.yaml` changes:
   `pnpm install --frozen-lockfile`.

Then:

```
./scripts/dev.sh                 # dev channel, build + run
```

The development script builds the renderer (`pnpm --filter @t3tools/web build`), the
server bundle (`pnpm --filter houston build:bundle`) and the debug host (`cargo build` in
`src-tauri`), then `exec`s `src-tauri/target/debug/houston-tauri --channel <target>`. The
host attaches to the channel's running server or spawns one detached. Close the existing
window for that channel before relaunching: a second launch focuses the running instance
instead of loading the rebuilt renderer.

### Windows prerequisites

Use Windows 10 or 11 on x86_64 with the Rust MSVC toolchain, Visual Studio C++ build tools
and a Windows SDK. Install Git for Windows, Node.js, pnpm and the same pinned Tauri CLI. The
app uses WebView2; install its runtime if it is missing. From PowerShell at the repository
root:

```powershell
pnpm install --frozen-lockfile
$env:CARGO_BUILD_JOBS = '3'
./scripts/dev.ps1
```

`dev.ps1` is a port of `dev.sh`. State lives in `%USERPROFILE%\.houston-dev`.

## Dev channel vs release channel

**Important safety boundary.** A channel is an isolated state universe: its own server, its
own SQLite database and its own runtime file.

| Channel | Channel directory | How you get it |
|---|---|---|
| `release` | `~/.houston` | The installed app's live state. Only via explicit `--channel release`. |
| `dev` | `~/.houston-dev` | `dev.sh`'s unconditional default. |
| named | `~/.houston-<name>` | `--channel <name>`, validated against `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$` (mirrors `paths.rs::validate_channel`). |

The server keeps its state in `<channel dir>/v2/`; its log is
`<channel dir>/v2/logs/v2-server.log`, and clients find it through
`<channel dir>/v2/userdata/server-runtime.json`. Upstream's server ownership lock refuses a
second server for the same directory. Never point a development server at `~/.houston`,
and never pass `--channel release` unless you mean to drive the installed app's own server;
`dev.sh` prints a warning naming the live directory when you do.

A v1 install's state (`houston.db`, scrollback and its other files directly under the
channel directory) is never written by v2. The host's start-up cleanup reads that directory
only to stand down while a v1 daemon of the same channel still runs, then removes that
channel's v1 hook and MCP entries from the agent CLI configs.

`HOUSTON_SESSION` is set inside a pane of the installed v1 release; `dev.sh` uses it to
refuse `--fresh` from a pane on its own target channel.

## Running it

```
./scripts/dev.sh                 # dev channel, build + run
./scripts/dev.sh --channel NAME  # target a named channel instead of dev
./scripts/dev.sh --print-target  # print resolved channel/state dir, no side effects
```

**No hot reload.** The renderer is a built artifact embedded by the host. Re-run the
development script after a renderer edit.

### `scripts/oom-shield.sh`

Runs a command inside a transient `systemd-run --user --scope` with capped memory and
lowered priority, so `systemd-oomd` has a smaller victim than your whole terminal scope.

```
./scripts/oom-shield.sh <command> [args...]
```

- **Caps**: `MemoryHigh=16G`, `MemoryMax=18G` (override via `OOM_SHIELD_MEMORY_HIGH` and
  `OOM_SHIELD_MEMORY_MAX`). Swap is uncapped by default (`OOM_SHIELD_MEMORY_SWAP_MAX` opts
  in).
- Applies `nice -n 19` to the wrapped command unconditionally.
- A second invocation waits on a global per-user `flock`, announcing itself, rather than
  running concurrently: the shield bounds one scope, not the sum of two.

**Never run two Cargo workloads concurrently**, shielded or not.

### Cargo dev profile

`src-tauri/Cargo.toml` sets `[profile.dev] debug = "line-tables-only"` and
`[profile.dev.package."*"] debug = false`: dependencies get no debug info, Houston's code
keeps line tables for exact backtraces. Full DWARF for a debugging session:
`CARGO_PROFILE_DEV_DEBUG=2 cargo build`.

### Disk usage

Every checkout and worktree has its own `target/`, which only grows. Agent worktrees under
`.houston/worktrees/` multiply this.

- `scripts/sweep-targets.sh` deletes artifacts untouched for `HOUSTON_SWEEP_DAYS` (default
  3) and artifacts built by toolchains rustup no longer has, in the main checkout and every
  worktree below it, and trims each target directory to `HOUSTON_SWEEP_MAXSIZE` (default
  15 GB). `--dry-run` lists what it would delete; `--install` runs it hourly through a
  systemd user timer. It needs `cargo install cargo-sweep`.
- Agent worktrees build and test the dev profile only; `--release` belongs to the main
  checkout when packaging. Remove an agent worktree once its branch is integrated.
- A shared `build.build-dir` (Cargo 1.91+) in your user config moves the intermediates out
  of each `target/`; set it outside the repository and keep it on the same filesystem as
  the checkouts.

### Env knobs (developer-facing)

| Var | Effect |
|---|---|
| `HOUSTON_DEVTOOLS=1` | Opens the webview devtools on launch. |
| `HOUSTON_NODE=<path>` | The Node.js the host runs the server with in a development build. |
| `HOUSTON_V2_SERVER_ENTRY=<path>` | The server entry the host starts instead of the bundled one. |
| `RUST_LOG` | `tracing` filter for the host log (default `houston_tauri=info`). |

## Checks

### Cadence

**Per item** (in the package or crate touched), run constantly:

- `src-tauri`: `cargo fmt`, `cargo clippy --all-targets -- -D warnings` and the touched
  tests (`cargo test <module>::`).
- `apps/` and `packages/`: the package's `typecheck` and the touched tests; for the server,
  `pnpm --filter houston exec vp test run <files>`.

**Before every push** — the full suites, Cargo inside `scripts/oom-shield.sh` on Linux and
with three jobs on Windows.

### Full gate commands

**The workspace** (the web build first: `src-tauri` embeds it at compile time, and
`tauri::generate_context!()` panics without `apps/web/dist`):

```
pnpm -r typecheck
pnpm --filter @t3tools/web build
pnpm --filter @t3tools/contracts --filter @t3tools/shared test
pnpm --filter houston exec vp test run src/houston
node scripts/check-upstream.mjs <upstream clone> --skip apps/web
```

The upstream clone is checked out at `upstream.json`'s `commit`.

**`src-tauri/`**:

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test -- --test-threads=3
```

On Linux, run `cargo test` through `scripts/with-test-keyring.sh` when keychain tests need
a Secret Service. Never run `gnome-keyring-daemon --unlock` directly on a desktop host, even
inside `dbus-run-session`: it opens the host's real login keyring and re-encrypts it with
the password read from stdin. The wrapper points `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` at a
temporary directory. The bare `--unlock` recipe is only safe in CI and the testbed VM.

### The safety scripts

Hermetic, sub-second text-search invariants, run in `ci.yml`'s `safety-checks` job.

| Script | Enforces |
|---|---|
| `check-dev-channel.sh` | `dev.sh`'s channel resolution: inherited env never wins, `--channel` validation, `--print-target` has no side effects |
| `check-kill-guard.sh` | `kill(2)` and the Win32 process calls only in `src-tauri/src/sys/pid.rs` |
| `check-case-collisions.sh` | tracked paths stay unique on case-insensitive filesystems |
| `check-spawn-window.sh` | `src-tauri/clippy.toml` still disallows bare `Command::new`, and `src-tauri/src/sys/spawn.rs` applies `CREATE_NO_WINDOW` |
| `check-env-ratchet.sh` | direct process-environment reads under `src-tauri/src/sys` only go down (`scripts/env-ratchet.baseline`, `--update` after removing one) |
| `check-doc-hygiene.sh` | Markdown only in the allowed tree, with no dates, phase numbers, other product names or dead pointers; `v2-checks` runs it without `handoff/` |
| `check-comment-hygiene.sh` | a comment block is at most three lines and names no date, plan number, other app or person |
| `check-web-style.sh` | the `apps/web` design-system guards; `--self-test` proves each fires on its bad fixture |
| `check-third-party-licenses.sh` | the committed inventory matches `src-tauri`'s Cargo graph and the pnpm workspace; it runs in the `licence-inventory` job |

The `apps/web` style rules keep a per-file count in `scripts/web-style-baseline/<rule>.baseline`.
CI fails on a new file, a raised count or a stale entry; after removing a violation, lower
the pin with `--update` (never raise it).

`check-binary-fresh.sh` runs at install time, from `install-desktop.sh`: it refuses a
release binary older than `src-tauri`'s sources.

### What CI runs

| Workflow and job | What it does |
|---|---|
| `ci.yml` `safety-checks` | the safety scripts, workflow syntax, and the offline release-note and updater-signature regression tests |
| `ci.yml` `linux-native-checks` | the web build, then `src-tauri` formatting, Clippy and tests with an isolated keyring |
| `ci.yml` `windows-checks` | the same on Windows 2022 |
| `ci.yml` `licence-inventory` | regenerates the third-party inventory and diffs it against the committed copy |
| `v2-checks.yml` | the workspace typecheck and suites, the web build, the upstream drift check and the doc hygiene check without `handoff/` |

## Maintaining model data

Houston reads LiteLLM's
[`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
through the shared model catalog. Use `max_input_tokens` for the context window; do not
substitute `max_tokens`, which upstream entries often use for output limits. Contribute
missing or incorrect metadata upstream to LiteLLM.

## Desktop artifacts per OS

### Linux

```
./scripts/build-app.sh                  # appimage,deb
./scripts/build-app.sh --bundles deb    # other bundle targets
```

Build the renderer and stage the server first (`pnpm --filter @t3tools/web build`,
`pnpm --filter houston build:exe`, `node scripts/stage-v2-server.mjs`). `build-app.sh`
re-execs itself under `scripts/oom-shield.sh` (`-j 3`) unless already shielded, then runs
`CARGO_BUILD_JOBS=3 cargo tauri build --bundles <targets>`. Output lands at
`src-tauri/target/release/bundle/{appimage,deb}/*.{AppImage,deb}`. Use `build-app.sh`
rather than invoking `cargo tauri build` directly.

Local install, separate from packaging:

```
./scripts/install-desktop.sh
```

It refuses a missing or stale app binary and, after writing `launch.sh`, `start.sh` and the
`.desktop` file, any of them that names the repository's own path, so the installed app
never executes a path inside the repository. Installs
`~/.local/lib/houston/{houston, start.sh, launch.sh}`,
`~/.local/share/applications/houston.desktop` and icon PNGs under
`~/.local/share/icons/hicolor/**/apps/houston.png`.

### Windows

```
./scripts/build-app.ps1
cd src-tauri
cargo tauri bundle --bundles nsis --ci --no-sign
```

`build-app.ps1` builds the application with `cargo tauri build --no-bundle --ci -- --locked`;
the separate `bundle` command packages that build without compiling it again. Release
workflows provide the updater signing keys. Output lands at
`src-tauri/target/release/bundle/nsis/*.exe`.

**The Windows installer is not Authenticode-signed**, so SmartScreen warns on first run.
