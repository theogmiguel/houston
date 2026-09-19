# Architecture

> For maintainers. Using Houston? Start at the [README](../../README.md).

Houston is two processes: a Tauri app, and a `houston-core` daemon it connects to over a
loopback WebSocket (spawning one, detached, if none is running for the channel). The daemon
is the execution boundary — every PTY, agent process, git call, hook and MCP request happens
there, and it outlives the app: quitting Houston closes the socket, not the daemon. The
renderer is a built Vite bundle embedded in the app binary that talks to the daemon over that
WebSocket and a handful of Tauri commands. Agent CLIs run as children of the daemon and talk
back to it over MCP.

The renderer paints Houston's own surfaces over a dithered background field in
Custom mode: one user image or preset behind the whole window, its output
luminance clamped into a bounded band so a build-time gate can prove chrome
legibility against an image it has never seen. Only the overlay tier (popovers, menus,
modals) uses `backdrop-filter`.

```
┌──────────────────────────────┐     /ws + /manage    ┌────────────────────────────────────┐
│ houston (Tauri app)          │  (loopback, token)    │ houston-core (daemon, detached)     │
│                              │◄─────────────────────►│                                      │
│  ┌─────────────────────┐    │                        │  tokio runtime                      │
│  │ renderer (WebKitGTK/ │    │                        │  axum: /ws  /manage  /mcp           │
│  │ WebView2)            │    │                        │        /orchestrate/*               │
│  │  React 19, ghostty/  │    │                        │  sessions · PTYs · scrollback        │
│  └─────────────────────┘    │                        │  hooks · mailboxes · routines        │
│  ┌─────────────────────┐    │                        │  SQLite (WAL) · keychain             │
│  │ browser panes        │    │                        └──────────────┬───────────────────────┘
│  │ (native child        │    │                                       │ portable-pty / russh
│  │  webviews)           │    │                         ┌─────────────▼──────────────────┐
│  └─────────────────────┘    │                         │ agent CLIs: claude, codex,       │
│  src-tauri: daemon_host      │                         │ antigravity, opencode,           │
│  (connect-or-spawn), fs,     │  spawns detached, Linux │ cursor-agent, grok, shell        │
│  browser/, watchdog/         │  via houston-supervisor │  hooks → drop files              │
└──────────────────────────────┘                         │  MCP → POST /mcp (per-pane token)│
                                                          └──────────────────────────────────┘
```

Quitting the app closes the `/ws` connection only. The daemon (and every session under it)
keeps running; the next launch of the app reconnects to it via `daemon.json`.

## Contents

| Doc | Covers |
|---|---|
| this file | process model, boundaries, repository map, budgets |
| [daemon.md](daemon.md) | sessions, the PTY pipeline, scrollback, persistence, background loops |
| [agent-lifecycle.md](agent-lifecycle.md) | hook installation, drop files, `AgentStatus`, liveness |
| [orchestration.md](orchestration.md) | the MCP endpoint, `pane_*` verbs, credentials, mailboxes, `hs-pane` |
| [renderer.md](renderer.md) | the shell, layout tree, terminal engine, transport, watchdog |
| [`protocol/protocol.md`](../../protocol/protocol.md) | the wire, message by message |

## Process model

### One daemon, one host — and an app that is a client

`houston-core` has exactly one `main`: `core/houston-core/src/main.rs`. Its boot order:
create the state dir → mint a UUIDv4 token → `server::bind("127.0.0.1:0")` →
`Daemon::new_bound` (restores sessions; needs the port to exist so each restored pane can
mint an MCP credential) → `server::start_with_listener` → write `daemon.json` → startup
refresh (hook installers, MCP self-registration, off the paint path) →
`boot::spawn_background_loops`. `check-loop-spawn-sync.sh` fails if anything besides this
`main` ever calls that spawn list. The app's `src-tauri/src/daemon_host.rs` implements
connect-or-spawn: read `daemon.json`, probe an
existing daemon over `/manage`, or spawn one detached — on Linux through the
`houston-supervisor` sidecar (forks `houston-core` as its child so the daemon survives an app
crash, and writes `supervisor.json` beside `daemon.json`), on Windows by spawning
`houston-core.exe` directly (no supervisor there).

`houston-core` and `houston-tauri` (the app) both answer three argv aliases before any
daemon/Tauri setup: `hook` (the hook client), `hs-mail` and `hs-pane` (the agent-facing
CLIs). The slim `tr-helper` binary executes `hook` without linking GTK/WebKit and returns a
named refusal for the retired `hs-mail` alias. A hook event through the full app or daemon
binary would otherwise load approximately 130 shared objects per invocation.

### Channels

A **channel** is one isolated state universe: `~/.houston` for `release` (the
installed app) and `~/.houston-<name>` for anything else, `dev` by default in
development. Everything hangs off the state dir: `houston.db`, `daemon.json`,
`daemon.lock`, `logs/`, `scrollback/`, `hooks/drop/`, `bin/`, the webview's
`data_directory`, the single-instance D-Bus id.

The binary resolves its channel from the `--channel` flag only. The ambient
`HOUSTON_CHANNEL` is the *pane* input — it tells a process which channel it is running
inside — and `resolve_owning_channel` refuses outright when neither is explicit, so a stray
invocation can never own `release` by accident. Channel names are validated (`[a-z0-9-]`,
1–32 chars) because they become a directory under `$HOME`.

### Singleton and `--fresh`

Mutual exclusion is an advisory `flock(2)` on `<state dir>/daemon.lock`, held by the
**daemon** only — the app never takes it, so it never leaks a lock across a crash or a
force-quit. Released by the kernel on any daemon exit, so there is no stale-lock path.
`daemon.json` (`{ port, token, pid, protocol, pid_creation }`, mode 0600) is written
tmp+rename beside it — never *as* it, since a rename swaps the inode out from under a lock.
`pid_creation` is a process-creation token so a recycled pid cannot be mistaken for the
daemon. On Linux, `supervisor.json` sits beside it, written by `houston-supervisor` for
whichever daemon it is currently forking as its child.

`--daemon-fresh` (a flag on the app binary) requests an orderly stop through `/manage`'s
`daemon_shutdown` verb — never a signal — then waits, pid-identity-checked, for the daemon to
actually exit before starting a fresh one; an unconfirmed shutdown (a non-`ok:true` response,
or the pid still alive after the wait) refuses rather than starting a second daemon on top of
the first. It refuses outright when `HOUSTON_SESSION` is set and the pane's channel equals
the target: you cannot stop the daemon hosting the pane you are running the command from.
`scripts/dev.sh --fresh` carries the same self-protection guard in bash, and drives the same
`/manage` call directly (reading `daemon.json` for port/token) so the refusal and the stop are
immediate rather than waiting on a build.

### Transport

The daemon serves an axum router on `127.0.0.1:<ephemeral>`:

| Route | Client | Purpose |
|---|---|---|
| `GET /ws` | renderer | control messages (JSON text frames) and PTY bytes (binary frames) |
| `POST/GET/DELETE /mcp` | agent CLIs | MCP over streamable HTTP, per-pane bearer token |
| `/orchestrate/*` | `hs-pane` | the same verbs as plain HTTP for the CLI helper |

The renderer learns port and token from the Tauri command `host_config`, not from
`daemon.json`. `host.rs` may not log (a unit test greps its own source for `println!` and
`tracing::`) because the token is in scope. The first `/ws` frame must be `hello`; token
comparison is constant-time and the protocol version is an exact match.

PTY frames flow only for sessions the connection asked about (`session_attach`,
`session_visibility{visible:true}`, or creating the session on that socket), and each such
session has its own bounded queue on that connection (`frame_queue.rs`: 4096 frames or 4 MiB).
The PTY is always drained daemon-side; a client that stops reading fills only its own queues,
and a queue that drops sends a gap frame anchored where loss began, which the pane answers
with one fresh attach. Control messages fan out over a `tokio::broadcast` of 4096 slots; a
connection that lags it is closed with `error{context:"control_lag"}` and reconnects for a
full state. A control request runs on its own task, not on the connection's loop: that loop
flushes the connection's PTY frames, forwards stdin and acks resizes, and a handler awaited
there — a `git` shell-out, a CLI probe, a directory scan — held all three for its whole
duration, which is how a resize ack missed the renderer's deadline and a CLI drew into an
80×24 box. Only the four attach-family messages (`session_create`, `session_respawn`,
`session_attach`, `session_visibility`) stay on the loop, because they edit the connection's
own frame set; every other reply comes back through a bounded per-connection queue.
The scrollback replay is the one base64 payload, riding the JSON channel so it
orders against the attach that asked for it. Details: [renderer.md](renderer.md).

### The emulator, and who answers an unwatched pane's terminal

The daemon owns a real terminal emulator per session — the same libghostty-vt the renderer
draws with, built natively from one pinned source (`vt.rs`, `core/houston-core/ghostty-vt/`).
It is fed on the PTY read path, after the token redactor and beside the scrollback ring,
under one hold of the scrollback lock so the ring offset and the emulator state always agree.
It is the fourth lawful reader of PTY content and it is never a status source: status stays
hooks- and ACP-driven.

Two things fall out of owning one. A terminal is not only a screen; it answers questions. A
CLI asks what its terminal is (`ESC [ c`) and whether it does synchronized output
(`ESC [ ? 2026 $ p`) at startup, and some wait for the reply. `Session::watched` is the gate —
any Tauri output sink, or any `/ws` connection holding this session in its frame set. While it
is false the daemon writes the emulator's own replies straight to the PTY backend, never
through the typed-input path, because this is the terminal replying to the program rather than
a person at the keyboard. While it is true the daemon stays silent, so a question is never
answered twice: single query-response ownership, at one call site.

And a pane reattaches from state instead of from bytes. `session_attach` may ask for a
snapshot; the daemon captures the emulator's cells, both screens, modes, cursor, kitty
keyboard flags, bounded history and any in-flight escape sequence atomically with the byte
cutoff, and the renderer imports it and resumes at the cutoff exactly once. A pane you come
back to looks as you left it, including inside a full-screen program, and an escape sequence
split across the cutoff is not lost. A client that does not advertise the snapshot format
version, or a build without the emulator, falls back to the byte replay by name. So does a
pane whose own grid is not the one the container was captured at: a container carries its
geometry and importing applies it, and a pane's first attach goes out before its first
resize reaches the daemon, so a session still at its 80×24 spawn size would otherwise pin
the renderer's terminal to 80 columns with nothing to put it back. The pane's measurement
is the authority; a foreign grid is refused and replayed as bytes.

### Threads and locks

One `tokio` runtime. PTY reads are one OS thread per session (`pty-read-<id>`). Long
control jobs (SSH connects, git, handoffs) are `tokio::spawn`; the hook/mail tick and usage
scans are `spawn_blocking`; a dedicated writer thread owns the command-history ledger so
SQLite stays off the read path. Session maps on `Daemon` are plain `std::sync::Mutex`, never
held across `.await`.

### Detach and shutdown

Quitting the app (`RunEvent::Exit`, or its own signal handler) only closes the `/ws`
connection — it never touches `daemon.json`, never checkpoints, never marks a clean
shutdown. Those are the daemon's own concerns now: it checkpoints scrollback on the last
client detaching (`conn_forget` reaching zero connections) and marks a clean shutdown only
after its own orderly stop (SIGTERM/SIGINT, or `/manage`'s `daemon_shutdown`) actually
completes — `checkpoint_scrollback()` then `mark_clean_shutdown()`, in that order, so a crash
between them is still read as abnormal on the next boot.

The daemon's idle reap (a grace period with no client, no live session and no enabled routine)
exits through this same orderly path, not a separate one: `mark_clean_shutdown()` then
`remove_discovery_files()` removes `daemon.json` and, if present, `supervisor.json` — exactly
what `/manage`'s `daemon_shutdown` does — before calling the injected process exit. Skipping
this cleanup leaves `daemon.json` pointing to a process that no longer owns the listener,
which `scripts/dev.sh --fresh` correctly treats as an unresponsive daemon.

### The tray, and hide-to-tray

The tray icon lives in the **app**, never in the daemon, and its data flows one way:

```
daemon --/ws--> renderer --tray_sync--> src-tauri/src/tray --> native menu + icon + tooltip
```

The renderer is already the one client holding the live roster and the hooks-driven
status, so it collapses each session into `{id, agent, title, status, needsInput,
workspace}` — `workspace` is the same display name the sidebar rail shows, looked up by
`w.path === session.project_dir` — orders them most-recently-active first and hands the
list plus its own connection state to the `tray_sync` command, coalesced to at most four
sends a second (`ui/src/renderer/src/houston/tray.ts`). Rust owns everything visible:
`tray/model.rs` turns one payload into a header line, a tooltip, an icon state and a menu.
Exceptions sit at the top level — the panes actually waiting on the user, in payload
order, capped at `ATTENTION_ROW_CAP` (4) with an overflow row past that — and the whole
inventory sits one click away in an `Agents (N)` submenu, grouped by workspace in
first-appearance order, each group sorted needs-input/running/idle/done and capped at
`GROUP_ROW_CAP` (8) with its own overflow row. The top level's shape never changes under
the cursor: even a single running agent with nothing waiting lives in the submenu, not
inline. `tray/mod.rs` rebuilds the whole native menu from it, recursing into
`TrayItem::Submenu` for the one nested level and minting a fresh id for every disabled
`Group`/`Overflow` row so `muda` never sees a duplicate. Nothing here crosses `/ws` and
none of it is in `houston-protocol` — a tray in the daemon would mean a second WebSocket
client and a wire message to publish what one client already knows.

Two menu items go back the other way, as Tauri events the renderer listens for: a session
row shows the window and emits `tray://focus-pane`, which lands on the same focus action
the orchestration card uses (it selects the pane's workspace first); "Quit Houston…"
confirms natively, then emits `tray://stop-daemon`, and the renderer runs the stop through
the same `/manage` client Settings → Daemon uses before quitting.

That quit is the tray's **only** way out, and it stops the daemon. A tray quit that left
the agents running would rebuild the state the tray exists to make visible; leaving them
running is what closing the window already does.

The icon itself is a **tile** — the dock icon's composition on a 16-unit grid
(`ui/resources/icon-tray.svg`), rendered to idle/active/attention at eight cuts by
`ui/scripts/render-icons.mjs` and embedded with `include_bytes!`. It carries its own
ground and rim, so one PNG set reads on a dark panel and a light one alike and nothing
probes the desktop's colour scheme. Which cut is uploaded comes from the DESKTOP, not the
monitor: GNOME's AppIndicator draws 16 logical pixels and Plasma 22, so `base_icon_size`
reads `XDG_CURRENT_DESKTOP` once at install, multiplies by the primary monitor's scale
factor and snaps to the nearest bundled size.

**Closing the window hides it** when a tray is actually available and the user has not
turned the setting off (Settings → Daemon → Background, default on, stored in
`<state_dir>/tray.json`). The webview keeps running while hidden, which is what keeps the
tray fed. The app quits from the tray's "Quit Houston…" (which stops the daemon first) or
from an in-app quit — both end at the `app_quit` command, which arms the flag that tells
the close handler this one is real.

Availability is **probed, not assumed**, and on Linux `tray/probe.rs` asks two questions
before anything else runs. Who owns `org.kde.StatusNotifierWatcher` on the session bus —
nothing owning it (a GNOME session without the AppIndicator extension) is the common
refusal. And whether libappindicator actually loads: `tray-icon` reaches it through
`libappindicator-sys`, which `dlopen`s it lazily and **panics** when it is absent, from
inside the `TrayIcon::new` this process calls on the main thread — so a missing library
cannot be caught after the fact and has to be found before anything triggers that load.
Either check failing means no icon, no hide-to-tray, and that sentence in Settings; the bus
answers first because it is cheaper and commoner. Anything that still leaves the process
without an icon goes through the same `refuse` as the probe, so the close button reads one
switch. Windows always has a notification area, nothing is dlopened to reach it, and its
twin returns available unconditionally.

Two build-side consequences of that library, both easy to get backwards. The binary never
links it, so there is no build dependency for `cargo build`. The **bundle** step does:
with the `tray-icon` feature on, `cargo tauri build` runs
`pkg-config ayatana-appindicator3-0.1`, panics without it, copies the `.so.1` into the
AppImage, and adds `libayatana-appindicator3-1` to the deb's depends itself — which is why
`release-linux.yml` installs `libayatana-appindicator3-dev` and `tauri.conf.json` does not name
the runtime package.

## Boundaries that matter

- **Rust is the schema.** `core/houston-protocol/src/lib.rs` is the whole wire; the TS
  types are generated by ts-rs and committed. Three scripts enforce that Rust, generated TS,
  the built renderer and `protocol.md` agree on `PROTOCOL_VERSION`.
- **Spawning is audited.** Every child process goes through `houston_core::spawn` (window
  policy on Windows) and every bare command name through `exe_path::resolve`. A clippy
  `disallowed-methods` entry bans `std::process::Command::new` outside them.
- **Signals are audited.** `pid.rs` is the only module that may call `kill(2)` or its Win32
  twin; `checked_pid` refuses `0` and anything above `i32::MAX`, and identity-checked
  delivery compares the creation token first.
- **Browser panes hold no authority.** The invoke handler refuses any Tauri command coming
  from a content-only webview label. Destructive agent actions in the browser
  (`browser_click`, `browser_type`) pass a human confirmation gate.
- **Secrets never touch the DB.** SSH passwords, passphrases and the Groq key live in the
  OS keychain (Secret Service via zbus); the DB holds a reference. `sanitize.rs` redacts
  known secret shapes from anything persisted or shown to a one-shot child.
- **Other CLIs' config is written only through reversible markers.** Hook entries carry a
  `--houston-managed[=<channel>]` sentinel matched per whitespace token; MCP
  self-registration goes through `claude mcp add`, never the file. Houston reads
  `~/.claude.json` for exactly two purposes, both read-only and fail-soft, and streams
  `~/.claude/projects/**/*.jsonl` for one (token counts, only while asked). Full terms in
  [`docs/internals/invariants.md`](../internals/invariants.md).

## Repository map

```
core/
  Cargo.toml              workspace: houston-protocol, houston-core; dev profile strips dep debug info
  houston-protocol/        the wire, one file (~6.3k lines), feature ts-gen for codegen
  houston-core/
    src/                  the daemon (~89k lines); see daemon.md for the module map
    tests/                integration tests; harness in tests/common/mod.rs
    src/bin/tr-helper.rs  slim hook helper; named refusal for legacy hs-mail
src-tauri/                the app (its own cargo package, not a workspace member)
  src/main.rs             subcommands, channel, singleton, boot, Tauri builder
  src/daemon_host.rs      connect-or-spawn, detach on quit, --daemon-fresh over /manage
  src/browser/            native child webviews + the browser_* MCP tools
  src/watchdog/           renderer paint-freeze watchdog (pure state machine + probes)
  src/tray/               the tray: menu model, D-Bus availability probe, hide-to-tray setting
  icons/tray/             idle/active/attention at 16/20/22/24/32/40/44/48 px, rendered
                          from ui/resources/icon-tray.svg by ui/scripts/render-icons.mjs
  icons/{32x32,128x128,128x128@2x,icon}.png, icon.ico
                          the bundle icons tauri.conf.json's bundle.icon names,
                          rendered by ui/scripts/render-icons.mjs (bun run icons)
  tauri.conf.json         window (undecorated, 1400×900), bundles: appimage, deb, nsis;
                          identifier "dev.houston.desktop" (keys the D-Bus lock and webview
                          storage); externalBin ships tr-helper and houston-core inside every
                          bundle, so an installed copy needs no app-binary hook fallback
ui/                       React 19 + Tailwind 4 + Vite; bun, never npm
  resources/icons/hicolor/ the desktop-entry icon tree (16 to 512 px), rendered by
                          render-icons.mjs, read by scripts/install-desktop.sh
  src/renderer/src/
    ghostty/              the terminal engine: vendored libghostty-vt WASM → Canvas 2D
    layout/tree.ts        grids, split tree, localStorage persistence
    pane/                 TerminalPane, write queue
    houston/               transport client + generated/ (ts-rs output)
    components/           the UI; chrome constants in *Chrome.ts
    theme.css             every design token
protocol/protocol.md      the wire reference
scripts/                  dev.sh, build-app.sh, install-desktop.sh, oom-shield.sh, check-*.sh
docs/                     this tree; see docs/README.md
```

## Data model

| Store | What | Where |
|---|---|---|
| SQLite `houston.db` (WAL) | workspaces, sessions roster, SSH profiles, settings KV, routines and their runs, command history, MCP/skill bookkeeping, legacy swarm tables | `db.rs`; migrations are `CREATE TABLE IF NOT EXISTS` + `add_column_if_missing`, no `user_version` |
| `scrollback/<id>.bin` | 4 MiB ring per session, written on session end and shutdown | `scrollback.rs` |
| OS keychain | SSH credentials, Groq API key | `ssh_credentials.rs`, `voice/cloud.rs` |
| `localStorage` (per channel webview) | grids, split trees, workspace order and pins, sidebar state, chrome theme | `layout/tree.ts` |
| in memory only | live sessions, handoff jobs, hook/mail scope state | `daemon.rs` |

The workspace/grid/pane hierarchy is split across two stores on purpose: the daemon knows
workspaces and sessions; the renderer owns how they are laid out. `LeafNode.id` is a durable
pane identity distinct from the session in it, so a respawned session keeps its pane.

## Budgets

Acceptance criteria on Linux, mid-range hardware. Enforcement is what actually checks it.

| Metric | Budget | Enforcement |
|---|---|---|
| Concurrent full-speed panes, no dropped input | 12 | manual |
| Keystroke → echo, focused pane, loaded system | p95 < 25 ms | `--features bench`, `scripts/m9-baseline.sh` |
| PTY write → paint | p95 < 50 ms | bench harness |
| Rendering regression floor (M9) | p95 ≤ 450 ms, 5-run median | `scripts/m9-baseline.sh` |
| PTY throughput under ANSI flood | ≥ 5 MiB/s | `tests/perf_smoke.rs` (release, `--ignored`, idle machine) |
| Daemon RSS @ 10 flooding sessions | target 50 MiB; gated at 150 MiB regression ceiling | `tests/perf_smoke.rs` |
| Scrollback resident per session | ~8 MiB stable | `scrollback.rs` capacity ceiling |
| Cold start to `<App/>` mounted, 0 sessions | < 3 s (measured 2.14 s) | `scripts/boot-baseline.sh` |
| Warm restore to focused pane typeable, 12 panes | < 3.5 s (measured 2.30 s) | `scripts/boot-baseline.sh` |
| Boot payload (entry chunk + static closure) | ≤ 804,287 bytes (at 756,406) | `ui/bundle-budget.json`, `check:bundle` |

Boot budgets are 3-run medians on an idle machine, from `--bench=M10`'s stamps;
`boot-baseline.sh` prints the per-phase breakdown, which is the actionable part —
a total hides which phase moved. **Typeable** means the focused pane's engine is
live and its stdin is open: the first instant a keystroke reaches the PTY, which
is earlier than the scrollback replay painting. The ceilings are ~1.5× the
measured median, wide enough that ordinary machine noise is not a failure and
tight enough to catch a phase regressing.

Cold start is dominated by two phases Houston does not own: `main-entry →
daemon-boot-start` (1043 ms, process and dynamic-link startup) and
`window-created → page-load-started` (628 ms, WebKitGTK). Shrinking the boot
payload moves neither; it moves `page-load-finished → renderer-app-mounted`.

Committed tactics: binary frames, bounded rings, no JSON on the PTY path, prescan-gated
sniffers (Aho-Corasick before regex), Canvas 2D with cached WASM memory views. Known
deferrals: no read coalescing (one frame per 16 KiB read), no kernel-boundary flow control,
no pane virtualization, no unix-socket transport (the browser WebSocket API cannot dial one).

## Platform notes

- Linux (WebKitGTK) is lead. Browser panes need tauri's `unstable` feature for
  `Window::add_child` and a GTK escape hatch because `Webview::set_bounds` is a no-op there.
- Windows builds and ships (ConPTY, WebView2, NSIS). A kill *releases* the PTY because
  conhost's death does not propagate pipe-close. `whisper-rs` is unix-only; the Windows local
  voice engine is a named refusal.
- Tauri's `tracing` feature must never be enabled: it makes `eval_script_with_callback`
  block, which lets the watchdog supervisor block on the very event loop it watches.
  `check-watchdog.sh` enforces it.
