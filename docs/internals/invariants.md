# Invariants

Rules that protect resources outside Houston's control: an external tool's format, the user's
files, the user's desktop session, or a safety gate. Each one names what enforces it and the
incident or measurement behind it. [`AGENTS.md`](../../AGENTS.md) states the rules; this file
carries the reasons.

## Signals and processes

### Only `pid.rs` may call `kill(2)`

**Enforced by** `scripts/check-kill-guard.sh` (CI): `libc::kill(`, `nix::sys::signal`,
raw `syscall(`, `OpenProcess`/`TerminateProcess`/`taskkill` are forbidden outside
`core/houston-core/src/pid.rs`.

**Why.** A test once called `terminate_and_wait(u32::MAX, …)`. Cast to `pid_t`,
`u32::MAX` is `-1`, and `kill(-1, SIGTERM)` is a broadcast to every process the user owns.
It destroyed the desktop session. `checked_pid` now refuses `0` (the process group) and
anything above `i32::MAX`, and identity-checked delivery compares the process creation
token before sending, so a recycled pid is never the daemon.

### Never kill by pattern

No `pkill -f`, no `pgrep | kill`, no pid found by matching a name or path. `houston-core`
matches the daemons of both channels; a worktree path matches your own agent's argv. Kill
only the pid recorded in the target channel's `daemon.json`, after confirming the channel.
Scripts that must stop something they started stop it by the pid they captured
(`linux-vm.sh app-stop`, `dev.sh --fresh` via the binary's identity-checked terminate).

### Every spawn goes through `houston_core::spawn`

**Enforced by** `scripts/check-spawn-window.sh` and a clippy `disallowed-methods` entry in
both `clippy.toml` files banning `std::process::Command::new` and
`tokio::process::Command::new`.

**Why.** On Windows a console-subsystem child flashes a window unless spawned with
`CREATE_NO_WINDOW`. The flag must *not* reach `portable_pty::CommandBuilder` — the PTY path
needs its console — and the script asserts that too.

### Opening a file or URL never goes through a shell string

`src-tauri/src/shell.rs`'s `open_target` execs `xdg-open` on Unix and calls `ShellExecuteW`
on Windows — never `cmd /C start` or a shell interpreter over renderer-supplied text. An
interpreter over a URL or path an agent's browser tools or the Files pane handed it would be
an injection surface; `xdg-open`/`ShellExecuteW` take the target as a value, the same
primitive a double-click uses.

### Filesystem commands are allowlist-gated

Every disk-touching Tauri command (`fs_read_file`, `fs_write_file`, `fs_delete`, …) passes
through `fs_allowlist::assert_within_allowed_roots` before touching a path outside the state
dir's own reserved slots. **Enforced by** the gate itself, called at every command's own entry
point in `src-tauri/src/fs.rs` — there is no shared middleware layer to bypass by adding a new
command that forgets the call.

## Channels and state

### Protect the installed release channel

`~/.houston` is the installed app's live state, in use while you work. Never start a
daemon against it, never open its DB read-write, never clean it up. `--channel release`
prints a loud warning and is used only under explicit instruction.

**Why.** The installed app's desktop entry once launched `core/target/release/houston-core`
straight out of the repo. A release-profile build relinked that binary; hours later an
oomd kill restarted the app, and a protocol-34 daemon came up under a packaged
protocol-29 UI, locking the user out and corrupting the release DB. `install-desktop.sh`
now installs *copies* under `~/.local/lib/houston/` and refuses to finish if any
installed file references the repo path. If the installer ever points at build outputs
again, the release-build moratorium returns with it.

### One daemon per state dir

**Enforced by** `daemon.lock` (`flock`, `LOCK_EX|LOCK_NB`), taken by the daemon only,
released by the kernel on any death. A contended lock refuses the second daemon; the app
holds no lock at all and never has one to leak.

**Why.** Whichever daemon writes `daemon.json` last captures every hook and helper, and both
write the same SQLite file. `--daemon-fresh`/`--fresh` are the sanctioned restart: an orderly
stop over `/manage`'s `daemon_shutdown`, confirmed before a fresh daemon starts. Both refuse
when the invoking shell is a pane on the channel being restarted, because restarting would
kill the shell running the script.

### The daemon outlives the window; the window never holds the lock

**Enforced by** `daemon_host.rs`'s connect-or-spawn boot and `shutdown` (no lock acquisition,
no `daemon.json` removal, no persistence call — see "One daemon per state dir" above and
`overview.md`'s "Detach and shutdown").

**Why.** Quitting Houston is not the same event as the daemon exiting: a window closing (or
crashing) must never end a session underneath it. The app's only lifecycle action
on quit is closing its `/ws` connection; the daemon decides its own exit, on an orderly stop
or its reap timer, never on the app's behalf.

### The binary resolves its channel from the flag, never the environment

**Enforced by** `scripts/check-dev-channel.sh`, which runs `dev.sh --print-target` in a
throwaway `$HOME` and asserts an inherited `HOUSTON_CHANNEL` never moves the target.

**Why.** Every pane inherits `HOUSTON_CHANNEL=release` from the installed app. If the
binary read it as a request, running `dev.sh` from an installed-app pane would drive the
release channel. The env var is the *pane* input (used by the `--fresh` self-protection
guard); `--channel` is the *target* input. `paths::resolve_owning_channel` refuses when
neither is explicit.

### One host spawns the background loops

**Enforced by** `scripts/check-loop-spawn-sync.sh`: `core/houston-core/src/main.rs` must call
`boot::spawn_background_loops`, and `src-tauri/src/daemon_host.rs` must not — a call there
would mean the app is hosting a daemon in-process again.

**Why.** Duplicate loop lists can omit background work without a compile error, including
hook delivery through `swarm_mail_loop`. A single daemon host owns the complete list; the
app connects as a client.

## Other tools' files

### No transcript parsing, no undocumented protocols

Houston does not parse `~/.claude/projects/*.jsonl` and does not speak Claude Code's
`control_request` stdio protocol. Integration goes through hooks, `--permission-prompt-tool`,
documented flags (`--print --output-format stream-json`), ACP, and official SDKs.

Four recorded carve-outs stand. A fifth needs the same recorded treatment.

| # | File | Bound |
|---|---|---|
| 1 | `~/.claude.json` | keys `oauthAccount`, `emailAddress`, `userID` only; read once at connect; fail-soft; Houston snapshots what it needs and never depends on the file afterwards |
| 2 | `~/.claude.json`, `~/.codex/config.toml` | Claude's key `mcpServers` and Codex's table `[mcp_servers]` only; read on MCP-surface open, explicit refresh, and once at boot; **writes go through `claude mcp add`/`remove` and `codex mcp add`, never the file**; an existing `houston` entry is never overwritten (unless stale release-port refresh for Codex) |
| 3 | `~/.claude/projects/**/*.jsonl`, `~/.codex/sessions/**/*.jsonl` | Settings → Usage streams them for token counts. Read-only and only while a client asked (no timer, watcher or boot scan); counts only — a line becomes a tally and is dropped; fail-soft; **no semantics** — drives no status or behaviour. Terms: `core/houston-core/src/usage/mod.rs` |
| 4 | `<the CLI's own transcriptPath>, Antigravity only` | The path comes from the provider's own hook payload and is never constructed by Houston; the last assistant entry only; read once, at a turn end, in the helper process; fail-soft (any error is no last message, never an error to the CLI); capped at the submit cap. Terms: `core/houston-core/src/antigravity_transcript.rs` |

### App-initiated config writes use reversible managed markers

Hook entries in `.claude/settings.local.json`, `~/.codex/config.toml`, `~/.cursor/hooks.json`,
`~/.grok/hooks/…` and the OpenCode plugin carry `--houston-managed[=<channel>]`
matched **per whitespace token** — `release`'s sentinel is a prefix of `dev`'s, and substring
matching would let one channel evict the other. What Houston created (the file, the top-level
`hooks` object) is recorded in `workspace_hooks` so uninstall removes exactly Houston's residue.
Codex's `notify` is a single key, so a second channel parks the displaced line as a
sentinel-carrying comment rather than clobbering it. User-initiated writes into a CLI's
skill directories (`writeSkill`, skill push with backup) are fine.

### Measured values yes, class strings never

Another app's shipped UI may be read for its measured values and structure; its class strings
may not be copied. Since both sides speak Tailwind, a pasted class *renders* — just not what
it rendered there — and bypasses the chrome constants every Houston call site composes
through. A silent near-miss is worse than a visible one. Where a licence does permit copying,
the copy carries its notice in `NOTICE` — added in the same commit that lands the copy, never
after.

## Status

### Agent status is hooks-driven; PTY content is not a status machine

`Daemon::set_status` is the single mutation point. Its inputs are hook drop files (mapped
through `agent_events.rs`) and ACP streams. Three exceptions are named; anything beyond them
must be named and recorded here, not blended in.

1. **OS process liveness** (`has_child_procs` / `has_running_procs` in `daemon.rs`) is a
   kernel fact read from procfs on demand — never on a timer, never from terminal content.
   It gates the idle reaper and the pane-close confirmation. It does not set `AgentStatus`.
2. **Content→text somebody reads.** Two paths under one rule: what they produce is text for
   a reader, never an `AgentStatus`.
   - **The activity mirror.** `Daemon::extract_activity` runs per chunk (throttled
     1/s) to produce display text. Its single status effect is roster-level
     `Spawning→Running` on first output, which fires once by construction. Re-armed, polled
     or per-frame would be a status machine again.
   - **The handoff excerpt.** `Daemon::inbox_excerpt` and
     `Daemon::deliver_unsubmitted_turn_end` read a bounded render of a child's screen
     (the session's emulator, `HANDOFF_CORROBORATING_ROWS` rows) and attach it to the wake its parent
     is already getting. Read once per delivery, on a lifecycle event — or, for a hookless
     child, on the one settle that #3 decided is its turn end — never sampled; capped at
     `HANDOFF_EXCERPT_MAX_CHARS` with a visible marker. Both excerpts go through
     `orchestrate::sanitize_handoff_text`, and the indent it puts on a forged framing line
     reaches the parent: `orchestrate::compose_inbox` drops blank rows and trailing whitespace
     and nothing else, where a plain `trim()` used to take the indent back off the FIRST
     row. What that buys is one layer of three, and only the outer one is a parser: the
     excerpt is emitted behind `  > ` and the inbox is written into the parent inside
     bracketed paste, while the indent is a quoting cue for the agent reading it and would
     not survive a reader that trims before it compares. Nothing in the daemon or the
     renderer is such a reader — nothing there parses these strings at all; the readers are
     `Daemon::extract_activity`, which only skips framing lines when it picks
     display text, and two substring waits outside the product (`scripts/probe-orchestration.sh`,
     `tests/common/mod.rs`). On an unstaged turn
     end the tail IS the payload, so it is labelled `no_handback` in the subject line and
     again in the body: a parent must never read a child's screen as something the child
     handed over. That same read also answers one yes/no about the pane — has it ever ended
     a line (`Scrollback::wrote_a_line`) — which is one of the three facts
     `orchestrate::unsubmitted_turn_end_reaches_parent` needs before it suppresses a
     delivery. Read at the same moment as the tail, never sampled, and what it produces is
     whether one wake is sent, never an `AgentStatus`.
3. **The delegation quiet-settle detector.** What stands in for a turn end on a CLI that
   reports none at all: `Daemon::delegation_watch_tick` samples the rendered screen and,
   when it has not changed for `DELEGATION_SETTLE_QUIET_MS`, makes the child's stored
   result eligible for its parent and closes the record — or, with nothing stored, sends
   the `no_handback` notice of #2 instead and leaves the record open. It serves both halves
   because on those providers nothing else ever will: `no_handback` otherwise hangs off
   `AgentEvent::TurnEnded`, which `Custom` never fires. Bounded four ways: it runs **only**
   for a child whose
   `TurnEndSource` is `QuietSettle` — which is also what keeps it from delivering a second
   time for the six providers whose hook already did (every other delegation is released
   by its CLI's hook or its ACP stream and never reaches here); never while
   `has_running_procs` says a descendant is alive; the no-handback notice **once per
   silence**, never once per poll, latched on the same sample that measures the quiet so
   the child's next byte clears both together; and what it produces is a delegation flush
   or one inbox entry, never an `AgentStatus`. `orchestrate::delegation_settle_action`
   holds that decision, and every delivery it makes names `quiet-settle` to the parent, so
   a turn end Houston inferred is never mistaken for one the CLI reported. It carries the
   read of #2 it shares with the reported path —
   the tail IS the payload of a no-handback notice, and it is labelled as the child's
   screen in the subject line and again in the body.

**One turn end per provider.** A provider's `agent_events.rs` table carries at most one
`AgentEvent::TurnEnded` row, and that row is the CLI's loop-termination event — never a
per-step event that happens to land near the end of a turn. `TurnEnded` is not a status
nudge: it raises a `Finished` notice, closes a delegation and opens a `no_handback` round,
so a second row ends one turn twice and tells a parent a handback went missing that was
never due yet. The same rule refuses a sub-agent's completion event (Claude's
`SubagentStop`, OpenCode's child-session `session.idle`): a sub-agent finishes *inside*
the parent's turn. `every_provider_ends_a_turn_at_most_once` holds it.

Providers without hook mappings (Droid, Copilot, Aider) get identity only, from
banner sniffing that `agents.rs` explicitly documents as not the status machine. They can
be delegated to, via #3 — identity is still not status.

### The daemon owns a terminal emulator; it never reads it for status

**What it is.** Each session has one libghostty-vt terminal (`vt.rs`), the same library the
renderer paints with, built natively into the daemon from the same pinned revision. It is fed
every PTY chunk after the token redactor. This is the third lawful reader of PTY content,
alongside the activity mirror and the handoff excerpt above — and unlike those
two it reads nothing *for* a decision. It has exactly two consumers: an attach
(`session_attach{snapshot:true}` answers with its state, and the handoff manifest carries the
same bytes) and a screen read (`pane_read --source screen`, `WaitForIdle`), plus the terminal
questions it answers on its own behalf.

**Why it is not the rule above.** What it produces is a screen and the bytes the terminal owes
the program — never an `AgentStatus`. Nothing samples it on a timer; nothing derives a
lifecycle transition from a cell. A pane's status still comes from hooks and ACP, and an
emulator that started setting one would be the pixel-reading machine the whole invariant
forbids.

**Query ownership.** The emulator parses every chunk, but its replies reach the PTY only while
`Session::watched()` is false — no Tauri output sink, no `/ws` connection holding it. A watched
pane is answered by the renderer's engine, which is the same engine, so the answers are the same
bytes. Exactly one of the two is the answerer at any moment; there is no case where both reply
and none where neither does.

**What changed, and why it is safer than what it replaced.** The predecessor was a fixed table
of three questions (`terminal_query.rs`) that left every question needing a rendered screen —
cursor position, kitty keyboard flags, DECRQM for any other mode — unanswered by name, because
a wrong answer is worse than silence. A real emulator answers them correctly instead of
guessing, which removes the reason the table had to stay small. What it must NOT gain is a
reader that turns a cell into a status.

### A window title is a name the CLI sent us, not the screen

`osc_title.rs` reads the OSC 0/2 window title (`ESC ] 0 ; <text> BEL`) out of every agent
pane's PTY stream and uses it to name the pane, so the header says what the CLI itself calls
the session — the same summary its own resume picker shows.

**Why this is not "status comes from the CLI, not from pixels".** A window title is a
protocol message the program addresses to its terminal, exactly like the OSC 52 clipboard
write and the terminal queries above. Houston is that terminal; receiving it is reading mail
addressed to us, not inferring anything from rendered content. And what it produces is a
*name*: it never reaches `AgentStatus`, and no code branches on it.

**The bounds.** Titles are capped (512 bytes raw, `MAX_TITLE_LEN` after sanitizing) and
dropped past that; the scanner keeps one small carry and no screen. A pane takes at most one
name per second from its CLI (`CLI_TITLE_MIN_GAP_MS`), because each one is a DB write and a
broadcast on the reader's own thread. Shell panes are excluded, because a shell's precmd title
is the cwd rather than a session summary. A name the user typed always wins, and is never
overwritten by a later title.

### Resume is cut

Houston resumes no conversation. A restarted pane comes back on a *fresh* CLI. No ledger, no
`--resume`/`--continue` at spawn, no recovery banner, no husk revival. A routine run is
always a fresh context too: nothing the daemon runs unattended carries a previous turn's
id forward. Re-adding resume reverses a recorded ruling — say so out loud.

## Wire

- Daemon and UI ship wire changes in the same commit; one `PROTOCOL_VERSION` bump per
  wire-touching batch; `protocol/protocol.md` updated in the same commit; generated TS
  committed. **Enforced by** `check-protocol-sync.sh` (Rust ↔ TS ↔ doc header) and, at
  build/install time, `check-renderer-fresh.sh` (the built bundle's inlined version).
- **Why.** A bump once left the generated constant at 34 while Rust went to 35, and every
  existing gate passed because nothing compared the two.

## Renderer

- **Tauri's `tracing` feature stays off** and no file under `src-tauri/src/watchdog/` except
  `clocks.rs` reads `SystemTime`. **Enforced by** `check-watchdog.sh`. With `tracing` on,
  `eval_script_with_callback` takes a blocking path and the watchdog supervisor can block
  on the event loop it is watching; the suspend classifier is defined on `boot − mono`, so
  wall-clock reads anywhere else corrupt it.
- **No native `<select>`** outside `components/Select.tsx` — its open popup is an unstyled
  GTK window under WebKitGTK. **Enforced by** `check-native-select.sh`.
- **No raw `lucide-react` imports** outside `components/icons.tsx`. **Enforced by**
  `check-icon-imports.sh`.
- **`title=` is not a tooltip.** A native `title` on an icon-only button is its accessible
  name; a `Tooltip` gives only `aria-describedby`, so the string must also go to
  `aria-label`. And `<Row title=…>` is a visible heading, not a tooltip. **Enforced by**
  `check-title-tooltip-guard.sh` with an explicit allowlist of heading-prop components.

## Doc and comment hygiene

### Doc shape and comment shape are gated, not asked for

**Enforced by** `scripts/check-doc-hygiene.sh` (allowed tree, a cap on live plans, no diary
content — no dates, no `phase N`/`step N` numbering, no pointer into a private clone
directory) and `scripts/check-comment-hygiene.sh` (the same no-dates/no-phase-numbers/
no-session-narrative/no-app-names/no-dead-pointers rule, plus a length cap, applied to code
comments) — both run in CI and again on every edit through the project hook.

**Why.** The same rules living only in prose let the tree drift for months before anyone
noticed comments and docs had accumulated diary content nobody would write as a review
comment on its own.

## Ratchets only tighten

**Enforced by** `scripts/check-ratchets-only-tighten.sh`, which diffs every shrink-only
per-file baseline (complexity, spacing tokens, radius tokens, control metrics, focus-visible
exemptions) against a reference commit and fails if any file's pinned count rose; an
unresolvable reference fails rather than silently skipping the check.

**Why.** A gate that enforces its own pinned numbers faithfully but nothing about what those
numbers should be invites the cheapest fix: editing the pin down is a smaller diff than fixing
the violation, and it is the fix an agent finds first.

## A gate proves it can fail

**Enforced by** `scripts/check-mutations.sh`, which points each covered gate at a fixture
built to violate the rule it protects and requires the gate to fail **by name** — coverage
across the checked gates is itself a ratchet that only rises.

**Why.** The same reasoning that makes a green test on an impossible fixture worthless applies
to a gate: a check that never fires on a broken fixture is silence wearing the shape of a
passing check.

## Builds

- **Never two cargo workloads at once.** `cargo` saturates every core; several concurrent
  builds push the user slice past `systemd-oomd`'s 50 % pressure threshold, and oomd kills
  the *whole* terminal scope — shell, editor, agents — silently. `oom-shield.sh` caps one
  scope (`MemoryHigh=10G`, `MemoryMax=12G`, `nice -n 19`) and serializes invocations with a
  per-user flock; it refuses to run unshielded. The caps are receipted against a measured
  4141 MiB cold-build peak.
- **`perf_smoke` runs at normal priority on an idle machine.** Niceing starves its drain
  loop. The same tree measured 127.6 MiB/s idle and 1.4 MiB/s with a concurrent compile —
  a ~90× swing that looks exactly like a PTY regression.
- **Full suites run at integration boundaries and before pushes.** Running the full Rust
  suite for every small edit creates avoidable memory pressure; use focused tests while
  iterating and the full suite at the documented delivery cadence.
