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
channel's v1 hook entries from the agent CLI configs. The `houston` MCP entries v1 shared
across channels (Claude, Codex and Antigravity) leave only while no other channel's v1
daemon runs.

`HOUSTON_SESSION` is set inside a pane of the installed v1 release; `dev.sh` uses it to
refuse `--fresh` from a pane on its own target channel.

## Running it

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
```
./scripts/dev.sh                 # dev channel, build + run
./scripts/dev.sh --channel NAME  # target a named channel instead of dev
./scripts/dev.sh --print-target  # print resolved channel/state dir, no side effects
=======
### Replay provider

`vp run dev` registers `Replay (dev)`, a local ACP agent at
[dev-replay-agent.ts](../../apps/server/scripts/dev-replay-agent.ts). It plays recorded
ACP transcripts with simulated streaming, so the real adapter, orchestration, and UI run
without a paid model. Each scenario is a model, and each prompt plays the next recorded turn.
Bundled servers, including desktop dev, skip it because they have no agent script.
Dev servers add it back on start, so turn it off in Settings instead of removing it.
To add a scenario, point a `SCENARIOS` entry at a generic ACP replay fixture
(`registry_transcript.ndjson`) or a file in [dev-replay](../../apps/server/scripts/dev-replay).
The agent replays session updates, permission requests, and questions. It drops session setup
and vendor frames, so Grok and fx recordings lose their vendor-only behavior.

### Profiling dev startup

Run `vp run profile:startup` to capture the first 20 seconds of inherited Node processes under
`.t3/startup-profiles/<timestamp>`. Workers that execute the preload get separate profiles.
It starts the normal dev runner and accepts its flags.
Stop it with Ctrl+C after the capture. Set `T3CODE_STARTUP_PROFILE_DIR` to choose another output
directory. Profiling adds overhead, so compare readiness with an ordinary `vp run dev` run.

Open a `.cpuprofile` in Chrome DevTools' Performance panel for sampled function stacks and source
lines. Each `.modules.json` is a Chrome trace containing timed module resolution, loading,
synchronous subprocess calls, and startup measures. Per-file records include importer URLs,
source loading, preparation, recursive dependency linking, and top-level evaluation. Preparation
uses synchronous loader boundaries; linking includes dependencies, and CommonJS evaluation can
include nested `require` calls. Some ESM/CommonJS interop reports a combined stage. `.process.json` records the process, Node version, and capture window.
The server's nested Effect and SQL spans remain in `.t3/userdata/logs/server.trace.ndjson`.

The preload temporarily adds module-body timing markers and uses one automatic debugger pause
to instrument the live Node loader. The launcher adds `--no-node-snapshot` to inherited
`NODE_OPTIONS` because Node 26's snapshotted loader cannot accept that breakpoint. Include the
same flag when using the preload directly. This disables Node's built-in startup snapshot,
can change compilation-cache hits, and adds overhead.
Treat per-file captures as diagnostic runs; use uninstrumented runs for baseline startup latency.
The first entry module can compile before loader instrumentation is installed.

A fresh process still uses filesystem, Node compilation, provider, and Vite dependency caches.
Measure a missing Vite dependency cache separately from a restart with an existing database.
Neither the Vite ready message nor the HTTP listener proves that a browser has rendered the app.

### Sharing and remote debugging

`vp run dev --share` publishes the web port over the machine's tailnet and prints a pairing URL
for that origin. Give the tester the complete URL, including its token. The dev runner removes
its mapping on exit.

Leave `VITE_HTTP_URL` and `VITE_WS_URL` unset. Vite proxies the backend through the browser's
origin so the same build works over localhost and remote connections.

Shared runs enable bundled dev to avoid a network round trip for each import level.
`T3CODE_BUNDLED_DEV=0` opts out when debugging bundler differences. Two reload traps matter
when changing this setup:

- The web entry must dynamically import the app so React refresh initializes before application
  chunks. Static imports can work on first load and fail after a route split.
- Bundled dev rebuilds Tailwind through watched files. Its ordinary Vite hot-update hook expects
  a server/module graph that Rolldown does not provide.
- The app and its routes are lazy chunks, built on first request. A plugin pre-bundles the
  startup chain when the server starts. Renaming or moving a startup route or the app entry
  silently drops it from that list.

The workarounds live in the [web entry](../../apps/web/src/bootstrap.ts),
[Tailwind plugin](../../apps/web/vite/tailwind.ts), and
[startup warmup](../../apps/web/vite/warmBundledDev.ts).

`vp run dev --share --built` skips the Vite dev server. It runs `vp build --watch` for the web
app, and the backend serves `apps/web/dist` on the same tailnet URL and pairing flow. Use it when
someone tests over a slow link or only needs to use the app: loads are production size, and the
first load does not wait for dev bundling. There is no HMR. After an edit, wait for the
`built in` line (about 6 s), then reload. Until the first build exists, the URL shows a page that
reloads by itself. The license manifest is not generated in this mode. `--built` requires
`--share` and the `dev` mode.

#### Reusable dev credential

Use this only on a hostname where you trust every service. Browsers send cookies to all ports
on that hostname. Any service you visit there can receive the reusable admin credential,
including services unrelated to T3 Code. If you run untrusted services on that hostname, keep
normal per-environment pairing instead.

To use one browser profile across web dev worktrees on the same hostname, generate one fixed
value once:

```sh
openssl rand -hex 32
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb
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

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
### Cadence
=======
`vp run check:changed` runs CI's fast checks for your branch's changes: format and lint of the
changed files, `knip:check` when code or a manifest changes, the generated GraphQL checks, typecheck
of the affected packages and their dependents, and the test files beside the changed files. It also
runs the checks that read other files: the agent context budget when the server is affected, and
React Compiler coverage for only the changed web and mobile files. It maps
files to packages with [ci-changes.cjs](../../.github/scripts/ci-changes.cjs), as CI does. It
compares against the closest merge base with any remote's `main`, so a fork whose `main` lags
upstream still compares against upstream, or with a ref you pass. CI still runs the full
test suites and the jobs the summary lists, so a local pass does not promise a green CI run.
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

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

<<<<<<< 57f5b2527b386f5e6f3426d989d40921b2199f5b
### The safety scripts
=======
### Prepared server bytecode

Native macOS and Windows desktop artifact builds generate server bytecode with the packaged
Electron executable, after ASAR creation and before signing. Linux builds skip generation until
native packaging and relocated AppImage reuse have been validated. Cross-platform and
cross-architecture builds also skip generation explicitly. CLI, SEA and WSL runtimes keep their
existing behavior; only desktop backend imports covered by generation receive prepared bytecode.
Worker-only modules compile normally.

Electron's Node 24 cache has no read-only option and includes the producer UID in its directory
name. The backend links individual prepared files into its writable cache with keys for the
installed module paths. Node replaces files atomically, so regeneration cannot write through those
links into signed resources. Windows uses hard links and falls back to normal caching when volumes
differ or resource permissions prevent linking. Protected installations therefore may not reuse
prepared bytecode. No cache bytes are copied during startup.

The key calculation follows Node's internal portable ESM format. Generation checks that the
packaged engine produced the expected CLI entry and fails the build if that format changes.
The manifest also checks Electron, Node, OS, architecture and V8's flags-sensitive version tag.
Missing or rejected entries compile from the shipped JavaScript. Prepared backends skip the
explicit startup flush; Node can persist missing entries on normal exit. The writable fallback
keeps the explicit flush needed when Windows force-kills the backend.

### Linux AppImage prerequisites
>>>>>>> e6e2ab05cceb3f8245e87f8499d4891f27de33cb

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
