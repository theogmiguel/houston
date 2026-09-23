# Agent lifecycle

> For maintainers. Start at [overview.md](overview.md) for the process model.

An agent CLI running in a pane is an ordinary child process. What makes it an *agent* is
that its own lifecycle events reach the daemon — through hooks it installed, or through a
documented JSON-RPC stream. Everything on this page hangs off that: status is
hooks-driven, and PTY content is not a status machine.

## `AgentStatus`

Five variants (`houston-protocol`):

| Variant | Meaning |
|---|---|
| `Spawning` | the pane is up, no hook has fired yet |
| `Working` | a turn is in progress |
| `Idle` | the turn finished |
| `NeedsInput` | a notification or permission prompt is waiting on a human |
| `Unavailable` | a hook-capable or ACP pane produced no lifecycle signal during spawn grace |

`Session::status` is `Option<AgentStatus>` — `None` means no status has been surfaced at
all (a non-agent pane, or before the first signal). It is orthogonal to `Session::state`,
which tracks the process.

## Status mutation and lifecycle effects

`Daemon::apply_agent_event` atomically verifies that the process is live and diffs the
reported status against the current value. On a change, it:

1. broadcasts `ServerMsg::AgentStatus`;
2. drains pending handoffs when the new status is **settled** — `orchestrate::settled` is
   `Idle | NeedsInput`.

The spawn watchdog has one separate compare-and-set path from `Spawning` to `Unavailable`.
It makes the same live-process check and cannot overwrite a lifecycle event that won the
race. A late drop file cannot rewrite a finished pane. A WebSocket connection subscribes
before taking its `hello_ok` snapshot; transitions during handshake remain queued for that
client.

An event that leaves the status unchanged emits no second status, notice or routine
completion. Its delegation effect still runs: a repeated block can refresh the reason, and
a turn-end can settle the current orchestration round even when the visible status was
already `Idle`. `InputResolved` is accepted only from `NeedsInput`, so a late reply cannot
move an already idle pane back to `Working`.

## The event taxonomy

`agent_events.rs` is provider-neutral and installs nothing. The mapping to status is table
driven:

| `AgentEvent` | Status |
|---|---|
| `SessionStarted` | `Idle` |
| `PromptSubmitted` | `Working` |
| `InputResolved` | `Working` |
| `TurnEnded` | `Idle` |
| `TurnInterrupted` | `Idle` |
| `NeedsInput` | `NeedsInput` |

Per-provider event names:

| Provider | Native names → events |
|---|---|
| Claude | `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `PermissionRequest`, `PermissionDenied`, `Elicitation`, `ElicitationResult`, and typed blocking `Notification`; `AskUserQuestion`/`ExitPlanMode` are detected through matched `PreToolUse`, then cleared by the matching tool result |
| Codex | `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, `Interrupt`; matched `PreToolUse(request_user_input)` reports a question and its `PostToolUse` resumes the turn; `Interrupt` settles to `Idle` without completion attention |
| OpenCode | `session.created`, root `message.updated`, `session.status` (`busy`/`retry`), `permission.asked`/legacy `permission.updated`, `permission.replied`, `question.*` and `question.v2.*`, `session.idle`, `session.error`; replies resume `Working`, while errors settle with error attention |
| Cursor | `sessionStart`, `beforeSubmitPrompt`, `stop` — **no `NeedsInput`** — plus `subagentStart`/`subagentStop` and `afterAgentResponse` (last message only, documented not live-verified) |
| Grok | reuses Claude's PascalCase names verbatim, plus `SubagentStart`/`SubagentStop` (documented, not live-verified) |
| Antigravity | `SessionStart`, `PreInvocation`, `Stop`, `PreToolUse` → all four (`PreToolUse` gated by tool name, see below); the matching `PostToolUse` resumes `Working` once no permission episode remains (`PostInvocation` maps to nothing: it fires per step, not per turn) |
| Droid, Copilot, Aider | **no mapping at all** — identity only, via banner sniffing |

`has_event_mapping` is false for that last row and `events_for` returns an empty slice, so
those CLIs are first-class `AgentKind`s and valid spawn targets but never carry a status.
An installer whose provider has no taxonomy row errors out rather than delivering events
nothing can read.

### The correlation events

The correlation events — installed so the daemon has *evidence*, never unconditional
transitions — are Claude's `SubagentStart`/`SubagentStop` and matched
`PreToolUse`/`PostToolUse`/`PostToolUseFailure`; Codex's
`SubagentStart`/`SubagentStop`/`SessionEnd` and matched `PreToolUse`/`PostToolUse`; Grok's and Cursor's
`subagentStart`/`subagentStop`; Cursor's `afterAgentResponse` (last-message
only); Antigravity's `PostToolUse` (correlation evidence that conditionally clears a
block); and the OpenCode plugin's synthesized
`SubagentStop`, a name Houston invented so a task-tool child session's own idle
is told apart from the pane's. `events_for` returns nothing for them, so they
cannot drive a status by accident; the one near-miss is Claude's `StopFailure`,
which maps to `TurnEnded` but emits error attention rather than successful completion.
Antigravity's `PostInvocation` maps to nothing at all: it fires per step,
not per turn.

## What a hook's payload decides, beyond the event name

Several things a pane's status and a delegation's progress depend on are not
readable from an event name alone, so `apply_hook_drop` reads them off the
payload before any status is decided (`daemon.rs`'s `correlate_hook_drop`).
The helper lifts every field the CLIs actually publish into `HookDrop`
(`hook_drop.rs`), each `#[serde(default)]` so an older drop file still parses
and a payload missing a field still delivers its transition:

| Field | Carries | Decides |
|---|---|---|
| `last_message` | Claude/Codex `Stop.last_assistant_message`, Cursor `afterAgentResponse.text`, OpenCode's plugin read of `client.session.messages`, Antigravity's read of its own `transcriptPath` | the `no_handback` body's first preference; capped at `SUBMIT_BODY_MAX_CHARS` |
| `background_tasks` | Claude `Stop.background_tasks.len()` | non-zero means the pane is parked on its own children, not finished |
| `pending_task_ids` / `task_id` | Claude: ids of running `background_tasks` entries of type `subagent`; the `<task-id>` an internal prompt names | the sub-agent round's owed set and its settlement |
| `internal_prompt` | a `UserPromptSubmit` whose prompt the CLI wrote itself (a `<task-notification>`) | NOT a new request: it must not rename the pane, rearm a no-handback round, or count as the parent prompting |
| `reason` | `PermissionRequest.tool_name`, a `Notification`'s `message`, OpenCode's `permission`/`patterns`, Antigravity's question text | the `NeedsInput` row's body |
| `notification_type` | Claude `Notification.notification_type` | only `permission_prompt`, `elicitation_*`, `agent_needs_input` are a block; `idle_prompt` and the rest produce nothing |
| `stop_hook_active` | `Stop.stop_hook_active` | logged, not relied on (the block cap counts on its own) |
| `prompt_id` / `tool_use_id` | the prompt and tool invocation a hook belongs to | correlation for interactive tools; the invocation id is preferred where the payload has one |
| `request_id` | OpenCode's permission or question request | pairs an asked event with its reply or rejection, including concurrent requests from child sessions |
| `agent_id` | the sub-agent a `SubagentStart`/`SubagentStop` is about | correlation evidence, never a status |
| `stop_continued` | the helper blocked this `Stop` with inbox rows | the daemon treats the pane as Working, never as TurnEnded |
| `session_id` | Antigravity's `conversationId` | the root pin that tells a sub-agent's events apart from the pane's |
| `fully_idle` | Antigravity `Stop.fullyIdle` | `false` means parked on `invoke_subagent` and decides nothing; `true` closes the round |
| `tool_name` | Claude/Codex's top-level field or Antigravity's `toolCall.name` | identifies interactive tools and matches their completion to the open episode |

The field spelling is per provider: Grok gets a snake_case-then-camelCase fallback for
every field that has one; Cursor gets a `text` fallback for `last_message`; Antigravity's
`conversationId` lifts into `session_id`. What is NOT lifted is trusted: `Stop` running
synchronously (below) is what lets a payload field decide whether a turn really ended.

**The sub-agent round.** An agent that launches a background sub-agent *ends
its turn* while it waits: the CLI fires `Stop` with a last message about
waiting, and wakes the agent later with a `UserPromptSubmit` whose prompt is
its own `<task-notification>`. One request, two turn ends. Read literally, the
first one hands a delegated child's parent a result the child is still working
on. So Houston installs `SubagentStart` and `SubagentStop` — as evidence, never
as a status — and keeps a `SubagentRound` per pane
(`orchestrate.rs`): a start puts the sub-agent in flight, a stop whose own
`background_tasks` still lists it as running turns that into a notification the
CLI owes, and a turn end while either set is non-empty decides nothing. The
`<task-notification>` prompt settles the debt, does not rename the pane, and
does not count as a new request. A turn end against two empty sets is trusted
— nothing published a barrier — and evidence arriving after it reopens the
round. The sets are in memory: a restart loses them and the expiry rule
(`OWED_NOTIFICATION_MAX_MS`, `SUBAGENT_INFLIGHT_MAX_MS`) releases the withheld
turn end instead.

**Typed notifications.** `Notification` fires both for the agent asking
permission mid-turn and for the CLI reminding an idle operator it is waiting.
Only `permission_prompt`, `agent_needs_input` and the `elicitation_*` types are
a block; `idle_prompt` and the rest move nothing. A drop from a helper that
lifted no type keeps the old ambiguous-idle suppression. Explicit permission events and
typed blocking notifications are authoritative even if the prompt-start event was lost.
A block is one **episode**, keyed by the CLI's `tool_use_id` where it
has one, by OpenCode's `request_id`, and by `(prompt_id, tool_name, generation)`
otherwise, so independently keyed requests remain blocked until all of them resolve and
the same unkeyed tool asked twice is still two questions; a `Notification` attaches to the newest open
episode rather than opening one of its own or sending a duplicate notice. A matching
successful or failed tool result clears the episode and resumes `Working` only after the
last open episode closes.

## Hook installation

Claude Code installs **per workspace**, into `<workspace>/.claude/settings.local.json`
(`claude_hooks.rs`). The other five providers write **per-user global** configs
(`agent_hooks.rs`):

| Provider | Config |
|---|---|
| Codex | `~/.codex/hooks.json`, plus `~/.codex/config.toml` (parks a leftover `notify` line from before this file existed; never rewritten otherwise) |
| Cursor | `~/.cursor/hooks.json` |
| OpenCode | `<config dir>/opencode/plugins/houston-notify.js` |
| Grok | `~/.grok/hooks/houston.json` |
| Antigravity | `~/.gemini/config/hooks.json` |

Every install is reversible through a managed-marker scheme: a trailing sentinel token
`--houston-managed[=<channel>]` inside the command string, matched **per whitespace
token, never as a substring** — `release`'s sentinel is a prefix of `dev`'s, and substring
matching would let one channel evict the other's group. Ownership facts (did Houston create the
file, did Houston create the top-level `hooks` object) are recorded in the `workspace_hooks`
table so uninstall removes exactly Houston's residue and nothing else.

The registered command never names the binary. It names a channel-stable launcher at
`<state dir>/bin/claude-hook`, which the daemon repoints at its own current binary on every
boot — an app upgrade moves the real binary, and workspace hook entries are not rewritten
per launch. `hook_command()` builds
`if [ -x '<launcher>' ]; then exec '<launcher>' hook <event> <sentinel>; fi`; the other
providers get the same shape with `--agent <provider>` added and the same guard — except
Codex's Windows arm, which builds its own argv directly and has no shell to guard through.

One managed group per channel also means one event runs both channels' helpers, and each
helper resolves its drop root from the pane's own `HOUSTON_CHANNEL`, not from where it was
installed — so both would drop into the one daemon that owns the pane and every hook would
arrive twice (a `UserPromptSubmit` that opens a request nobody made, a `Stop` that ends a
turn twice). The helper therefore reads `argv[0]`, the launcher path the hooks file named,
and when that launcher sits under another channel's state dir it exits 0 in silence: the
pane's own channel's launcher in the same file covers the event. A helper run without a
launcher (a test, a shell) is never stood down.

The guard is there because a workspace carries one managed group **per channel**, and a
channel's group outlives that channel's binary: the dev launcher points into the repo's
`target/debug`, which every `cargo build` unlinks and re-creates, and a frozen install can
be removed outright. In that window the launcher is a dangling symlink, the shell answers
`not found`, and Claude shows `UserPromptSubmit hook error` in every pane — including the
panes of the other, perfectly healthy channel. Nothing is owed in that window (the hook
client is a pure file writer; an event nobody is running to receive has nowhere to go), so
exiting 0 in silence is the honest answer. It is written for POSIX `sh` on both platforms,
which the single-quoted, forward-slashed command spelling already assumed. Note also that
`;` is a token separator in `claude_hooks::tokens`, or the trailing `; fi` would ride into
the sentinel and no channel would recognise its own group.

`tr_hook_group()` wraps the command as `{"type":"command","command":…,"async":…,"timeout":5}`
— `async` is false for `UserPromptSubmit`, `Stop` and `StopFailure`, true for everything
else, so the CLI does not block on a drop-file write for events that return no control output.
`Stop`/`StopFailure` run synchronously because the orchestration inbox's door 2 needs the
CLI to wait for the helper's stdout and splice it into the same turn — an async hook prints
into a pipe nobody reads. Codex's `hooks.json` and Antigravity's hooks file write no `async`
key at all, which both CLIs treat as synchronous by default, so they need no matching change.
`install()` is idempotent, refreshing Houston's own entry per event.

Codex's `hooks.json` is the same per-event array shape Cursor and Grok's files use, so
both channels' entries coexist there the same way. `config.toml`'s old `notify` key
cannot multiplex, but Houston no longer writes one: install parks an active `notify` line
(or, if it carries Houston's own sentinel from before `hooks.json` existed, removes it
outright) and uninstall wakes a parked one again.

Trust is Codex's own, not Houston's to grant: an unreviewed hook in `hooks.json` is
silently skipped until the operator trusts it in Codex's own review screen, and Houston
never passes `--dangerously-bypass-hook-trust` to get around that — a spawn into a repo
carrying its own `.codex/hooks.json` would run that hook untrusted too. `agent_hooks::codex_trust_status`
reads `~/.codex/config.toml`'s `[hooks.state]` table read-only to say whether the review
screen has ever been used; a Codex pane with no status yet and Houston's hooks installed
reads as "Codex hooks installed, not confirmed for this pane" rather than a bare
`Spawning`, since a missing `SessionStart` drop looks the same whether trust is pending,
the helper is slow, or the file is broken.

OpenCode has no shell-hook contract — its plugin bus fires JS callbacks, not a
shell command with its own stdin — so `houston-notify.js` is the hook contract: it builds
the JSON `claude_hooks::parse_hook_payload` expects itself and pipes it into the same
`if [ -x … ]; then exec …; fi` command every other provider gets, through
`printf '%s' <json> | sh -c <cmd>` rather than the plugin's own inherited stdin (the TUI's
real keyboard). A `sessionID → parentID` map, seeded from `session.created` and falling
back to `client.session.get` for an id never seen created, tells a task-tool child session
apart from the root: a child's own creation only updates the map, and a child's
`session.idle` forwards under Houston's own `SubagentStop` name (installed alongside the
status table, never read as one — the same split Codex's `SubagentStart`/`SubagentStop`
get) instead of `session.idle`'s own command. The root's idle reads
`client.session.messages` and carries the text as `last_assistant_message`, so the
generic lift needs no OpenCode-specific code. `session.status` is authoritative for
`busy`/`retry`; an idle status is normalized to the same terminal event as legacy
`session.idle`, and duplicate delivery is harmless. `session.error` is root-only and
produces error attention. Permission and structured-question events are forwarded in
whichever session they fire: a question inside a child still blocks the pane because the
human must answer it before the pane can proceed. Provider request ids keep simultaneous
child requests independent; reply/reject events resume the same turn only after the last
pending request closes, without manufacturing a new prompt. A later `busy` pulse cannot
hide an open request.

Grok's `~/.grok/hooks/houston.json` installs the four lifecycle hooks plus
`SubagentStart`/`SubagentStop`, correlation-only like Codex's pair. These follow the
documented contract (`docs.x.ai/build/features/hooks`); live verification remains pending.
`PermissionRequest` is not installed: the same docs page
lists `PermissionDenied` instead, the moment a permission has already been resolved, not
the "blocked asking" moment `NeedsInput` means. Grok's own field casing is unconfirmed —
the documented camelCase fields differ from the Claude-compatible snake_case schema, so
`claude_hooks::parse_hook_payload` tries snake_case first, then Grok's camelCase twin,
for every field that has one; every other provider keeps its one spelling. Grok also
reads a workspace's own
`.claude/settings.json` hooks, so a Grok pane fires the same moment twice — once through
Grok's own `--agent grok` path, once through the plain Claude path with no `--agent` at
all. `run_hook_client` exits without writing a drop when `--agent` is absent and
`GROK_SESSION_ID` is set (a real env var Grok injects into every hook process), so the
Grok-side drop is the only one that lands.

Cursor's `~/.cursor/hooks.json` installs `subagentStart`/`subagentStop` beside its
three lifecycle hooks, correlation-only (`cursor.com/docs/hooks`; live verification
remains pending), and `afterAgentResponse`, which is
different in kind: it is the ONLY place Cursor's own last-said text lives (`{"text":
"..."}`), since `stop` itself carries no such field, so it is installed and its payload
lifted into `last_message` — but it is still never a status, since it fires after every
assistant message, not only the turn's last one. `claude_hooks::parse_hook_payload`
carries a Cursor-only fallback to `"text"` for exactly this reason, the same shape as
Grok's own camelCase fallback one section up.

Antigravity's `~/.gemini/config/hooks.json` installs `SessionStart` and
`PreToolUse`/`PostToolUse`, live-verified to fire **only
in the matcher-wrapped dialect** (`{"matcher": ".*", "hooks": [...]}`) — the plain entry
every other event uses is silently ignored for these two, so `agent_hooks::antigravity_install`
picks the dialect per event. Every payload carries `conversationId`; `invoke_subagent`
starts a second agent process that fires the same hook names under a different id, so
`Daemon::correlate_antigravity_drop` pins a pane's root from its first `SessionStart` and
drops any later event naming another id as correlation, never a status. A root `Stop`
carrying `fullyIdle: false` means the pane is parked on `invoke_subagent` and decides
nothing; `fullyIdle: true` closes the turn. `PreToolUse` maps generically to `NeedsInput`
(so `provider_capabilities` derives `block: true`), gated the same way Claude's own
`Notification` is gated on `notification_type`: only `toolCall.name` of `ask_question`,
`ask_permission` or `ask_custom_permission` opens a block, keyed by `stepIdx` (the closest
thing this payload has to a `tool_use_id`) and reasoned by
`toolCall.args.questions[].question`; the matching `PostToolUse` resolves it
(`orchestrate::EpisodeEnd::PostToolUse`) and resumes `Working` after the final open
permission episode. No hook payload carries a
last-assistant-text field at all: `claude_hooks::run_hook` reads it, at `Stop` only, out of
the CLI's own transcript JSONL at `transcriptPath`. Its line schema remains unverified;
the reader tolerates either `role`/`type` and either
`content`/`text` and yields nothing rather than a guess on any mismatch.

## The drop file

A hook does not open a socket or make an HTTP request. The helper writes one JSON file and
exits — no port, no token, no daemon required at write time (`hook_drop.rs`).

- **Root**: `<state dir>/hooks/drop/` — one root for every pane. The writer does not use
  `TR_SWARM_SCOPE` to select a drop directory.
- **Filename**: `{ms:013}-{seq:06}-s{session}.json`, so ordering is in the name.
- **Claim**: `std::fs::hard_link`, which makes the claim atomic between readers.
- **Writer**: `run_hook_client()` reads the payload from stdin, resolves `TR_SESSION`, and
  returns silently when it is unset — no session, no drop.
- **Reader**: `hook_drop_tick()` runs a pass over every drop dir (the base state dir plus
  every live scope) and calls `apply_hook_drop()` per file, landing on
  `apply_agent_event()`.

The tick is the first thing `swarm_mail_tick` does each round, so hook delivery rides the
same adaptive ladder as mail. A hook drop is also a second source for pane *identity*:
a hook fired by provider X inside pane `id` is proof X runs there, and hook envelopes are
stabler than banners.

`hook_state.rs` is not an installer. It is the offline scope registry — the file a hook
helper reads when there is no live daemon to ask. It is derived wholesale from SQLite under
one lock, rebuilt on every mutation, written tmp+rename, and read fail-soft to empty. It
resolves a hook's scope from `cwd` when the scope env var is absent or stale, and lets the
daemon route a drop file written after the pane that wrote it is gone.

## The other lawful sources

**Spawn grace.** Every visible pane with a mapped hook provider or ACP stream is set
`Spawning` at spawn. `SPAWN_GRACE` is 20 s: if no lifecycle event has changed the status
by then the pane becomes `Unavailable`, never falsely `Idle`. A later valid event restores
the reported state normally.

**Interrupt coverage.** Codex's `Interrupt` settles a cancelled turn without emitting a
completion notice. Providers that publish no interruption event can still leave `Working`
after Ctrl-C; Houston does not paper over missing lifecycle evidence with a timer.

**ACP.** `acp.rs` decodes line-delimited JSON-RPC over stdio — a documented spec, the same
category as a hook event, not a reading of terminal content — and sends its events through
the same status, delegation, routine and notice path as hooks. It deliberately does **not**
answer `session/request_permission`: that surfaces as `NeedsInput` for the human.

**OS liveness.** `has_child_procs` scans `/proc/{pid}/task/*/children` across all threads —
pure procfs, no `pgrep`, no `ps`. A sibling `has_running_procs` walks the whole descendant
tree, capped at `MAX_DESCENDANTS_SCANNED` = 4096, to catch grandchildren and exclude
zombies (a zombie reads as "has a process" to the cheaper call). It is **never polled on a
timer** — two on-demand call sites only: `session_running_procs`, which backs the pane-close
confirmation, and `session_reap_candidates`, the husk reaper. It does not set
`AgentStatus`; it gates the reaper's kill-or-keep decision and the close prompt.

The reaper fires only when all of: the session is live, quiet for at least the configured
`idle_ms`, has no child processes, is not
`Working`/`NeedsInput`/`Spawning`/`Unavailable`, and is hidden
in every connected renderer.

## Roster status and the one-shot promotion

`SwarmAgentStatus` is a separate, roster-level status for a mailbox-scoped agent. It is
driven from raw hook event *names* (`UserPromptSubmit` → `Running`, `Stop` → `Idle`) and
from exit code at teardown (killed or 0 → `Done`, anything else → `Error`).

`Daemon::extract_activity` is the one named content→display path: it takes the last
8 KiB of a chunk, strips ANSI, scans the last 40 lines in reverse for the first
non-trivial, non-prompt-glyph, non-inbox-framing line, and truncates it to 90 characters.
The caller `Daemon::swarm_activity_tick` rate-limits it to once per second per agent.

Its single status effect: **only** if the agent's `SwarmAgentStatus` is currently
`Spawning` does it promote to `Running`. Every later call finds a different status and
passes through, so the effect is one-shot by construction. Re-arming it — polling it,
running it per frame — would make it a status machine again.

## What is not a status source

Each of these feeds a display, a record or a decision — never `AgentStatus`.

| Not a source | What it actually feeds |
|---|---|
| Banner sniffing (`agents.rs`) | pane identity (`AgentDetected`), and its own doc says so |
| OSC 133 markers (`markers.rs`) | command blocks and handoff context |
| Command blocks (`blocks.rs`) | the history ledger; memory-only, never broadcast |
| Activity text (`extract_activity`) | the roster chip, plus one one-shot promotion |
| `has_child_procs` | the reaper gate and the close confirmation |
