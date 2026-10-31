# Invariants

Rules that protect resources outside Houston's control: an external tool's format, the user's
files, the user's desktop session, or a safety gate. Each one names what enforces it and the
incident or measurement behind it. [`AGENTS.md`](../../AGENTS.md) states the rules; this file
carries the reasons.

## Signals and processes

### Only `sys/pid.rs` may call `kill(2)`

**Enforced by** `scripts/check-kill-guard.sh` (CI): `libc::kill(`, `nix::sys::signal`,
raw `syscall(`, `OpenProcess`/`TerminateProcess`/`taskkill` are forbidden under `src-tauri/`
outside `src-tauri/src/sys/pid.rs`.

**Why.** A test once called `terminate_and_wait(u32::MAX, …)`. Cast to `pid_t`,
`u32::MAX` is `-1`, and `kill(-1, SIGTERM)` is a broadcast to every process the user owns.
It destroyed the desktop session. `checked_pid` refuses `0` (the process group) and
anything above `i32::MAX`.

### Never kill by pattern

No `pkill -f`, no `pgrep | kill`, no PID found by matching a name, path or parent PID. One
server name matches every channel's server, and a worktree path matches your own agent's
argv. Stop a server only by the PID its channel's `server-runtime.json` names, after
confirming the channel. Scripts that must stop something they started stop it by the PID
they captured.

### Every host spawn goes through `crate::sys::spawn`

**Enforced by** `scripts/check-spawn-window.sh` and a clippy `disallowed-methods` entry in
`src-tauri/clippy.toml` banning `std::process::Command::new` and
`tokio::process::Command::new`.

**Why.** On Windows a console-subsystem child flashes a window unless spawned with
`CREATE_NO_WINDOW`; `sys/spawn.rs` sets it at construction so a stored builder cannot lose it.

### Opening a file or URL never goes through a shell string

`src-tauri/src/shell.rs`'s `open_target` execs `xdg-open` on Unix and calls `ShellExecuteW`
on Windows — never `cmd /C start` or a shell interpreter over renderer-supplied text. An
interpreter over a URL or path the renderer handed it would be an injection surface;
`xdg-open`/`ShellExecuteW` take the target as a value, the same primitive a double-click uses.

### In-distro commands use `wsl.exe --exec`, never `--`

Every command the app runs inside a WSL distro is `wsl.exe -d <distro> --exec <argv...>`,
built in `src-tauri/src/wsl/command.rs`. **Enforced by** that module's
`every_distro_command_uses_exec` test.

**Why.** After `--`, `wsl.exe` hands the argv to the distro's login shell, which parses it
a second time: on WSL 2.6.1 that expanded `$HOME` inside single quotes. `--exec` passes each
argument through unchanged.

### Filesystem commands are allowlist-gated

Every disk-touching Tauri command (`fs_read_file`, `fs_write_file`, `fs_delete`, …) passes
through `fs_allowlist::assert_within_allowed_roots` before touching a path. **Enforced by**
the gate itself, called at every command's own entry point in `src-tauri/src/fs.rs` — there
is no shared middleware layer to bypass by adding a command that forgets the call.

## Channels and state

### Protect the installed release channel

`~/.houston` is the installed app's live channel. A development build resolves its channel
from `--channel` and defaults to `dev`; `--channel release` prints a warning naming the live
directory. Tests use temporary homes and never the real one.

### One server per channel directory

Upstream's server ownership lock refuses a second server for the same base directory, which
would otherwise share a SQLite database and overwrite the runtime file clients discover the
server through. The host attaches to a live server named by
`<channel dir>/v2/userdata/server-runtime.json` and spawns one only when none answers.

### The server outlives the window

The host starts the server detached (its own session on Linux, a job breakaway on Windows),
so closing or crashing the window stops neither the server nor its agent runs.

### v1 state is read, never written

v2 keeps its state in `<channel dir>/v2/`. Everything a v1 install left directly under the
channel directory stays as it was: the Tasks and task-source imports open `houston.db`
read-only, and the host's start-up cleanup only reads its discovery file, to stand down while that
channel's v1 daemon still runs.

**Why.** The installed v1 release may still be in use on the same machine, and its state is
the user's history; nothing in v2 can restore it once overwritten.

## Other tools' files

### Agent status never comes from terminal output or transcripts

Agent status comes from each provider adapter's structured stream (SDK, app-server, server or
ACP events). Terminal output and on-disk transcripts never drive a status.

### App-initiated config writes use reversible managed markers

v1 wrote hook entries into `~/.claude/settings.json`, `~/.codex/hooks.json` and
`config.toml`, the OpenCode plugin, Antigravity's hooks file and ZCode's settings files, each
carrying `--houston-managed[=<channel>]`. The host's start-up cleanup removes its own
channel's entries, matching the sentinel **per token**: release's sentinel is a prefix of
every other channel's, and substring matching would let one channel evict the other. A user
command sharing a group with a Houston entry stays. Codex's `notify` line that v1 parked as a
sentinel-carrying comment is restored, unless the user has set a new one since; ZCode's
parked `hooks.enabled` value is restored once no channel's entry remains, and an edit of its
file holds `config.json.houston-lock` beside it. JSON configs are written back as v1 wrote
them (whole file, pretty-printed, keys sorted), so a file v1 last wrote keeps every byte
outside Houston's entries. An unparsable config is left as is and logged.

`~/.claude.json` is Claude's own state. Houston changes it only through `claude mcp add` and
`claude mcp remove`, never by writing the file.

### Measured values yes, class strings never

Another app's shipped UI may be read for its measured values and structure; its class strings
may not be copied. Since both sides speak Tailwind, a pasted class *renders* — just not what
it rendered there. Where a licence does permit copying, the copy carries its notice in
`NOTICE`, added in the same commit that lands the copy.

<!-- Renderer invariants (Theo). -->

## Doc and comment hygiene

### Doc shape and comment shape are gated, not asked for

**Enforced by** `scripts/check-doc-hygiene.sh` (allowed tree, no diary content — no dates,
no `phase N`/`step N` numbering, no pointer into a private clone directory) and
`scripts/check-comment-hygiene.sh` (the same rules plus a length cap, applied to code
comments) — both run in CI and again on every edit through the project hook.

**Why.** The same rules living only in prose let the tree drift for months before anyone
noticed comments and docs had accumulated diary content.

## Ratchets only tighten, and a gate proves it can fail

The `apps/web` style guards pin a per-file count in `scripts/web-style-baseline/`; CI fails
on a raised count or a stale entry, and `--update` only lowers pins.
`check-web-style.sh --self-test` points each guard at its `bad` fixture and requires it to
fail. `check-env-ratchet.sh` holds direct environment reads under `src-tauri/src/sys`.

**Why.** Editing a pin is a smaller diff than fixing the violation, and it is the fix an
agent finds first; a check that never fires on a broken fixture is silence wearing the shape
of a passing check.

## Builds

- **Never two Cargo workloads at once.** `cargo` saturates every core; concurrent builds push
  the user slice past `systemd-oomd`'s pressure threshold, and oomd kills the whole terminal
  scope — shell, editor, agents — silently. `oom-shield.sh` caps one scope
  (`MemoryHigh=16G`, `MemoryMax=18G`, `nice -n 19`) and serializes invocations with a
  per-user flock.
- **Full suites run at integration boundaries and before pushes.** Use focused tests while
  iterating and the full suites at the documented delivery cadence.
