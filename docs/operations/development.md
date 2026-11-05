# Development

Everything a contributor needs from a fresh checkout to a green gate: building, running,
the dev/release channel split, the check cadence, and what each OS's build produces.
Production launch is `scripts/start.sh` ([release](release.md)); the WSL2 testbed is
[linux-testbed](linux-testbed.md).

## First checkout

### Linux prerequisites

Installed once on a bare Debian/Ubuntu machine (another distribution's package names will
differ):

1. Node.js at the version in the root `package.json`, and pnpm 12.14.0 (or
   `npx -y pnpm@12.14.0`).
2. Rust via rustup, `https://rustup.rs`, for the host's native helper crates.
3. Linux system packages:

   ```sh
   sudo apt-get install -y \
     build-essential pkg-config libfuse2 xz-utils binutils \
     gnome-keyring dbus-x11 minisign
   ```

   `libfuse2`, `xz-utils` and `binutils` are only needed to bundle the AppImage and deb.
   Ubuntu 22.04 is the release baseline, and it names the FUSE 2 runtime `libfuse2`.
   `gnome-keyring` and `dbus-x11` provide the private Secret Service that
   `scripts/with-test-keyring.sh` starts for server tests. `minisign` is required by
   `python3 scripts/test-update-manifest.py` and the release manifest generator.

4. Workspace dependencies, once per clone and whenever `pnpm-lock.yaml` changes:
   `pnpm install --frozen-lockfile`.

Then:

```
./scripts/dev.sh                 # dev channel, build + run
```

The development script runs `pnpm run build:desktop`, which builds the renderer, the server
bundle and the Electron main process, then launches
`node apps/desktop/scripts/start-electron.mjs` with the resolved channel. The host attaches
to the channel's running server or spawns one detached. Close the existing window for that
channel before relaunching: a second launch focuses the running instance instead of loading
the rebuilt renderer.

### Windows prerequisites

Use Windows 10 or 11 on x86_64 with the Rust MSVC toolchain, Visual Studio C++ build tools
and a Windows SDK for the native helper crates. Install Git for Windows, Node.js and pnpm.
From PowerShell at the repository root:

```powershell
pnpm install --frozen-lockfile
$env:CARGO_BUILD_JOBS = '3'
./scripts/dev.ps1
```

`dev.ps1` is a port of `dev.sh`. State lives in `%USERPROFILE%\.houston-dev`.

## Dev channel vs release channel

**Important safety boundary.** A channel is an isolated state universe: its own server, its
own SQLite database and its own runtime file.

| Channel   | Channel directory   | How you get it                                                                                                       |
| --------- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `release` | `~/.houston`        | The installed app's live state. Only via explicit `--channel release`.                                               |
| `dev`     | `~/.houston-dev`    | `dev.sh`'s unconditional default.                                                                                    |
| named     | `~/.houston-<name>` | `--channel <name>`, validated against `^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$` (mirrors `paths.rs::validate_channel`). |

The server keeps its state in `<channel dir>/v2/`; its log is
`<channel dir>/v2/logs/v2-server.log`, and clients find it through
`<channel dir>/v2/userdata/server-runtime.json`. Upstream's server ownership lock refuses a
second server for the same directory. Never point a development server at `~/.houston`,
and never pass `--channel release` unless you mean to drive the installed app's own server;
`dev.sh` prints a warning naming the live directory when you do.

A v1 install's state (`houston.db`, scrollback and its other files directly under the
channel directory) is never written by v2. The host's start-up cleanup reads that directory
only to stand down while a v1 daemon of the same channel still runs, then removes that
channel's v1 hook entries from the agent CLI configs. The `houston` MCP entries v1 shared
across channels (Claude, Codex and Antigravity) leave only while no other channel's v1
daemon runs.

`HOUSTON_SESSION` is set inside a pane of the installed v1 release; `dev.sh` uses it to
refuse `--fresh` from a pane on its own target channel.

## Running it

```
./scripts/dev.sh                 # dev channel, build + run
./scripts/dev.sh --channel NAME  # target a named channel instead of dev
./scripts/dev.sh --print-target  # print resolved channel/state dir, no side effects
```

`scripts/dev.sh` builds a static renderer. For hot reload while working on the renderer,
run `pnpm dev:desktop`, which serves the Vite dev server and launches Electron against it
with state in the worktree.

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

### Disk usage

Every checkout and worktree has its own `target/`, which only grows. Agent worktrees under
`.houston/worktrees/` multiply this.

- `scripts/sweep-targets.sh` deletes artifacts untouched for `HOUSTON_SWEEP_DAYS` (default 3) and artifacts built by toolchains rustup no longer has, in the main checkout and every
  worktree below it, and trims each target directory to `HOUSTON_SWEEP_MAXSIZE` (default
  15 GB). `--dry-run` lists what it would delete; `--install` runs it hourly through a
  systemd user timer. It needs `cargo install cargo-sweep`.
- Agent worktrees build and test the dev profile only; `--release` belongs to the main
  checkout when packaging. Remove an agent worktree once its branch is integrated.
- A shared `build.build-dir` (Cargo 1.91+) in your user config moves the intermediates out
  of each `target/`; set it outside the repository and keep it on the same filesystem as
  the checkouts.

### Env knobs (developer-facing)

| Var               | Effect                                                         |
| ----------------- | -------------------------------------------------------------- |
| `HOUSTON_CHANNEL` | Names the channel; unset or `release` uses `~/.houston`.       |
| `HOUSTON_HOME`    | Overrides the base directory, keeping state beside a checkout. |

## Checks

### Cadence

**Per item** (in the package or crate touched), run constantly:

- `apps/desktop/native` and `native`: `cargo fmt`, `cargo clippy --all-targets -- -D warnings`
  and the touched tests (`cargo test <module>::`).
- `apps/` and `packages/`: the package's `typecheck` and the touched tests; for the server,
  `pnpm --filter @houston-app/cli exec vp test run <files>`.

**Before every push** — the full suites, Cargo inside `scripts/oom-shield.sh` on Linux and
with three jobs on Windows.

### Full gate commands

**The workspace** (the web build first: the server bundle copies `apps/web/dist` and the
desktop host serves it):

```
pnpm -r typecheck
pnpm --filter @houston-app/web build
pnpm --filter @houston-app/contracts --filter @houston-app/shared test
pnpm --filter @houston-app/cli exec vp test run src/houston
```

**The native crates** (`apps/desktop/native` and `native`):

```
cargo fmt --all --check
cargo clippy --all-targets -- -D warnings
cargo test -- --test-threads=3
```

On Linux, run server tests through `scripts/with-test-keyring.sh` when keychain tests need
a Secret Service. Never run `gnome-keyring-daemon --unlock` directly on a desktop host, even
inside `dbus-run-session`: it opens the host's real login keyring and re-encrypts it with
the password read from stdin. The wrapper points `XDG_DATA_HOME` and `XDG_RUNTIME_DIR` at a
temporary directory. The bare `--unlock` recipe is only safe in CI and the testbed VM.

### The safety scripts

Hermetic, sub-second text-search invariants, run in `ci.yml`'s `static` job.

| Script                          | Enforces                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `check-dev-channel.sh`          | `dev.sh`'s channel resolution: inherited env never wins, `--channel` validation, `--print-target` has no side effects                      |
| `check-case-collisions.sh`      | tracked paths stay unique on case-insensitive filesystems                                                                                  |
| `check-doc-hygiene.sh`          | Markdown only in the allowed tree, with no dates, phase numbers, other product names or dead pointers; `static` runs it without `handoff/` |
| `check-comment-hygiene.sh`      | a comment block is at most three lines and names no date, plan number, other app or person                                                 |
| `check-web-style.sh`            | the `apps/web` design-system guards; `--self-test` proves each fires on its bad fixture                                                    |
| `check-third-party-licenses.sh` | the committed inventory matches the native crates' Cargo graphs and the pnpm workspace; it runs in the `static` job                        |

The `apps/web` style rules keep a per-file count in `scripts/web-style-baseline/<rule>.baseline`.
CI fails on a new file, a raised count or a stale entry; after removing a violation, lower
the pin with `--update` (never raise it).

### What CI runs

[CI](../internals/ci.md) describes the workflow, its path filter and its runner variables.

| Job                            | What it does                                                                                                                                                                                                   |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`                      | classifies the changed paths; an unclassified path runs every job                                                                                                                                              |
| `static`                       | the safety scripts, workflow syntax, the offline release-note and updater-signature regression tests, doc and comment hygiene, the web style guards, the upstream licence notice and the third-party inventory |
| `typecheck`                    | the cached workspace typecheck                                                                                                                                                                                 |
| `test-packages`                | the workspace package suites and the script tests                                                                                                                                                              |
| `test-server`                  | the server suites in six shards                                                                                                                                                                                |
| `test-web`, `test-web-browser` | the renderer build and its unit and browser vitest projects                                                                                                                                                    |
| `native-linux`                 | `cargo test` for the Houston 1 cleanup helper and the Linux capture helpers; only native paths run it on PRs                                                                                                   |
| `server-windows`               | the server suites in three Windows shards, gated on a shrinking list of known failures                                                                                                                         |
| `ci-gate`                      | the aggregate check every branch requires                                                                                                                                                                      |

## Maintaining model data

Houston reads LiteLLM's
[`model_prices_and_context_window.json`](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json)
through the shared model catalog. Use `max_input_tokens` for the context window; do not
substitute `max_tokens`, which upstream entries often use for output limits. Contribute
missing or incorrect metadata upstream to LiteLLM.

## Desktop artifacts per OS

### Linux

```
pnpm dist:desktop:linux                                    # AppImage
node scripts/build-desktop-artifact.ts --platform linux --target deb
```

Output lands in `release/` as `Houston-<version>-x86_64.AppImage` and
`Houston-<version>-amd64.deb`. The packaging script stages the server, builds the native
helpers and hands the result to electron-builder.

Local install, separate from packaging:

```
./scripts/install-desktop.sh
```

It copies `release/Houston-*.AppImage` into `~/.local/lib/houston/houston.AppImage` (or takes
`TR_APP`), then writes `launch.sh`, `start.sh` and the `.desktop` file. After writing them it
refuses any of them that names the repository's own path, so the installed app never
executes a path inside the repository.

### Windows

```
pnpm dist:desktop:win
```

Output lands in `release/` as `Houston-<version>-x64-setup.exe`. The release workflows supply
the updater signing keys.

**The Windows installer is not Authenticode-signed**, so SmartScreen warns on first run.
