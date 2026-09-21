# The daemon

> For maintainers. Start at [overview.md](overview.md) for the process model.

`houston-core` is a library crate, ~88k lines across 69 top-level modules and three
subdirectories. It owns every PTY, every agent child process, the SQLite database, the hook
pipeline and the MCP endpoint. One binary hosts it: `core/houston-core/src/main.rs`, run
detached — spawned by `houston-supervisor` on Linux or directly on Windows — and outliving
the Tauri app, which connects to it as a `/ws` client (`src-tauri/src/daemon_host.rs`) rather
than linking it in. See [overview.md](overview.md#one-daemon-one-host--and-an-app-that-is-a-client)
for the reversal.

## Module map

One line each, from the module's own doc header. Declared in `lib.rs`.

| Concern | Module | Responsibility |
|---|---|---|
| sessions / PTY | `daemon.rs` | Session host: PTYs, agent children, scrollback, persistence |
| | `launch.rs` | The launch command per agent CLI: argv, approval/plan/model flags |
| | `exe_path.rs` | Spawn-side executable resolution — the one audited resolution point |
| | `spawn.rs` | Spawn-side window policy — the one audited child-creation point |
| | `scrollback.rs` | Capped ring with stream accounting and disk persistence |
| | `vt.rs` | The session's terminal emulator: libghostty-vt, native, one per pane |
| | `shellint.rs` | Per-session shell integration: rc files the daemon materializes |
| | `markers.rs`, `blocks.rs` | OSC 133 (FTCS) parsing, and the command blocks it assembles |
| | `osc52.rs` | OSC 52 clipboard writes, parsed out of the PTY stream |
| | `agents.rs` | Ambient agent identity: banner sniffing on PTY output |
| | `pane_name.rs` | Panes are named from their first prompt |
| | `osc_title.rs` | OSC 0/2 window titles — what a CLI calls its own session |
| | `login_path.rs`, `env_hygiene.rs` | Login-shell `PATH` recovery; inherited-marker scrub |
| persistence | `db.rs` | SQLite persistence (WAL); writes only on rare control-plane events |
| | `paths.rs`, `home_dir.rs` | Channel-scoped state paths; the home dir, resolved per platform |
| | `lock.rs` | The daemon-ownership advisory `flock` |
| | `server.rs` | WebSocket endpoint: handshake, control dispatch, binary PTY path |
| | `boot.rs` | The background-loop set: one spawn list, called only by the daemon's own `main` |
| | `logging.rs` | The `tracing` subscriber — stdout plus a rotating file sink |
| hooks / status | `claude_hooks.rs` | Claude Code lifecycle hooks — installer plus hook client |
| | `agent_hooks.rs`, `agent_events.rs` | Installers for the other providers; the event taxonomy |
| | `hook_drop.rs` | The hook drop file: how a lifecycle hook reaches the daemon |
| | `hook_state.rs` | The file a hook helper reads when there is no live daemon |
| | `acp.rs` | ACP (Agent Client Protocol) as a third lawful status source |
| | `statusline_sweep.rs` | Boot-time retirement of a removed feature's managed write |
| orchestration | `orchestrate.rs` | Agent-spawns-agent: pure helpers plus the `hs-pane` CLI |
| and MCP | `mcp_server.rs`, `mcp_orchestration.rs` | The `/mcp` endpoint, and its door onto orchestration |
| | `mcp_creds.rs` | Per-session MCP credentials: mint, resolve, revoke |
| | `mcp_launch.rs` | Handing a pane's credential to the CLI it was minted for |
| | `mcp_register.rs` | One-time user-scope registration of Houston's MCP server |
| | `mcp.rs` | Reading four CLIs' MCP server lists into one comparable shape |
| | `scope.rs` | The swarm scope directory: on-disk layout, atomic writes, mail message file format |
| | `handoff.rs` | Handoff context curation and prompt assembly |
| | `agent_accounts.rs` | Account/config-dir path helpers |
| | `skill_sync.rs` | Which skills each CLI can see |
| | `routines.rs` | Routines — the pure half of the routine record |
| integrations | `git.rs` | Git queries for the Changes pane; every operation shells out |
| | `gh.rs` | One PR status line, through the GitHub CLI |
| | `ssh.rs` | SSH panes: a remote shell as a normal grid pane |
| | `ssh_config.rs`, `ssh_credentials.rs` | Four config directives; credentials in the keychain |
| | `usage/` | Token-usage reporting for the agent CLIs Houston hosts (7 files) |
| | `voice/` | Capture, local and cloud transcription, model catalog (6 files) |
| safety | `pid.rs` | The only module allowed to call raw `kill` or the Win32 twin |
| | `sanitize.rs` | Secret-pattern redaction, shared by everything that persists text |

`src/bin/tr-helper.rs` is the slim helper: `hook`, nothing else — it answers a `hs-mail`
invocation with a refusal naming the replacement and exits non-zero.
`src/bin/ansi_flood.rs` is the throughput fixture.

## Sessions and backends

`Session` (`daemon.rs`) holds `info`, `pid`, `custom_cmd`, `state`, `title`, `project_dir`,
`detected`, `blocks`, `shell`, `osc_cwd`, `osc52`, `acp`, `scrollback`,
`last_output`, `status`, `hooks_seen`, `hook_cwd`, `backend`. `status` (the hook-driven
`AgentStatus`) is orthogonal to `state` (process lifecycle) — neither derives the other.
`blocks`/`shell` are `Some` only for a shell spawned with integration and `acp` only for an
ACP-mode pane, so a session pays for nothing it does not use.

```rust
enum Backend {
    Pty { writer: Mutex<Option<…>>, master: Mutex<Option<…>>, killer: Mutex<Option<…>> },
    Ssh(SshHandle),
}
```

`writer` and `master` are `Option` because **a kill releases the PTY**. On Windows conhost's
death does not propagate pipe-close, so an open master parks the reader thread in `read()`
forever, holding a daemon `Arc` with it; dropping both at kill time is what lets the reader
see EOF, persist its ring and exit. Unix gets that from slave-side EOF. `Backend::resize`
returns the dimensions actually applied — an ack that only says "no error" cannot drive a
retry ladder.

## Spawning a session

`spawn_session` opens a PTY through `portable_pty::native_pty_system().openpty(…)`, then:

1. `launch.rs` builds the argv for the `AgentKind` — approval/plan/model flags, auto-mode
   tables, a model-vs-auto-mode block list. A prompt over `PROMPT_FILE_THRESHOLD`
   (12 000 bytes) spills to a file instead of argv. Codex is the one CLI where `auto_mode`
   and `auto_approve` render the same flag, one rung early
   (`--dangerously-bypass-approvals-and-sandbox`): a lighter `-a never` still leaves Codex's
   `workspace-write` sandbox on, and that sandbox hard-codes `.git` read-only, so an
   orchestrated Codex pane could neither write the git index nor ask to.
2. `exe_path::resolve` resolves any bare command name; it is the only place that does.
3. `crate::spawn` creates the child, applying `CREATE_NO_WINDOW` on Windows. A clippy
   `disallowed-methods` entry bans `Command::new` elsewhere.

Environment set on the child, in order:

| Variable | Value | Note |
|---|---|---|
| `TERM` | `xterm-256color` | unix unconditional; Windows only if not inherited |
| `COLORTERM` | `truecolor` | |
| user pairs | from the create request | applied before the helper `PATH` |
| `PATH` | helper `bin` dir prepended | skipped for hidden panes and SSH |
| `HOUSTON_SESSION` | session id | what marks a process as running in a pane |
| `HOUSTON_CHANNEL` | the owning channel | |
| `TR_SESSION` | session id | what a hook client reads to correlate |
| `HOUSTON_SHELL_INTEGRATION_TOKEN_FILE` | path to the marker capability | shell panes with integration on; the rc reads it once and unlinks it |

`mint_mcp_launch` (`mcp_launch.rs`) adds the per-pane MCP argv and env; `shellint::injection`
adds the rcfile args and env when shell integration is on. `env_hygiene::scrub()` has already
removed inherited agent-session *identity* markers from the daemon's own environment at
startup — identity only, never config variables — so a daemon started inside a pane does not
leak that identity into everything it spawns. `login_path.rs` probes `$SHELL -lic` once and
merges the login `PATH` in front of the inherited one, best-effort and fail-soft.

## Supervisor

`houston-supervisor` is a tiny std+libc/nix binary (no tokio, no tracing subscriber, no DB;
~2 MiB RSS) that sits between whatever spawns Houston and the `houston-core` process itself.
It exists for one reason: a PTY reaching EOF proves the program stopped writing, never what
its exit code was, and once a daemon can be replaced out from under a live session (the
Handoff stage), the process that spawned that PTY child may no longer be alive to `wait()` on
it and learn that code.

What it does: sets `PR_SET_CHILD_SUBREAPER`, then forks every daemon generation as its own
child (never a sibling) over a `UnixStream::pair()` socketpair, with the daemon's end
inherited at fd 3 and `HOUSTON_SUPERVISOR_FD=3` in its environment. Being the real ancestor of
every generation means a generation's orphaned PTY children reparent onto the supervisor, not
onto `init`, when that generation exits — so its `waitid(P_ALL, WEXITED)` reap loop sees their
*real* kernel-reported exit code or signal and relays `{pid, code, signal}` over the socket to
whichever generation is current. A daemon can ask the supervisor to spawn its replacement
(`spawn_next {daemon_path, args}`) over the same socket — the mechanism Handoff (below) uses
to start every candidate. The supervisor exits once its current generation has exited, no
`spawn_next` is pending, and no
reparented child remains, so the reap rule still empties the machine when nothing needs the
daemon, one process down. It writes `supervisor.json` (`{pid, pid_creation, generation}`,
atomic, 0600) beside `daemon.json`. It is Linux-only; the binary still compiles on Windows and
refuses by name at startup, and the app spawns `houston-core` directly there instead.

What it never does: it never calls `kill(2)` itself, never substitutes a PTY EOF for an exit
code, and never spawns a replacement generation on its own initiative — only when asked. On
the daemon side, `main.rs` takes fd 3 when `HOUSTON_SUPERVISOR_FD` is set and records the
supervisor's pid in `daemon.json`; a small reader thread relays each `{pid, status}` to
`Daemon::supervisor_child_exited`, which attributes it to the live session whose child pid
matches — buffering whichever of PTY EOF or the supervisor's report arrives first so the
session finishes only once both are known, the same rule "The read loop" states below for the
ordinary case. On Linux, local waiters observe exit with `waitid(WNOWAIT)` before taking the
handoff reaping lock. A failed handoff releases that lock and lets the original generation
reap normally. After commit, local waiters leave the exit status unconsumed so the supervisor
can relay it to the new owner when the retiring parent exits.

## Handoff

On Linux, `daemon_handoff` (`/manage`, `manage_version` 1 — its response shape changed but the
version was deliberately not bumped, since `manage.ts` hardcodes 1 independently and is outside
this change's boundary) lets `dev.sh --fresh` and a
supported upgrade replace the daemon binary without ending a single live session. The old
daemon (O) asks `houston-supervisor` to spawn the new binary in an inert `--adopt <socket>`
mode (`main.rs::run_adopt`) over a private, channel-local Unix socket — the candidate (C) never
takes the lock, opens the DB, serves a client, or runs restore while preparing; normal boot's
`Daemon::new_inner` (which marks every live row interrupted) is not on this path at all —
`Daemon::new_adopting` is a dedicated constructor that skips it.

C says hello (build, protocol/schema/manifest versions); O refuses by name (platform, a live
SSH session, a schema-changing candidate, an unsupervised daemon) or quiesces: refuses new
mutations (`Daemon::is_handing_off`, sharing the shutdown gate), parks every
session's `pty-read-<id>` thread at its own between-reads checkpoint (`Session::park` —
a blocking `read()` with nothing pending is woken with a harmless, always-installed `SIGUSR1`
that never loses an already-buffered byte, since any data a read call returns is always
processed before the loop checks `park`), and checkpoints scrollback. It then sends a versioned
manifest (session ids/pids, sizes, state, hidden/title/cwd, hook cwd, output offset, MCP
credential hash+scope+remaining validity — never a raw token) plus one `SCM_RIGHTS` payload:
every session's PTY master fd, the `/ws`+`/mcp` listener, and the daemon lock, in that order.
Base64 (never a bare `Vec<u8>`) is mandatory for any buffer field — `core/houston-core/src/adoption.rs`
pins the byte cap near the measured 258 KiB/12-session number this forbids blowing past. C
reconstructs each session on `adoption::RawMasterPty` (`portable_pty::MasterPty` has no
`from_raw_fd` counterpart to its own `as_raw_fd`) and acks **prepared**; a refusal or failure up
to this point is fully reversible — O un-parks every session and keeps serving, C exits having
touched nothing durable.

O then sends **commit**; C writes the commit record into `daemon.json` (`{pid, pid_creation,
build, generation}`, atomic rename) *before* acking, so a lost acknowledgement still leaves O
able to read the record back and compare its `generation` against what it expects, rather than
trusting a bare timeout (a timeout alone never lets O resume once the record shows committed).
O retires without marking clean shutdown, removing `daemon.json`/`supervisor.json` or killing
a child. After allowing the management response to flush, it exits explicitly rather than
waiting for blocking background tasks during runtime teardown. This promptly reparents the
transferred children; the supervisor
reaps its orphaned PTY children exactly as "Supervisor" describes, relaying their exit to C, who
inherits the same supervisor connection normal boot always sets up
(`main.rs::spawn_supervisor_reader`). `/ws` clients reconnect on the dropped socket as they
already do; listener transfer preserves the port but not accepted MCP streams. An in-flight
mutation racing the quiesce window is refused, and the caller is expected to retry against
the new generation.

Known simplifications, not yet closed: shell-integration block tracking, the OSC scanners and
the ACP line decoder all start fresh on the new side rather than resuming mid-stream (worst
case is a missed block boundary or title update, never a wrong byte to the client); the VT
parser's own partial-escape-sequence buffer has a reserved manifest field but is always empty
since a headless VT parser has not landed — there is no parser to have partial state yet.

## The read loop

One OS thread per session, named `pty-read-<id>`, loops on `reader.read(&mut buf)` with a
fixed `PTY_READ_BUF` of 16 KiB. **There is no coalescing** — one frame per read, an accepted
simplification recorded in the module doc.

`process_chunk` fans one chunk out, in order: scrollback push (returning the stream offset)
and the session's terminal emulator, both under one hold of the scrollback lock; the
`last_output` timestamp; then — for a visible session — the block tracker (completed blocks
go to the ledger writer thread), the OSC 52 scanner, the OSC 0/2 title scanner for non-shell
panes, the banner sniffer, the roster activity tick, the ACP decoder. It encodes
`proto::encode_output_frame(id, offset, chunk)` once and offers the same `Arc` to each
per-connection tap (`FrameRegistry::offer`, `frame_queue.rs`). A hidden session
short-circuits into `handoff_output` before any of that. Backpressure is per-connection, not a
shared broadcast: each tap queues up to `FRAME_QUEUE_DEPTH` (4096) items or `FRAME_QUEUE_BYTES`
(4 MiB) before it drops, and the drop becomes a `Queued::Gap` the connection loop turns into a
gap frame — the renderer answers a gap with one fresh attach instead of the client being
disconnected; it never stalls the PTY. `OUTBOUND_CAPACITY`'s 4096-slot `tokio::broadcast` is a
separate channel for control messages only: a client that lags on it gets a `control_lag` error
and is disconnected so its reconnect resyncs full state (`server.rs`).

## The emulator

Each session owns one libghostty-vt terminal (`vt.rs`), built natively into the daemon from the
same pinned revision the renderer runs as WASM (`core/houston-core/build.rs`,
`ghostty-vt.lock`, `scripts/check-ghostty-vt-pin.sh`). It is fed every chunk on the read path
**after** the token redactor and beside the scrollback ring, and it exists for three readers:
`session_attach{snapshot:true}`, which answers with its state instead of a byte replay;
`pane_read --source screen`, which reads its grid; and the terminal questions a pane's program
asks, which it answers itself. Live output still streams as raw bytes — the renderer's engine
is still the thing that paints — and the emulator is never a status source.

**Query ownership.** The emulator parses every chunk, but its replies reach the PTY only while
`Session::watched()` is false. An attached renderer answers from its own engine, so exactly one
of the two is the answerer at any moment, and the attach count is what flips it.

**History.** `VT_HISTORY_ROWS` is the daemon's own budget in rows, deliberately independent of
the renderer's preference: this one is paid twelve times over in a background service.
`VT_HISTORY_BYTES` is the byte budget handed to the library (its `max_scrollback` is measured
in bytes, whatever the C header says), sized so twelve full histories stay under the P4
ceiling — which holds `VT_HISTORY_ROWS` rows up to about 190 columns, and fewer beyond.
`VT_HISTORY_BYTES` is 3 MiB per session; twelve sessions each saturated at that budget measure
49–51 MiB RSS across two idle-box runs, against a 24.0 MiB pre-emulator baseline at twelve idle
shells and 12 MiB at zero sessions, and RSS returns to within 3.5 MiB of the pre-session
reading once all twelve close and their PTY reader/wait threads wind down.

**Snapshots.** `Daemon::attach_snapshot` captures the state and the output cutoff under one
hold of the scrollback lock, in the order the read path takes it, so the two are atomic. The
container and the sequencing rules are in `protocol/protocol.md`; the same bytes ride the
handoff manifest (v2), which is why an escape sequence split across an upgrade continues
instead of corrupting.

Windows has no emulator: `build.rs` does not build the library there, `cfg(houston_vt)` is
unset, `hello_ok.snapshot_attach` is false and reattach uses byte replay.

## Stream parsers

All carry state across reads, all are bounded, none is a status source.

| Module | Parses | Bound |
|---|---|---|
| `osc52.rs` | `ESC ] 52 ; <target> ; <base64> BEL\|ST` | decoded payload ≤ 1 MiB |
| `osc_title.rs` | `ESC ] 0/2 ; <title> BEL\|ST` | raw title ≤ 512 bytes |
| `markers.rs` | OSC 133 (FTCS) and OSC 9;9 (cwd), each carrying the session's capability | bounded carry, so a split marker is not missed |
| `blocks.rs` | command blocks from those markers | `MAX_BLOCKS` 200, `MAX_RING_CMD_BYTES` 256 KiB |
| `agents.rs` | agent banners | Aho-Corasick prescan gates the regex |

Blocks are memory-only and never broadcast; they feed the history ledger and handoff context.
`shellint.rs` materializes rc files under the state dir and sources the user's own first — it
never edits them; `HOUSTON_SHELL_INTEGRATION=0` is the kill switch. Every marker those rc files
emit carries a per-session capability, and `markers.rs` ignores one that arrives without it, so
program output cannot fabricate a command block, an exit code or a cwd. The daemon writes that
capability to a mode-0600 file and passes only its path; the rc reads it once and unlinks it
before any user startup code runs, which leaves the initial environment block in `/proc` holding
a path that no longer resolves. `TokenRedactor` strips the capability from the stream before
scrollback and both fanouts, so it never reaches a client, the DB or a log.

Pane names carry a persisted source with the precedence codename < first prompt < spawned role
< CLI title < user rename. This lets respawn and boot restore keep a manual rename final without
mistaking an older prompt-derived name for one. CLI-title repaints have a one-second write floor;
the latest title inside the floor is retained and applied when it expires. A title that is only
the CLI's own name is not a name (recorded: Claude Code writes a spinner glyph and its product
name, never a summary), so such a pane keeps its prompt or role name. Local and SSH shells
do not build the title scanner because their window title describes the cwd, not an agent session.

## Scrollback

| Constant | Value | Why |
|---|---|---|
| `SCROLLBACK_CAP` | 4 MiB | per session |
| `TRIM_SLACK` | 1 MiB | front-drain amortizes instead of running per push |
| `SAFE_CUT_WINDOW` | 8 KiB | look back for a newline before a raw cut |
| `CAPACITY_CEILING` | cap + slack + 64 KiB | resident capacity self-stabilizes near 8 MiB |

A replay that does not start at the true stream start is prefixed with an SGR reset, so
trimmed colour state cannot bleed into the first visible line. Rings persist to
`scrollback/<id>.bin` behind a `TRSB` magic and version byte — written on session end, on the
last `/ws` client detaching (`checkpoint_scrollback`), and at orderly shutdown, read on
demand when a restored husk is attached. Between checkpoints a detached session's output
stays in bounded memory only: a daemon crash can lose everything since the last one.

## Reading a pane

Two answers, and which one a caller gets is the difference between reading a repainting CLI
and reading nothing.

| Source | What it is | When it is right |
|---|---|---|
| **screen** | the session's emulator (`vt.rs`) hands back its grid at the pane's current size, trailing blanks trimmed, plus as much history as `VT_HISTORY_ROWS` holds | the default, and the only honest answer for a CLI that addresses the cursor and repaints |
| **tail** | `Scrollback::tail_lines` splits the ring on `\n` and collapses each line's carriage returns | a CLI that prints lines; the cheaper read; the only way back to text older than the current screen |

A full-screen agent CLI writes **zero** newlines, so `tail` answers a read of one with a
single element and stripping its escapes eats every space the CLI drew by moving the cursor.
Every daemon-side reader of a pane's text goes through one `Daemon::session_screen`, which
owns the geometry lookup: `orchestrate_read`, the handback and `no_handback` excerpts, and
the delegation quiet-settle fingerprint.

Nothing renders on the PTY path. A render happens only when one of those asks, which is why
twelve full-speed panes pay nothing for it — `SCROLLBACK_CAP`'s 4 MiB renders in ~16 ms, and
a real Claude Code ring in 0.33 ms. A pane RESIZED mid-session has bytes drawn at two widths
and one render cannot be right for both; it uses the current size and the older part may
come out wrong.

## Persistence

`houston.db` sits in the state dir. Pragmas at open: `journal_mode = WAL`,
`synchronous = NORMAL`, `cache_size = -8000` (8 MB), `temp_store = MEMORY`. Writes happen
only on rare control-plane events — the PTY path never touches SQLite.

| Group | Tables |
|---|---|
| workspaces and sessions | `workspaces`, `sessions` |
| routines | `routines`, `routine_runs` |
| agent accounts | `agent_profiles` |
| terminal history | `command_history` |
| remote | `ssh_profiles` |
| bookkeeping | `settings`, `mcp_managed`, `workspace_hooks`, `skill_pushes` |
| legacy tasks | `tasks`, `task_events` — retained for database compatibility |
| legacy substrate | `swarms`, `swarm_agents`, `swarm_messages`, `swarm_deliveries`, `swarm_plan_events_applied` |

Tables use `CREATE TABLE IF NOT EXISTS`; unused tables generally remain for compatibility.
`migrate_routines_to_standalone` rebuilds `routines` and `routine_runs` before removing
their obsolete storage dependencies: `named_agents`, `agent_messages`,
`agent_skill_sources`, `chat_threads` and `chat_messages`.
Column evolution is
`db.rs::add_column_if_missing`, which checks `pragma_table_info` before `ALTER TABLE`, at
every column a later version added. **There is no `PRAGMA user_version`**: evolution is idempotent per-column
additions plus two one-shot boot sweeps.

In memory only, by design: live `sessions` and restored `dead` husks; `swarm_activity`
(transient chip text); and the ephemeral routing maps (`respawned_as`, `handoff_jobs`,
`ssh_prompts`, `visibility`, `hook_drop_states`).

## Background loops

`boot::spawn_background_loops` is called only by the daemon host and spawns three tasks:
`swarm_mail_loop`, `delegation_watch_loop`, `routine_fire_loop`.
`swarm_mail_loop` carries two jobs per round — `hook_drop_tick` first, then
a `plan/events/` GC sweep gated to `SWARM_MAIL_GC_SWEEP_INTERVAL_MS`. Mail delivery uses
`pane_inbox` `Mail` rows and the shared inbox delivery paths. The loop lists the legacy
transcript directory only to satisfy the GC sweep's `last_listing_ok` gate.
The tick runs on `spawn_blocking`; the delay between
rounds comes from `fs_watch::PollLadder`, a pure state machine: 1 s during a burst (5 polls,
re-armed by any yielding round), otherwise 7.5 s or 30 s with a healthy watcher — depending
on whether a client is attached — and 2 s or 5 s with a dead one.

A filesystem-watcher event fires `swarm_mail_wake` (a `tokio::sync::Notify`) which cuts a
sleep short — never lengthens one. Mailbox GC retention is 24 h, wire-settable.

`boot::spawn_startup_refresh` is the sibling for one-shot work that must not block the
window appearing: a legacy-hook sweep, then workspace and consented-agent hook installs, all
on `spawn_blocking`, plus `spawn_at_boot` for MCP registration with Claude Code, Codex, Grok,
Cursor and Antigravity.

## Routine runs

A routine is a standalone record: a prompt, a cadence and its own execution settings.
Every firing, scheduled or by hand, runs the same path: a fresh terminal pane in the
routine's `workspace_id`, on the routine's `engine`/`model`/`effort`, under its
`permission_mode` and `isolate` flags. There is no conversation and no `--resume`; the
pane is observed through its `RoutineRun` row and can be opened from the routine's history.

- **Every run is a `RoutineRun` row** (`routine_runs`), independent of any conversation:
  `trigger` (`Schedule`/`Manual`), a typed status (`Running` plus the `RoutineOutcome`
  arms), the pane's `session_id`, its error and timestamps. `Routine.last_*` is a
  denormalised summary of the newest run. A row still `Running` at boot was cut off by the
  daemon stopping, and is closed `Failed` there.
- Cadence is the only trigger. One catch-up loop drives every routine (`routines.rs`'s
  `ROUTINE_TICK_MS`, 15 s), bounded by `ROUTINE_RUNS_CONCURRENT` (3 at once) and
  `ROUTINE_RUN_MAX_MS` (30 min per run); a week of downtime fires each routine once on the
  next tick rather than replaying every missed firing, and every run ends in a typed
  `RoutineOutcome` (`Ok` · `Denied` · `KilledAtCap` · `EngineRefused` · `Failed`).
  `routine_run_now` is the same call with `trigger = Manual`, refused while
  the routine's previous run is in flight (`AlreadyRunning`).
- A run in a workspace that no longer exists is refused at fire time, not guessed at; the
  refusal lands in the run's `error` and in `Routine.last_error`.
- `model`, supported per-run `effort`, and the permission mode are launch arguments, not
  display-only metadata. Accept-edits uses the provider's bounded unattended mode; a provider
  without one is refused by name. Full access is only valid with an isolated worktree.
- A provider or launch combination that cannot open a pane is refused by name before a session
  is made (`EngineRefused`).

## Settings and logging

The `settings` table is a plain string KV store. Live keys: `session_idle_reap_enabled` and
`session_idle_reap_minutes` (≤ 40 000), `keymap_overrides`, `skill_sync_auto_push`,
`command_history_ignore_globs`, `voice_settings`, `restore_budget`,
`mailbox_retention_hours`, `orchestration_max_live_children` and
`orchestration_max_spawn_depth` (both ≤ `proto::ORCHESTRATION_CAP_MAX`).

`EnvFilter::try_from_default_env()` reads `RUST_LOG`, defaulting to `houston_core=info`. Two
sinks: stdout unconditionally, and a daily-rotating file layer under `<state dir>/logs/`
(prefix `houston-core`, suffix `log`, `MAX_LOG_FILES` = 14). Fail-soft — an unopenable log dir
disables the file sink and leaves stdout wired, never blocking boot. `init()` must run only
after the channel is settled, because `log_dir()` reads the channel fresh. Two app-level
NDJSON sinks sit beside the DB: `app-debug.ndjson`, `watchdog.ndjson`.

## Environment read

The developer-relevant subset.

| Variable | Controls |
|---|---|
| `HOUSTON_CHANNEL` | state-dir channel selection (the *pane* input in the app binary) |
| `HOUSTON_SESSION` | which pane a process runs in; gates `--fresh` and `hs-pane` |
| `TR_SESSION` | hook → session correlation (`claude_hooks.rs`) |
| `TR_SWARM_SCOPE`, `SWARM_AGENT_NAME` | mailbox scope root and agent label |
| `HOUSTON_MCP_URL`, `_TOKEN`, `_CONFIG` | orchestration endpoint and credential |
| `HOUSTON_SAFE_MODE` | master safe mode; `=1` enables every granular flag below |
| `_DISABLE_AUTO_RESTORE`, `_DISABLE_SWARM_AUTOLAUNCH`, `_RESTORE_BUDGET` | granular restore controls |
| `_AUTOPILOT_REJUDGE_MS`, `_HANDOFF_TIMEOUT_MS` | timing overrides |
| `_SHELL_INTEGRATION` | `=0` disables rc injection |
| `_DEVTOOLS` | `=1` opens webview devtools in debug builds |
| `TR_DEBUG_PTY_DUMP` | directory to tee raw PTY bytes into |
| `RUST_LOG` | tracing filter |
| `HOME` / `USERPROFILE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `CLAUDE_CONFIG_DIR` | path ladders |
| `SHELL`, `ComSpec`, `SystemRoot`, `PATH`, `PATHEXT`, `ZDOTDIR` | shell and exe resolution |

## SSH

`ssh.rs` runs **russh in-process**: no `ssh` binary, no subprocess, no argv. One tokio task
per session, driven through an mpsc `SshCmd` queue (`Data`, `Resize`, `Close`, `Upload`).
Scope is agent and identity-file auth with TOFU host-key verification against
`<state dir>/known_hosts`; there is no auto-reconnect. A host-key prompt parks the handshake
inside `check_server_key` on a `oneshot::Sender<HostKeyVerdict>` held in
`Daemon::ssh_prompts`, keyed by request id.

Passwords and passphrases live in the OS keychain (Secret Service via zbus, pure Rust) and
`ssh_profiles` stores only a profile-name reference. It fails closed and loud with no
fallback store, `Secret` has no `Debug`/`Display` and zeroizes on drop, and deleting a
profile deletes its credential — no `SSH_ASKPASS` is needed, russh takes the password as a
value. `ssh_config.rs` honours exactly `HostName`, `User`, `Port`, `IdentityFile`;
`ProxyJump`, `Match` and `Include` are documented as ignored rather than half-honoured.

## Git and GitHub

`git.rs` shells out to the system `git`; libgit2 was rejected. Its surface is the Changes
pane's data model: `status`, `diff`, `review_diffs`, `head_sha`, `branch`, `sync`, `stage`,
`unstage`, `commit`, `push`, `discard`, `default_base`, `status_vs_base`, `is_git_repo`.
Subprocesses run with `GIT_TERMINAL_PROMPT=0`, and diffs pass `redact_review_secrets` before
display. `gh.rs` wraps the GitHub CLI through `crate::spawn::command("gh")`: `state()`
probes install and auth, `pr_status()` reads `gh pr view --json …`, `pr_create()` runs
`gh pr create --fill` then re-reads. A missing or unauthenticated `gh` is a **typed state**,
never a wire error — a wire error here becomes a toast loop.

## Voice

`voice/capture.rs` holds a persistent cpal input stream feeding a wait-free
`rtrb::RingBuffer<f32>` at a 16 kHz target with 5 s of capacity, so the audio callback thread
never blocks. `voice/whisper.rs` is the local engine via `whisper-rs`, CPU-only — `load`
calls `use_gpu(false)` explicitly so the build choice and the runtime choice cannot drift;
the crate is `cfg(unix)`-gated and the Windows local engine is a named refusal.
`voice/cloud.rs` is a Groq OpenAI-compatible Whisper client whose key lives in the keychain
under `groq-api-key`; `voice/models.rs` carries the catalog, verified download, delete and
disk usage. The runtime is constructed at boot but **opens no device** —
`VoiceSettings::enabled` defaults false, and the mic opens only when that turns on.

## Usage

`usage/` streams agent CLI session transcripts to produce token counts, under four
load-bearing bounds stated in `usage/mod.rs`'s module doc: read-only and only while a client
asked (no timer, no watcher, no boot scan); **counts only** — a line becomes a tally and is
dropped, so nothing is retained, logged, cached or wired; fail-soft, so a drifted format
yields fewer records rather than a failed scan or a wrong number shown as right; and no
semantics — it drives no status, lifecycle or behaviour.

Scan roots are `~/.claude/projects` and `~/.codex/sessions`, plus a config-dir-relative
variant; scans run under `spawn_blocking`. The scan cache is its own SQLite store
(`SCAN_CACHE_VERSION` 2). Model rates come from a public pricing table with
`RATE_TABLE_TTL_MS` of 24 h and a 10 s fetch timeout.

## Redaction

`sanitize.rs` is the shared redactor. Patterns: PEM private-key blocks, AWS `AKIA…`/`ASIA…`
keys, GitHub `gh[pousr]_` tokens, three-part base64 JWTs, v4 UUIDs (called out because that
is also the shape of the daemon's own bearer token), env-secret assignments, `Authorization`
headers, URL userinfo, and generic secret/authorization assignments. A Shannon-entropy pass
exists (`redact_high_entropy`) and is **deliberately skipped** by `redact_command_secrets`:
`/` counts as base64, so it would flag ordinary paths. Call sites are git diffs, stored commands and handoff blocks.

`matches_ignored(text, globs)` compiles each ignore glob to an anchored regex where `**`
crosses `/`; it is fed from the workspace's `ignore_paths` and checked before a command or
cwd is persisted.
