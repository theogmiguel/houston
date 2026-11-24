# Invariants

Rules that protect resources outside Houston's control: an external tool's format, the user's
files, the user's desktop session, or a safety gate. Each one names what enforces it and the
incident or measurement behind it. [`AGENTS.md`](../../AGENTS.md) states the rules; this file
carries the reasons.

## Signals and processes

### Stop a server only by the PID its channel names

`apps/desktop/src/backend/DesktopServerAttachment.ts` reads
`<channel dir>/v2/userdata/server-runtime.json` and probes that PID. `isProcessAlive` refuses
anything that is not a positive integer, so a malformed record cannot become a broadcast: on
POSIX `kill(-1, …)` signals every process the user owns.

### Never kill by pattern

No `pkill -f`, no `pgrep | kill`, no PID found by matching a name, path or parent PID. One
server name matches every channel's server, and a worktree path matches your own agent's
argv. Stop a server only by the PID its channel's `server-runtime.json` names, after
confirming the channel. Scripts that must stop something they started stop it by the PID
they captured.

### Opening a file or URL never goes through a shell string

`apps/desktop/src/electron/ElectronShell.ts` passes the target to Electron's `shell.openExternal`
and `shell.openPath`. Electron takes the URL or path as a value, never as shell text, so a
renderer-supplied string cannot become an interpreter command.

### In-distro commands avoid a second shell parse

Commands the app runs inside a WSL distro are `wsl.exe -d <distro> ...`, built in
`apps/desktop/src/wsl/DesktopWslEnvironment.ts` and
`apps/desktop/src/backend/DesktopBackendConfiguration.ts`. Scripts travel on stdin (`sh -s`,
`bash -l -s`) rather than as quoted argv.

**Why.** After `--`, `wsl.exe` hands the argv to the distro's login shell, which parses it
a second time: on WSL 2.6.1 that expanded `$HOME` inside single quotes. `--exec` passes each
argument through unchanged but omits the login-shell `PATH` that provider CLIs and npm need, so
only commands that do not need it use `--exec`.

## Channels and state

### Protect the installed release channel

`~/.houston` is the installed app's live channel. A development build resolves its channel
from `HOUSTON_CHANNEL`; `scripts/dev.sh --channel <name>` sets it and defaults to `dev`, and
`--channel release` prints a warning naming the live directory. Tests use temporary homes and never the real one.

### One server per channel directory

Upstream's server ownership lock refuses a second server for the same base directory, which
would otherwise share a SQLite database and overwrite the runtime file clients discover the
server through. The host attaches to a live server named by
`<channel dir>/v2/userdata/server-runtime.json` and spawns one only when none answers.

### The server outlives the window

The server owns threads and runs, so closing the window stops neither. The host starts the
server as a child process and stops it when the application quits; it never stops a server
it attached to.

### v1 state is read, never written

v2 keeps its state in `<channel dir>/v2/`. Everything a v1 install left directly under the
channel directory stays as it was: the Tasks, task-source and Slack imports open `houston.db`
read-only, and the host's start-up cleanup only reads its discovery file, to stand down while that
channel's v1 daemon still runs.

**Why.** The installed v1 release may still be in use on the same machine, and its state is
the user's history; nothing in v2 can restore it once overwritten.

### The renderer's debug log is development-only

The motion and frame probes reach the host through `HostBridge.logDebug`. The host appends one
NDJSON record per call to `<channel dir>/v2/userdata/logs/app-debug.ndjson`, and only while it
runs as a development build or a named channel. A stable release writes no such file, so
probe traffic cannot become a production log.

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
may not be copied. Since both sides speak Tailwind, a pasted class _renders_ — just not what
it rendered there. Where a licence does permit copying, the copy carries its notice in
`NOTICE`, added in the same commit that lands the copy.

## Doc and comment hygiene

### Doc shape and comment shape are gated, not asked for

**Enforced by** `scripts/check-doc-hygiene.sh` (allowed tree, no diary content — no dates,
no `phase N`/`step N` numbering, no pointer into a private clone directory) and
`scripts/check-comment-hygiene.sh` (the same rules plus a length cap, applied to code
comments) — both run in CI, and the comment check runs again on every code-file edit through
the project hook (`scripts/hooks/comment-hygiene-hook.sh`).

**Why.** The same rules living only in prose let the tree drift for months before anyone
noticed comments and docs had accumulated diary content.

## Ratchets only tighten, and a gate proves it can fail

The `apps/web` style guards pin a per-file count in `scripts/web-style-baseline/`; CI fails
on a raised count or a stale entry. `--update` rewrites a baseline to the scanner's current
counts, so the baseline diff in review is what shows a pin that rose.
`check-web-style.sh --self-test` points each guard at its `bad` fixture and requires it to
fail.

**Why.** Editing a pin is a smaller diff than fixing the violation, and it is the fix an
agent finds first; a check that never fires on a broken fixture is silence wearing the shape
of a passing check.

## Inference gateway

`apps/server/src/houston/inference/InferenceGateway.ts` forwards the OpenAI Chat Completions,
Completions and Responses APIs and the Anthropic Messages API to one registered server. It is
outside environment auth: the only credential is a bearer token minted by
`InferenceGatewayCredentials` per provider session (bound to an instance, thread and server) or per
background scope. That token is stored as a hash in memory, never in the database, logs, traces,
errors or RPC replies, and MCP, OAuth and session tokens do not resolve there. The upstream key is
read from the secret store and sent only to that key's server; cookies, client credentials and
proxy headers are never forwarded, and `x-proxy-*` headers are recomputed from authenticated thread
state rather than copied from the caller.

Requests are buffered up to 32 MiB and refused past it. Redirects are refused, not followed, so the
upstream key cannot reach another origin. The admission queue, fallback, bounded retry, watchdog
and request log are described for users in `docs/user/local-models.md`; their limits live with the
code (`MAX_WAITING`, `MAX_WAIT_MS`, `MAX_REQUEST_BYTES`, `FIRST_CONTENT_TIMEOUT_MS`,
`IDLE_TIMEOUT_MS`). The request log (`houston_inference_requests`, a Houston-track migration) never
stores request or response text, only a bounded failure cause and a short static-prefix hash, and
sweeps rows past its one-week retention.

**Why.** A local server may be shared, so its key must not leak into a client, a log or another
origin; and a runaway local model otherwise consumes a slot until someone notices.

## Builds

- **Never two Cargo workloads at once.** `cargo` saturates every core; concurrent builds push
  the user slice past `systemd-oomd`'s pressure threshold, and oomd kills the whole terminal
  scope — shell, editor, agents — silently. `oom-shield.sh` caps one scope
  (`MemoryHigh=16G`, `MemoryMax=18G`, `nice -n 19`) and serializes invocations with a
  per-user flock.
- **Full suites run at integration boundaries and before pushes.** Use focused tests while
  iterating and the full suites at the documented delivery cadence.
