# Orchestration

> For maintainers. Start at [overview.md](overview.md) for the process model.

An agent in a Houston pane can open more panes, read them, prompt them, wait on them and kill
them. It does that over MCP, against the daemon that owns its own PTY, with a credential
minted for its pane alone. Every signal one pane owes another is one row in `pane_inbox`, the
single table the three delivery doors read — see "The inbox" below.

Every child runs directly in its own project directory, with its CLI's own bypass/auto flag —
there is no per-session worktree, merge gate or sandbox isolating it (`spawn_session` opens
the PTY in the session's `project_dir` itself, the same path an operator-opened pane gets).
Houston does not commit changes on an agent's behalf.

## The MCP endpoint

Transport is **MCP over streamable HTTP** on the daemon's existing loopback listener:
`POST /mcp` for requests, `GET /mcp` for the SSE listen stream (`mcp_server.rs`). The
JSON-RPC 2.0 layer is hand-rolled and covers `initialize`, `ping`, `tools/list`,
`tools/call` and `notifications/*` no-ops.

stdio was rejected: a stdio MCP server is spawned *by the agent CLI*, which would put
browser state behind a process boundary from the daemon that owns it. `/ws` was rejected
for the same class of reason in the other direction — its framing is PTY-shaped, and a
request/response query does not fit it.

Live state never lives in `initialize`'s `instructions` field: it is delivered once at
connect and no notification can ever change it after (`mcp_server.rs`'s module doc states
this as the reason `ToolProvider::instructions` exists at all). Anything that can change
while a pane is running — caps, slots, capability notes — goes in a tool's own
`description`, which is re-read on every `tools/list` and can carry `tools/list_changed`.

One outbound push exists: `notifications/tools/list_changed` over the SSE stream, because
the orchestration switch can change while a pane is already running and the tool list has to
change under it.

The daemon implements `McpHost` for itself (`server.rs`), wiring credential resolution, the
tool registry, per-session agent kind, the progress tick and the notifier registry.

## Tools

Every verb below has two doors: the `pane_*` MCP tools and the `hs-pane` CLI. Same daemon
methods, same refusals; the CLI column names each tool's twin (`—` when the tool has no CLI
spelling, or a verb that is CLI-only).

| Tool | Registered in | `hs-pane` twin | What it does |
|---|---|---|---|
| `workspace_info` | `mcp_server.rs` | `hs-pane whoami` | the caller's workspace and session id plus registered target workspaces, shared with `whoami` (`Daemon::orchestrate_whoami_json`) |
| `pane_spawn` | `mcp_orchestration.rs` | `hs-pane spawn` | open a child agent pane; `kind: custom` is refused by name (no hooks, so its parent could never be told when it finished) |
| `pane_list` | `mcp_orchestration.rs` | `hs-pane list` | list the caller's live children, each with its full delegation record (state, stall, `pending_handback`, `inbox_owed`, the capability note) |
| `pane_get` | `mcp_orchestration.rs` | `hs-pane get` | one pane in the caller's own subtree, in one call: its state, its children and depth, what would end its turn, and its role/brief/stall/staged-result if it is a child of the caller |
| `pane_read` | `mcp_orchestration.rs` | `hs-pane read` | a child's terminal, ANSI-stripped, capped: `source=screen` (default) reads the session's emulator (`vt.rs`), `source=tail` splits the byte ring on newlines. Anything else is refused by name |
| `pane_prompt` | `mcp_orchestration.rs` | `hs-pane prompt` | send follow-up text into a child, queued on the child's own wake lane |
| `pane_wait` | `mcp_orchestration.rs` | `hs-pane wait` | door 1: block on the caller's own `pane_inbox` until an eligible row exists (or the timeout runs out), reserve it, mark it `delivered_via = 'wait'`, and return the rows in this same call. `session` (optional) scopes to one child; `kind` (optional) filters to one row kind but never hides an urgent one for a waited child. `until` is removed and refused by name, naming `kind` as its replacement |
| `pane_kill` | `mcp_orchestration.rs` | `hs-pane kill` | end a child pane |
| `pane_submit` | `mcp_orchestration.rs` | `hs-pane submit` | worker→parent result handoff, with an optional summary and artifact paths; wakes the parent |
| — | — | `hs-pane keys` | press a small set of keys in a pane (the CLI-only spelling of `pane_send_keys`) |
| `pane_send_keys` | `mcp_orchestration.rs` | — | press a small set of keys in a pane (see the tool's own description for the list) |
| `browser_current_page` | `src-tauri/src/browser/mcp_tools.rs` | — | URL, title, favicon, loading state |
| `browser_capture` | `mcp_tools.rs` | — | PNG screenshot of the browser pane |
| `browser_navigate` | `mcp_tools.rs` | — | load an http(s) URL |
| `browser_snapshot` | `mcp_tools.rs` | — | accessibility-style snapshot with `ref`s |
| `browser_click`, `_type`, `_hover`, `_press_key`, `_select_option` | `mcp_tools.rs` | — | act on an element by `ref` |
| `browser_go_back`, `_go_forward` | `mcp_tools.rs` | — | history navigation |
| `browser_wait_for` | `mcp_tools.rs` | — | poll until text is visible, or time out |

The browser tools live in the Tauri crate rather than `core/` because they need the
in-process `BrowserRegistry`; the Tauri shell registers them into the daemon's tool registry
during setup. This is the one place `core/` gains a capability it cannot see itself.
`browser_click` and `browser_type` pass a human confirmation gate before acting.

`pane_spawn` takes `kind` (`claude | codex | antigravity | opencode | cursor | grok`), `prompt`,
and optional `model`, `cwd`, `target_workspace`, `reusable`, `effort`, `auto_approve`,
`profile`, `role`, `output_format`, `boundaries`. `target_workspace` must match a registered
workspace after canonicalization, and `cwd` must remain under that root. `reusable` defaults
to false for new API spawns; legacy delegation rows migrate as reusable to preserve their
prior behavior. `effort` is provider-validated at the launch boundary.
`pane_submit` takes `body` and optional `summary`, `artifacts`, `request_id`.

`orchestrate.rs` is the pure layer under all of it — no DB, no PTY: scope and cap
verdicts, wait and stall decisions, inbox composition and the sub-agent and permission
rounds, plus the `hs-pane` CLI. The lifecycle methods themselves live on `Daemon`.

## Caps and refusals

| Cap | Value | Reason |
|---|---|---|
| `MAX_LIVE_CHILDREN` | 4 | covers real delegation without letting a runaway loop fill the grid; cost compounds per generation |
| `MAX_SPAWN_DEPTH` | 1 | nesting is opt-in, not the default — cost compounds per generation and deeper is almost always a spawn loop; a stored value always wins, so an operator who already chose a deeper cap is unaffected |
| `READ_LINES_DEFAULT` / `_MAX` | 40 / 500 | lines per `pane_read`, either source |
| `DEFAULT_WAIT_TIMEOUT_MS` | 600 000 | long enough for any real turn, short enough that a lost wake-up surfaces as a named timeout |
| `PROMPT_STALL_MS` | 5 000 | a prompt that has not moved |
| `HANDOFF_BATCH_MS` | 2 000 | batches simultaneous child submits into one parent interruption |
| `SUBMIT_BODY_MAX_CHARS` | 8 000 | one handback is a condensed summary; the parent pays for every character of it, once per child in the batch |
| `BRIEF_FIELD_MAX_CHARS` | 2 000 | `output_format` / `boundaries` qualify the task in a line or two; the task itself is `prompt`, which has no cap |
| `SUBMIT_SUMMARY_MAX_CHARS` | 200 | a subject line for the batched inbox |
| `SUBMIT_ARTIFACTS_MAX` / `ARTIFACT_PATH_MAX_CHARS` | 8 / 512 | a report plus its evidence; eight paths cannot outweigh the result they annotate |
| `SWARM_WAKE_LANE_MAX` | 16 | queued nudges per pane; a pane that has not read sixteen will not read the seventeenth |

Both spawn caps are wire-settable up to `proto::ORCHESTRATION_CAP_MAX` and stored under the
settings keys `orchestration_max_live_children` and `orchestration_max_spawn_depth`.

Refusals are named verdicts, each stating the limit it hit: `children_cap_verdict`,
`depth_cap_verdict`, `auto_mode_model_verdict` (a model the CLI cannot run auto mode on is
refused rather than demoted to a pane that blocks on approvals nobody is there to answer).

The inbox has its own limits, all in `orchestrate.rs` beside the doors that spend them:
`INBOX_BATCH_MAX_ROWS` (20) and `INBOX_BATCH_MAX_BYTES` (64 000) cap one reservation,
`INBOX_RESERVATION_MS` (30 000) expires a door that died mid-delivery, `PASTE_ATTEMPTS_MAX`
(3) and `PASTE_CONFIRM_MS` (60 000) bound door 3's proof, `OPERATOR_TYPING_GUARD_MS` (3 000)
debounces the composer hold, `STOP_INBOX_QUERY_MS` (250) is door 2's whole budget,
`STOP_BLOCKS_PER_TURN_MAX` (3) caps its blocks, `INBOX_PENDING_PER_PANE_MAX` (200) and
`INBOX_OPERATOR_MAX_ROWS` (1 000) bound the queues, and `SUBAGENT_INFLIGHT_MAX_MS`
(45 min) / `OWED_NOTIFICATION_MAX_MS` (2 min) expire the sub-agent round's withheld turn
end. Each is explained where it does its work below.

## The switch

Orchestration is off until the operator turns it on, once for the whole app, in
Settings → Orchestration. It is daemon state (`orchestrate::ENABLED_KEY`), so `hs-pane`,
the MCP door and every window read the same value. Toggling it emits `tools/list_changed`
on every live SSE stream, so a pane already running sees the tool list change without a
restart, and turning it on seeds the `hs-pane` skill stub.

## Credentials

A per-pane bearer token is minted at spawn and bound to an
`McpScope { workspace_id, session_id }` (`mcp_creds.rs`).
A child may be spawned in a different registered workspace, but its credential remains
scoped to that target. The parent's control authority is the persisted `delegations`
ancestry, not workspace equality; an arbitrary filesystem path never grants authority.

- Only the **SHA-256 hash** is stored. The raw token exists exactly twice: in argv (or an
  env var) and in the CLI's own memory.
- Lookup is by hash and deliberately not constant-time, with the reasoning recorded at the
  call site.
- Re-issuing a scope's token **revokes** the previous one.
- There is no "resolve by session id" API. A token names its own session and workspace;
  a parent controls a registered cross-workspace descendant only through its own token
  and the persisted delegation ancestry.

This is a different secret from `daemon.token`, which authenticates the renderer over `/ws`
and is one secret for the whole app.

Handing the credential to each CLI (`mcp_launch.rs`):

| CLI | Mechanism |
|---|---|
| Claude Code | `--mcp-config` with inline JSON, ADDED to the user's own servers. No `--strict-mcp-config`: it would make the argv config the only source and suppress the user's `mcpServers`, their project's `.mcp.json`, their plugins and their connectors. The argv entry wins the `houston` name against `mcp_register`'s user-scope placeholder |
| Codex | repeated `-c key=value`, with the token read from `HOUSTON_MCP_TOKEN` so it stays out of argv |
| OpenCode | `OPENCODE_CONFIG_CONTENT` (its own config-content env var) with a `remote` `mcp` entry; not live-verified, built from `https://opencode.ai/config.json` |

Env constants: `HOUSTON_MCP_TOKEN`, `HOUSTON_MCP_URL`, `HOUSTON_MCP_CONFIG`.

Separately, `mcp_register.rs` keeps a persistent user-scope `houston` entry in
`~/.claude.json` whose `url` and `Authorization` are the literal placeholders
`${HOUSTON_MCP_URL}` and `${HOUSTON_MCP_TOKEN}`, expanded by the CLI from the
pane's own environment — so a hand-typed, flagless `claude` inside a pane still connects.
That entry is written by spawning `claude mcp add`, never by touching the file; the read
side is the `mcpServers` key only, once per boot, fail-soft, and it never overwrites an
existing entry even a stale one. Codex gets the same user-scope entry through
`codex mcp add`, holding the literal endpoint (Codex expands no placeholders) and the
token's env-var name, refreshed each release-channel boot because the port is ephemeral.
Grok has no per-spawn `mcp_launch.rs` mechanism at all, only this persistent one:
`mcp_register_grok.rs` runs `grok mcp add --transport http houston ${HOUSTON_MCP_URL}
--header "Authorization: Bearer ${HOUSTON_MCP_TOKEN}"`, verified against
`docs.x.ai/build/features/mcp-servers`; live authentication remains unverified.
Grok's own `config.toml` expands `${VAR}` in both `url` and `headers` (unlike
Codex's, which never expands `url`), so this entry holds Claude-style placeholders and,
like Claude's, is never refreshed once written — there is no literal port to go stale.
Cursor has no `mcp add` subcommand at all (verified against `cursor.com/docs/cli/mcp`:
only `list`/`list-tools`/`login`/`enable`/`disable` exist), so `mcp_register_cursor.rs`
edits `~/.cursor/mcp.json`'s `mcpServers` object directly — the same file and key
`mcp.rs`'s own third-party-server sync already uses for an unrelated feature, under a
different server name. Being the writer here rather than a CLI's own command means the
entry carries a sibling `_houston` marker key (`mcp.json` is strict JSON, no comments to
carry one in), so a same-named entry someone else configured is never mistaken for
Houston's own. Cursor expands `${env:VAR}` in both `url` and `headers`
(`cursor.com/docs/context/mcp`), so this entry too holds placeholders and is never
refreshed. Live authentication remains unverified.
Antigravity has no `mcp add` subcommand documented either, so
`mcp_register_antigravity.rs` writes `~/.gemini/config/mcp_config.json`'s `mcpServers`
object directly, using the same marker scheme as Cursor. The provider's MCP documentation
names this home-level file in the same `~/.gemini/config/` directory
`agent_hooks::config_path` already uses for this provider's `hooks.json`. The same doc
states a remote entry's field is `serverUrl`, not `url`/`httpUrl` ("legacy fields ... are
not supported"), so this entry holds `serverUrl` with the bare `${VAR}` placeholders
`mcp_register.rs`'s and Grok's own entries use. Placeholder expansion remains unverified.
`google-antigravity/antigravity-cli` issue #25 reports the
`headers.Authorization` bearer is accepted by the schema but silently ignored by the
CLI's own HTTP MCP transport at runtime. Live authentication remains unverified.

## `hs-pane`

`hs-pane` is not a separate binary. It is the daemon binary invoked under an argv alias,
reached through a `#!/bin/sh … exec <daemon-binary> <subcmd> "$@"` wrapper the daemon writes
at spawn time. It lands at `.houston/orchestration/bin/hs-pane`, in the helper `bin` dir the spawn
path prepends to `PATH`. The daemon binary answers a legacy `hs-mail` invocation with a refusal naming its replacement
(`pane_submit`, or `hs-pane` for the CLI-only providers) and exits non-zero.

Subcommands: `whoami`, `spawn`, `list`, `get`, `prompt`, `keys`, `wait`, `read`, `kill`,
`submit` — the `/orchestrate/*` routes are the same verbs as plain HTTP for exactly this
client. Every MCP `pane_*` tool has a CLI twin here (the verb table above names both doors),
and the two sides share one implementation per verb, so a refusal and an argument set cannot
differ between them. `submit --artifacts` is comma-separated because `parse_flags` keeps one
value per flag name, so a repeated flag would silently keep only the last.

Three preconditions, all refusals rather than fallbacks: `HOUSTON_MCP_URL` and
`HOUSTON_MCP_TOKEN` must be set, the URL must name the local loopback, and
`HOUSTON_SESSION` must be set — `hs-pane` outside a pane has no scope to act in.

## The inbox: one table, three doors

Everything one pane owes another is one row in `pane_inbox`. Producers write rows; the
doors read them. `delegations` keeps its lifecycle columns and its `round` counter and has
no staging slot — a `pane_submit` while the child works is a row that is simply not yet
eligible.

### What a row is

`to_session` is the pane owed the row (`0` is the operator); `from_session` is the pane
(or the daemon, for a notice) that produced it; `workspace` is the workspace identity every
other table already keys on; `request_id` is the `delegations.round` the row answers.
`from_codename` and `from_role` are bounded snapshots of the sender identity, so a renderer
can keep naming a result after temporary cleanup removes the live session.
`kind` is one of `InboxKind`: `result` (a `pane_submit` body), `no_handback` (a turn ended
with nothing submitted), `needs_input` (urgent), `exited` (urgent, the child's process is
gone), `stalled`, `operator_note` (the operator ended or interrupted the child), and `mail`
(a swarm-scope message addressed to a pane's label). `needs_input` and `exited` are the
urgent kinds,
and they bypass every batch window.

Three timestamps, three words: `created_at` is **persisted**, `delivered_at` is **sent**,
`confirmed_at` is **proven**. What "sent" is worth depends on the door:

| door | sent means | proof exists? | retention counts from |
|---|---|---|---|
| `wait` | returned inside the tool result of a live turn | no mechanism; final | `delivered_at` |
| `stop_hook` | the helper printed it and the CLI accepted the hook's stdout | no mechanism; final | `delivered_at` |
| `paste` | bytes reached the PTY | yes, the parent's own prompt hook | `confirmed_at` |
| `operator` | opened in the renderer | yes, the ack | `confirmed_at` |

`confirmed_at IS NULL` is therefore never read as "failed" on its own; the door says.
Delivery is never claimed exactly-once. A message's identity is `pane_inbox.id`, stable across
attempts and printed with every delivered entry; `delivery_id` names one attempt and
changes on every reservation. `attempts` counts delivery attempts by any door — every
reservation, not only door-3 pastes — which is what lets door 2's "possibly delivered
before" note and door 3's re-address threshold share one counter. A duplicate after a retry
is recognisably the same message under a second delivery id, and a stale confirmation from
an earlier attempt cannot mark a later body. A reservation a door fails to complete expires
after `INBOX_RESERVATION_MS` and the row is eligible again; on boot every reservation is
released.

Every `summary`, `body`, `reason` and the hook helper's `last_message` pass
`orchestrate::inbox_row_new` first, which caps them at the same limits `pane_submit`
enforces and runs `sanitize::redact_secrets` over every field an agent or a hook wrote.
`artifacts` are validated as absolute paths inside the workspace the row claims to be
from — a leaf child cannot point a parent at a file outside its own sandbox.
`sanitize_handoff_text` handles ANSI and framing only; it is not redaction.

### The doors, ordered by the parent's state

A row reaches its addressee through the first door that can act, in this order:

```
row eligible ──► inside pane_wait? ──yes──► door 1: returned in this call
                        │ no
                        ▼
                parent Working?        ──yes──► door 2: carried by its next Stop hook
                        │ no
                        ▼
                parent Idle, no operator keystroke in the
                OPERATOR_TYPING_GUARD_MS window?  ──yes──► door 3: batch window, then one paste
                        │ no (blocked, or the operator is typing)
                        ▼
                hold: visible to the operator now, delivered when the state changes
```

A door claims rows with one `UPDATE ... SET reserved_at, delivery_id WHERE <eligible>
RETURNING`, then does its I/O (tool reply, hook stdout, PTY write) with no transaction
open, then marks `delivered_at` conditioned on its own `delivery_id`. Three doors racing
pick disjoint rows. The eligibility query is the same everywhere: `ready_at <= now AND
delivered_at IS NULL AND resolved_at IS NULL AND (reserved_at IS NULL OR reserved_at <
now - INBOX_RESERVATION_MS)`. `ready_at` is the one extra state: a `Result` written while
the child is still working has `ready_at = NULL`, and the delegation lifecycle sets it in
the same transaction that closes the round — so "stored" and "eligible" are two states the
schema can tell apart, and a crash between them cannot produce one without the other.

### Door 1: `pane_wait`

A parent already sitting inside a `pane_wait` call gets there first: every producer that
writes a row calls `Daemon::inbox_notify`, which fires a per-session `tokio::sync::Notify`
(`Daemon::inbox_wake`) before anything else, whether or not the row is urgent. The wait
loop reserves-then-awaits (never the other order), so a write racing the check is never
lost — the DB is the truth, the notify is only ever a hint to re-check it sooner. Because
the reservation happens the instant the row exists, a row door 1 already claimed is
`delivered_at`-stamped by the time door 3's own batch timer fires, and door 3's own
eligibility query simply does not see it — no second mechanism keeps the two doors from
carrying one message twice.

Zero tokens are spent while blocked; the result lands as a tool result in the same turn,
exactly like the CLI's own sub-agent tool. Rows come ordered by `created_at, id`, capped at
`INBOX_BATCH_MAX_ROWS` / `INBOX_BATCH_MAX_BYTES` with `has_more: true` when cut. A `kind`
filter scopes to one row kind but never hides an urgent row: `needs_input`, `exited` and
`stalled` for a waited child return through any filter, so a parent waiting for a `result`
cannot sit forever on a child that is blocked or dead. `Daemon::inbox_waiting` enforces one
`pane_wait` per pane: a second concurrent call from the same caller is refused by name
rather than sharing the first one's reservation. The guard that holds a caller's slot in
both `inbox_waiting` and `inbox_wake` is released on every exit path — return, `?`, or
panic — through `Drop`.

### Door 2: the synchronous `Stop` hook

A parent that is still `Working` never gets a paste — door 3 only fires once it settles —
so its own `Stop` hook is the seam: the helper asks `POST /inbox/reserve` for rows
addressed to its session and, if any, prints the provider's continue shape and exits 0. The
CLI splices the text into the same turn instead of ending it. `POST /inbox/delivered
{delivery_id}` afterwards marks the row `delivered_via = 'stop_hook'`; a failed confirm
just lets the reservation expire, leaving the row eligible again.
`orchestrate::door2_continue_json(provider, text)` is the one place that shape lives,
`None` for a provider door 2 does not serve — Grok, OpenCode and Cursor stay on door 3.
Claude and Codex print `{"decision":"block","reason"}` (Codex's `~/.codex/hooks.json`
`Stop` hook takes the exact same shape, verified live on 0.153.4); Antigravity prints
`{"decision":"continue","reason"}`, and its re-fired `Stop` carries `executionNum: 1`.

For this to work the `Stop` hook must run **synchronously**, so `tr_hook_group` marks every
event but `UserPromptSubmit` `async: true` — except `Stop` and `StopFailure`, which run
synchronously, because an async hook prints into a pipe nobody reads. The cost is one
loopback HTTP call per turn end, on top of the process spawn already paid; measured under
load (200 backlog rows over 20 sessions plus a concurrent writer, 50 real helper runs,
idle machine): p50 9.9 ms, p99 15.3 ms.

Order inside the helper inverts for `Stop` only: reserve, print, THEN write the drop —
every other event drops first and prints second (`run_hook_client`). The reserve carries a
total deadline, `STOP_INBOX_QUERY_MS` (250 ms: connect plus write plus read, against a
capped reply), enforced by `orchestrate::http_json_deadline`; any failure — no daemon
env, connect refused, timeout, a non-200, a body that will not parse — prints nothing and
falls back to a plain `Stop` drop, because a hook must never hold a turn. A suspended
helper can still lose its reservation between the check and the print; the helper
re-checks `expires_at` right before stdout, which narrows that window and nothing more,
and a confirm arriving past expiry is refused with the row's own state rather than trusted.

A `Stop` the helper blocked is delivered to the daemon as `stop_continued = true`, and the
daemon treats it as Working: `apply_hook_drop` publishes neither `Idle` nor the delegation
advance for it — so a grandparent is never handed a result the
intermediary is still working on.

**The block cap.** Each block consumes the rows it carries, but new ones can keep
arriving, so the daemon counts consecutive continued stops per session
(`STOP_BLOCKS_PER_TURN_MAX`, 3 — comfortably under the 8 in a row Claude's own docs say end
a turn regardless) and resets on any other turn boundary. At the cap, `/inbox/reserve`
answers `{ rows: [], capped: true, limit, blocks }`, naming both numbers; the helper prints
nothing, the turn ends normally, and whatever is left goes through door 3 at the next Idle.

Both routes, `/inbox/reserve` and `/inbox/delivered`, are bearer-authenticated with the
pane's own MCP token like `/orchestrate/*`; authentication is not authorisation — the
daemon checks that every row in the reservation is addressed to the token's session before
returning or confirming it. The helper has `HOUSTON_MCP_URL` and `HOUSTON_MCP_TOKEN` in its
environment already; without them it exits 0.

### Door 3: the paste, proven

An idle parent gets one bracketed paste per batch through the existing wake lanes.
Eligibility is re-checked at WRITE time, not at enqueue: the lane carries an intent, and
the drainer reserves, composes and writes in one step. Non-urgent rows wait
`HANDOFF_BATCH_MS` so siblings finishing together cost one delivery; urgent rows skip the
window. Three refusals hold it back, and the rows stay pending through all of them —

- **never into a blocked parent.** `orchestrate::settled` counts `NeedsInput` as settled
  everywhere else on purpose, but a paste plus Enter at a permission prompt is an ANSWER,
  not a delivery. The rows are held, `SessionInfo.inbox_unread` shows them, and they go out
  at the parent's next Idle — which is what makes the exclusion safe rather than a second
  way to lose a result;
- **never over the operator.** The daemon sees every keystroke the renderer sends a pane
  (`server.rs`'s stdin seam, never `write_stdin` itself — the wake lane calls that too and
  must not flag itself against its own bytes). The first one marks the pane's composer
  possibly occupied, and only a submission boundary clears it: the pane's own
  `UserPromptSubmit` drop, or `inbox_deliver_now` from the renderer. Silence does not clear
  it; a half-typed prompt left to think about is exactly the case.
  `OPERATOR_TYPING_GUARD_MS` is a debounce on top, not the proof. A `ProcessOnly` pane
  never clears on its own; the operator releases it;
- **never twice.** `Backend::write_stdin` uses `write_all`, which can fail AFTER part of
  the payload landed, so `write_stdin_counting` drives `write` itself and reports how far
  it got. Only a proven zero retries, at the next settle, with the attempt counted;
  anything else — including a backend that cannot say — is `reason = 'partial'` and goes to
  the operator at once. `PASTE_ATTEMPTS_MAX` proven-zero attempts also go to the operator.

The framing's first line carries the `delivery_id`, and the parent's next `UserPromptSubmit`
whose prompt HEAD carries that exact id sets `confirmed_at`. `PASTE_CONFIRM_MS` counts from
the submitting `\r`, not from enqueue.

### The sub-agent round

A child that drives its own in-process sub-agents ends its turn for real each time one of
them returns: Claude fires `Stop` with a last message about waiting, and wakes itself with a
synthetic `UserPromptSubmit` whose prompt is a `<task-notification>`. Read literally, the
first turn end would hand a delegated child's parent a result the child is still working on.
So the correlation is structural, not timed — see `agent-lifecycle.md` for
the full rule; what the delegation sees is `orchestrate::SubagentRound`, one per pane:

- a `SubagentStart` puts the sub-agent in flight; a `SubagentStop` moves it out, and if its
  own `background_tasks` still lists it as running, the id goes into a set of notifications
  the CLI owes. A background shell or a monitor never holds a result.
- a turn end while either set is non-empty decides nothing: the record stays `working`, no
  `ready_at`, no `no_handback`. Door 2 for the child itself still runs.
- the `<task-notification>` prompt settles the debt, does not rename the pane, and does not
  count as a new request.
- an id that started in an earlier request is ignored: every `SubagentStart` is tagged with
  the round it began under, and a `SubagentStop`/notification whose tag predates the current
  request belongs to one that is over — it cannot hold the new request's turn end. A
  duplicate drop is a no-op, and does not restart the owed entry's clock.
- a turn end against two empty sets closes the round. What it was closed by is named:
  `stop_empty_sets` when nothing was ever seen this request, `stop_after_drain` when every
  sub-agent it raised was accounted for. The sets are in memory: a restart loses them and
  the expiry rule (`SUBAGENT_INFLIGHT_MAX_MS`, `OWED_NOTIFICATION_MAX_MS`) releases the
  withheld turn end instead. That release is a guess, not evidence, and it says so: the
  parent gets a `stalled` row naming the task id, how long it was waited on and the limit,
  and the result/no-handback row the release frees is `provisional`, so a late drop reopens
  the round and corrects it exactly like a `stop_empty_sets` close.

**A result released against no evidence says so.** Nothing published a barrier, so a turn
end against empty sets can be a guess: the `SubagentStart` that would have contradicted it
may simply not have been written yet. On a pane that has never driven a sub-agent, every
ordinary turn closes that way and the marker would be noise, so it is not set; on a pane
that HAS, the row is marked `provisional` and composes as such ("released on a stop with no
sub-agent evidence; a correction may follow"). Evidence arriving after a `stop_empty_sets`
close **reopens the round** and writes a correction row carrying `corrects = <that row's
id>` — "the child was still working; treat the earlier result as stale". The parent is told
the truth late rather than a guess on time, and the correction row is how the uncertainty
is carried from the first delivery instead of disclosed afterwards. The renderer's pane card
and the operator list show a corrected row struck through with a link to its correction,
and a provisional row with a marker until it is either corrected or the child's next round
closes cleanly. The reopen window is `OWED_NOTIFICATION_MAX_MS` from the close — the same
bound an owed notification gets, because it answers the same question: how late can a drop
file the CLI has already written still be.

### Permission episodes

A block is one **episode**, opened by the event that names the tool (`PermissionRequest`,
or Antigravity's `PreToolUse` on an ask tool) and keyed by the CLI's own invocation id where
the payload has one (`tool_use_id`), else by `(prompt_id, tool_name, generation)`.
Codex command episodes also carry a SHA-256 fingerprint: distinct commands remain open
independently, while a repeated request with the same turn, tool and fingerprint reuses
its episode. A `Notification(permission_prompt)` never opens an
episode: it fires beside the `PermissionRequest` that names the tool, so it attaches to the
newest open episode (filling in a reason it did not have) or is dropped with a debug log if
none is open. An episode resolves on its matching `PostToolUse` or the session's next
`Stop` / `UserPromptSubmit`, never on an arbitrary later hook. A new `PermissionRequest`
replaces only generated episodes without a fingerprint; identified commands remain
pending. A resolved row still undelivered gets
`resolved_at` and is never handed to the parent as a live question; it stays for the
operator as history.

For a fingerprint-backed episode, completion must carry the same command fingerprint
and, when the request supplied one, the exact turn id. Missing correlation evidence
keeps the episode open until a turn boundary. Without an invocation id, two concurrent
requests for the same command and tool in the same turn cannot be distinguished from
duplicate delivery; they share one episode. Raw commands are not persisted for this
correlation.

### Which request a body answers

`delegations.round` opens once per accepted external request, whichever way it arrives: the
spawn itself, a `PromptSubmitted` drop with `internal_prompt = false` (the parent's
`pane_prompt` paste or the operator typing — one hook either way, so `pane_prompt` does not
bump it), or an accepted `pane_prompt` on a `ProcessOnly` child that has no hook to say so.
It travels — the composed prompt carries `request #N` in its header, a `pane_prompt`
re-prompt that opens a new round frames its text with the new number the same way,
`workspace_info` returns the child's current round, and `pane_submit{request_id?}` stamps the
row with it. A submit that names none is stamped with the current request only while no
other request opened under the child's own turn; otherwise, the daemon cannot know which
request the body answers, so the row is stored unassociated (`request_id = NULL`,
`reason = 'unstamped'`),
reaches the parent as its own entry, replaces nothing, and satisfies no open request. The
tool result says so and names the requests the child may resubmit under. A submit for a
request that has already closed is `reason = 'late'` — a new row, never a replacement — so
two requests to one child yield two surviving results.

What opens a round is a request, and the hook only confirms it. The spawn's brief is
request 1; a prompt hook on a closed record reopens it and bumps; a prompt hook on a
`needs_input` child is the answer to its question and bumps. On a child that is already
`working` the state does not move, so the hook alone is no evidence: it bumps only when a
`pane_prompt` was written to that child and is still awaiting its hook. Anything else — the
same prompt delivered twice (two channels' entries in one hooks file, the older helper
carrying no `prompt_id`), or the operator typing into the pane — opens nothing, and a
`UserPromptSubmit` carrying the same `prompt_id` as the pane's last one is dropped before it
reaches any of this. A round the child already answered owes nothing more: a turn end after
a result released on a permission block is not a `no_handback`.

Within a request, a second submit REPLACES the first in place and counts it in `superseded`
— the parent reads the last word rather than every draft — but only while the first is not
reserved: a row a live door holds is immutable, and the new body becomes a new row. Nothing
can identify the sub-agents that share a child's MCP tools (MCP carries no per-call caller
identity), so the collapse is by request, not by authentication.

### Composition is one function for every door

`orchestrate::compose_inbox` writes a header naming the count and the delivery id, then per
row `[kind] #id from <codename (role)>: <summary>`, the body, and the artifact paths. Door 3
also appends a sanitized screen excerpt captured at submission and stored with the result,
capped at 400 characters plus a truncation marker. The snapshot survives temporary cleanup;
legacy rows without a snapshot fall back to the live screen when available. Door 1 and door
2 omit the excerpt. Request a reusable child when later terminal inspection is needed.
A row past its first
attempt says "possibly delivered before". A `Result` and an `Exited` from the same child in
one batch compose as one story ("it answered, then its pane ended"), and so do an
`OperatorNote` and an `Exited`; a `NeedsInput` whose block ended before any door carried it
is resolved instead — skipped by the doors, kept for the operator as history.

### Limits are visible, and a producer is refused only by the disk

Over `INBOX_PENDING_PER_PANE_MAX` a row is still written, then re-addressed to the operator
naming the limit, the count and the row. The operator queue is bounded by
`INBOX_OPERATOR_MAX_ROWS`, pruning the oldest CONFIRMED rows first and never an unread one.
A full wake lane is a row to the operator rather than a `warn!` nobody reads. A failed
insert is what `pane_submit` returns, with the body's size and the caps — never success on
a failed commit.

### The operator inbox

Rows addressed to a pane that is dead or restored-dead re-address to `to_session = 0` (the
operator), keeping `original_to`, `workspace` and a `reason` (`parent_dead`, `partial`,
`attempts`, `late`, `lane_full`, `backlog`). The operator inbox is a **workspace** surface,
not a pane surface: the pane may be gone, so `inbox_list{workspace}` answers rows by the
workspace they came from. The wire carries `InboxList { workspace }` → `inbox_rows`,
`InboxAck { id }`, `InboxResolve { id }` and `SessionInfo.inbox_unread`; reconnecting
replays the list. **Read is not resolved**: opening a row marks it `delivered_via =
'operator'` and `confirmed_at`; only an explicit resolve (or the block ending) sets
`resolved_at`, because reading about a blocked child does not unblock it. Children keep
running. Retention is `INBOX_OPERATOR_MAX_ROWS` for confirmed rows, never for unconfirmed
ones. The bell renders it — see `renderer.md`'s "Operator inbox".

### Restart and migration

The migration from legacy staging columns moves each `staged_result` into a `Result` row
with `ready_at = now` and `reason = 'migrated'`, then removes the columns in the same
transaction. An already-migrated database is unchanged. Recovery at boot is idempotent, so two
restarts produce one state, and it runs **after** restore:

1. `close_delegations_lost_to_the_restart` closes every open delegation as `unknown`, as
   before — a restored husk is a new process and nothing can reopen its mission.
2. The restore policy brings sessions back.
3. `db::inbox_recover_after_restart` runs against the live set restore actually brought
   back, not the empty roster boot started with — a respawned husk keeps its own rows
   addressed to it instead of re-addressing them to the operator on the strength of an
   empty live set. It releases every reservation; puts `paste` rows sent and unconfirmed
   back to pending (the paste may or may not have landed; the row keeps its attempt count);
   puts unacked `operator` rows back to unread; leaves `wait` and `stop_hook` rows final and
   untouched; and re-addresses rows whose `to_session` did not survive with
   `reason = 'parent_dead'`. A row is never auto-pasted into a process that is not the one
   it was addressed to: a restored pane's pending rows wait for its first
   `UserPromptSubmit` (the operator is there) or go through door 1 when it asks.

## The delegation record

Every spawn opens a row in `delegations` (one per child, keyed uniquely by child
session) carrying the brief, the lifecycle state, and the request counter. What the child
hands back is NOT here — it is a `pane_inbox` row addressed to the parent. The states are
`spawning -> working <-> needs_input`, closing at `done | failed | cancelled | unknown`.
Stalling is a flag beside the state, never a state: the stall signal cannot tell a wedged
child from a long silent turn, and a terminal `stalled` would kill live delegations.

The row also persists `reusable` and an optional `cleanup_after`. New API spawns default to
temporary; migrations give older rows `reusable = true` because their original intent is
not inferable. Cleanup is armed only after a durable result is released by an authoritative
completed round (or a process exit), never by `pane_submit` alone. It is deferred while a
live descendant exists, a wake or composer input is queued, or internal sub-agent evidence
is still outstanding. A provisional round has the bounded `OWED_NOTIFICATION_MAX_MS`
resolution window; late evidence can correct it before that deadline, after which the
round's in-memory hold is released so completed ordinary panes do not remain forever.
The wake-lane map owns both queued and in-flight delivery, and the cleanup marker is
rechecked under a shared lock with prompts, key input and submits so a follow-up cannot
remove a reopened round.
Removal emits `SessionRemoved` but leaves the delegation and inbox rows durable. The
historical parent chain continues to authorize the parent's `pane_wait` for that child;
it does not authorize unrelated panes or resurrect terminal controls. Descendant removal
rechecks deferred cleanup up the recorded ancestor chain. Explicit operator close remains
separate and retains its cancellation semantics.

**Closed is not the same as terminal**, and the two predicates on
`DelegationState` are not interchangeable. All four closing states are CLOSED:
`DelegationState::is_closed`, the record carries an `ended_at`, and the parent is owed
nothing further. Only `failed | cancelled` are TERMINAL (`is_terminal`) — their pane's
process is gone, so no event will ever reach them again.

`done` and `unknown` are the difference, and reusing a finished child is why. That pane is
still alive; a parent that hands it a new `pane_prompt` produces a real
`UserPromptSubmit`, and the resulting `TurnStarted` REOPENS the record to `working`.
`Daemon::advance_delegation` reopens through `db::delegation_reopen`, which takes
`ended_at` and `stop_reason` back off and opens the next request — so the new turn's
`TurnEnded` closes on a NEW row or on nothing at all, never a second time on the one the
parent already collected. `TurnStarted` is the only event that moves a closed record; every
other one still returns `None`, so a stray turn end cannot flip a delivered result back
open. `pane_prompt` follows the same split: `orchestrate::prompt_refusal` refuses only
`failed | cancelled`, naming the state and listing what would be accepted.

The lifecycle rides `AgentEvent`, not `AgentStatus` — `SessionStarted` and `TurnEnded`
both land on `Idle`, and only one of them means a turn finished — so it is applied in
`handle_hook_from`, beside `set_status`, and in `acp_tick` for a pane driven over ACP.
What no event can announce is sampled instead, in `delegation_watch_tick`.

**A turn that ends with nothing stored still reaches the parent.** The child is not
`done` — `delegation_transition` keeps returning `working`, because the pane is alive and
still promptable — but the parent is told, and told now.
`Daemon::deliver_unsubmitted_turn_end` sends a `no_handback` entry through the same batch
and wake path a result rides. Its body prefers a provider's own last message where the
payload or transcript carries one (a field Houston lifts and keeps per session — the one
place "last message" is consumed); a screen tail of the child's own pane
(`UNSUBMITTED_TAIL_LINES`) is only the fallback for a provider with no such field, and the
body names its source either way. The subject line and the body both say what it is: the
child's pane, not something it handed over. The reason it exists at all is that a wake must
not depend on the child remembering a tool call: two children each asked one trivial
question answered in their own panes, called nothing, and the parent's only eventual signal
was the five-minute stall notice, which carries none of the answer.

**Once per round, not once per turn end.** A child driving its own in-process sub-agents
fires `AgentEvent::TurnEnded` every time one of them returns, and every one of those turns
hands nothing over until the child finally calls `pane_submit`. Delivering on all of them repeated
the same notice with nothing new in it. `orchestrate::NoHandbackRound`, persisted on the
delegation record as `no_handback_reported`/`no_handback_suppressed`, latches after the
first delivery of a request and folds further empty-handed turn ends into a count instead of
re-sending; `pane_get`'s `DelegationView::suppressed_turn_ends` is that count. Three
control-plane events rearm it — a `pane_prompt` or `pane_send_keys` to the child, the child
submitting a result, or the delegation closing — never content or time.
`HANDOFF_BATCH_MS` still collapses whatever reaches the parent into one interruption.

Every one except a turn end that is not the child's. A CLI can fire one while it is still
coming up, before the child has read its brief, and the notice then describes a turn that
never began and quotes a startup frame as the evidence for it.
`orchestrate::unsubmitted_turn_end_reaches_parent` suppresses exactly that case and needs
all three of its facts to agree: the record is still `spawning`, the CLI reports turn starts
(`signals_turn_start` — every provider with a hook surface does today; a provider with none
has its record sit in `spawning` through the whole first turn and says nothing), and the
pane has never ended a line, which is what a full-screen CLI's first seconds look like in
the ring. Any one of them missing delivers, because a missed wake is the worse failure.
Still one delivery and not a state: the same event moves the record to `working`, so the
child's own next turn end goes over.

**Every delegation stores, and `TurnEndSource` says who released it.** Three sources:
`stop-hook` for the six providers with a `TurnEnded` mapping, `acp-turn` for a pane whose
ACP stream carries a `stopReason`, and `quiet-settle` for the rest (Gemini, `Custom`).
Only the last is a judgement rather than a report, so only the last is named in the
delivery — a parent can do nothing with "stop-hook" but read past it.

A turn end is not the only thing that releases a stored result: a child's process exit
releases one too, and that is the release the parent must not be told to `pane_read`. The
exit writes its own `Exited` row — always, whether or not anything came back — and the
composition folds the two into one story. A quiet-settle release names itself on the row
(`reason = 'quiet_settle'`), because that is the one release a parent may need to
second-guess.

**Quiet-settle** is the fifth named exception to "PTY content is not a status machine"
(`docs/internals/invariants.md`). `Daemon::delegation_watch_tick` samples every open
delegation; for a child whose source is `quiet-settle`, a tail fingerprint unchanged for
`DELEGATION_SETTLE_QUIET_MS` with no process running under the pane is a turn end nothing
else will ever announce. It serves both halves of one, because on those providers nothing
else can: `orchestrate::delegation_settle_action` weighs the evidence and the pass carries
the verdict out.

- A stored result becomes eligible and the record closes as `done`, exactly as before.
- Nothing stored sends the same `no_handback` row `deliver_unsubmitted_turn_end` sends
  on a reported turn end, which is the whole reason that delivery reaches a hookless child
  at all — it hangs off `AgentEvent::TurnEnded`, and Gemini and `Custom` never fire one.
  The record is untouched: the child is alive and still promptable, and the notice says
  the turn end was read off a still screen rather than reported.

Two bounds keep that honest. It is never a second mouth for a provider that already has
one — a `stop-hook` or `acp-turn` child leaves the pass before either branch, so the hook
remains its only deliverer — and the no-handback notice goes once per silence, never once
per poll: the sample that measures the quiet also carries whether the parent was told, and
the child's next byte clears both together, which is what re-arms it.

**The stall flag** is written by the same pass. A child that has produced nothing for
`DELEGATION_STALL_MS` with nothing running under it is flagged and its parent told once,
with the three levers (read, prompt, kill); the flag clears itself on the child's next
byte. A child in `needs_input` is excluded — its silence has already been reported as a
block. The flag is readable per child in `pane_list`'s payload.

**The record on the wire.** The renderer knows two orchestration facts about a pane from
`SessionInfo.spawned_by` and `SessionInfo.live_children`, plus `SessionInfo.delegation`
(the record this pane is the child of, or absent for a pane the operator opened — it is
`DelegationView` minus `brief`, which stays MCP-only because it is capped at 8 000
characters and this rides every roster broadcast), `children_waiting` (how many of a
pane's live children are blocked or stalled, derived in the daemon — never reduced
client-side), and `inbox_unread`. `ServerMsg::DelegationChanged { session, delegation }`
carries one child's whole record and fires from every seam that writes it — the spawn that
opens it, `advance_delegation` (hooks and ACP both reach the row through it), a submit, a
round close, the stall flag on BOTH edges, the quiet-settle close, a cancel, and a child's
exit. One `pane_inbox` row's own changes ride `ServerMsg::InboxChanged` instead, which
carries the whole row for the same reason.
`LiveChildrenChanged` gained `children_waiting` beside `live_children`, because the two
numbers are one badge and a single transition can move either. The one write with no
push is `close_delegations_lost_to_the_restart`, which runs at boot before a client has
connected; the roster those clients then ask for already carries the closed records.

## What the operator sees

Two badges in the pane header, and one card behind them.
A pane with live children reads `⑂ 3`; a pane an agent spawned reads `↳ oak`, the parent's
codename — the full title is too long for a 28px row, and the raw id sits in the tooltip.
The words those replaced cost roughly 79px of a 28px row that also has to hold a name,
`acp`, a profile label and a project, and a header that truncates its own identity is
worse than one that asks to be hovered — so the sentence moved into the card and into
`aria-label`, where a screen reader hears exactly what it heard before.

One alarm, split by who can already see it. A child blocked on its own pane needs nothing
extra: its `StatusDot` is already `--warn` and `.pane-notice-ring.needs-input` already
holds `--warn` on the pane's edge. A STALLED child gets one modifier — its badge glyph
turns `--warn` — because `stalled` is a flag on `working`, so the dot is green and pulsing
while nothing is happening, and that is the one place the grid actively lies. On the
PARENT neither can wait: its children may be in another grid, scrolled off, or on a
workspace nobody is looking at, so the count becomes `⑂ 1/3` with the numerator in
`--warn`. The `/3` exists only while something is waiting, which makes the alarm
structural as well as chromatic.

The card is the RAISED overlay tier (`OVERLAY_RAISED_CLS` + `materialAttrs('raised')`),
never a `Tooltip`: a tooltip is text-only, names icon-only controls, and dismisses on
`pointerdown`, so it can host neither a field table nor a control. One design, two
contents — a parent's is a roster of its children sorted waiting-first, a child's is its
own record — and only rows with a value render. Its levers are Focus, which selects the
target's workspace and makes it the active pane, and — while door 3 holds the child's
rows — Deliver now, which sends `inbox_deliver_now` for the parent. `pane_send_keys`
and Kill are deliberately NOT offered: a surface that opens on hover is not where an
operator gains a new power over a running agent.

**The codename survives the rename.** `SessionInfo.title` starts as a generated
codename and the first prompt replaces it — so the codename is stored separately
(`sessions.codename`, written at spawn, backfilled on read) and rides
`SessionInfo.codename`. Every parent-facing label reads it: `Daemon::child_label`
and `inbox_sender_label` spell `codename (role)`, which is what makes
`compose_inbox`'s `from <codename (role)>` hold by construction, and the
`pane_spawn`/`pane_list` shapes carry the field. A child's card names its parent
the same way ("child of oak", id in the tooltip).

**The card reports the inbox.** `DelegationInfo` carries what the child still owes its
parent (`inbox_owed`, `inbox_provisional`, both fed from the table at the same roster
seam), the correction link (`last_result_corrected_by`), the capability sentence
(`capability_note` — what the child's CLI cannot report, said by provider name), and the
composer-hold reason (`hold_reason`, set only while something is actually owed). The card
renders an "owed" row, the last result's state (a corrected result struck
through with its correction, a provisional one marked), the capability
sentence, and a "waiting" row with the hold reason in the daemon's words —
without which the hold would be a one-way door the operator cannot see.

## Role-scoped advertisement

A pane's tool list is its role. A leaf child —
spawned by another pane, unable to spawn, with no live children of its own —
sees exactly `pane_submit` and `workspace_info`: its handback and its
identity. An orchestrator — one that may spawn, or has live children — sees
the management verbs, with `pane_spawn` only while actually spawnable (out of
slots keeps the rest; only the spawn verb drops) and `pane_submit` only with
a parent to hand back to. An operator-opened pane with the switch off sees
nothing from orchestration. The gate lives in `ToolRegistry::list`, which
merges every provider, so browser, mail and routine tools are filtered for a
leaf with the rest; the rule itself is one pure function
(`orchestrate::tool_role`), fed by `Daemon::tool_role_of`.

Advertisement is not authorisation — except for a leaf, whose hidden tools
are also refused at `tools/call` (every tool hidden there is one the leaf
could never use and pays for on every turn). The switch gating stays
advertisement-only: a child whose operator turned orchestration off can still
call the two tools it keeps. The Codex gateway's `call_tool` enforces the same
predicate, so a leaf Codex pane cannot bypass the gate through the meta-tool;
its `list_tools` still serves the full catalogue, listable-but-not-callable.

A tool Codex's own Auto-mode approval rule would never gate (read-only, or
local and not open-world — `mcp_server::codex_requires_approval`) is listed
directly in `tools/list` by its own name and schema instead of behind
`call_tool`, so a Codex caller spends no approval round-trip on it; a gated
tool named directly is refused, naming `call_tool` as the way to reach it.

**Depth-aware advertisement.** `pane_spawn` is in a pane's tool list exactly
when that pane could use it: orchestration is on, it has a free child slot, and
the child would fit under the depth cap. The default depth is **1** —
nesting is opt-in — and a stored value always wins, so an operator who
already chose one is unaffected. All three conditions can move under a running
pane, and all three push `tools/list_changed` at the panes they affect
(`broadcast_live_children` for slots, `set_orchestration_caps` for either cap,
`orchestration_set` for the switch); without that, a hidden verb would be a
door that never reopens.

Because `pane_spawn` is not always advertised, it cannot carry the live state
any more: that moved to `pane_list`, which is advertised whenever anything is.
It reports the free slots and the depth cap when spawning is available, and
which of the three gates closed — plus how it reopens — when it is not.

## The provider table

Every provider gets the same six answers. "Works perfectly" cannot mean identical
mechanics — the six CLIs expose different hook surfaces — so the table records what each
one actually reports, and a missing capability is named, never silent. Fixtures for every
provider's captured payload shapes live under
`core/houston-core/tests/fixtures/hooks/<provider>/` with the CLI version in the file
name.

| | Claude | Codex | Grok | OpenCode | Cursor | Antigravity (`agy`) |
|---|---|---|---|---|---|---|
| **Turn end** | `Stop` | `Stop` (hooks.json; `notify` retired) | `Stop` | `session.idle` for the root session only | `stop` (`status`, `loop_count`) | `Stop` (`fullyIdle`, `terminationReason`) |
| **Last message** | `Stop.last_assistant_message` | `Stop.last_assistant_message` | not in payload: capped tail | plugin reads `client.session.messages` at idle | `afterAgentResponse.text` | not in payload; every payload carries `transcriptPath` (the CLI's own JSONL), read the last assistant entry there, never the screen |
| **Needs input, with reason** | `PermissionRequest.tool_name` + typed `Notification` | `PermissionRequest.tool_name`; `PostToolUse` resolves the matching permission episode | `Notification` (`permission_prompt`, `elicitation_dialog`) | `permission.asked` (`permission`, `patterns`); also subscribed `permission.updated` for older builds | **none exists**: stall row, named in `pane_list` | `PreToolUse` (matcher dialect) for `ask_question` / `ask_permission` / `ask_custom_permission` with no `PostToolUse` yet; `toolCall.args.questions[].question` is the reason |
| **Sub-agent vs child** | the round rule above | `SubagentStop` is separate; main `Stop` fires once, parent stays busy | `SubagentStart`/`Stop` separate; `spawn_subagent` blocks the parent by default | child is a session with `parentID`; plugin maps ids from `session.created`, parent stays busy | `subagentStart`/`Stop` carry `subagent_id`, `parent_conversation_id` | sub-agent is a second `conversationId` firing the same hooks; the parent's own `Stop` while it waits has `fullyIdle=false`. Pin the root id at the first `SessionStart`, drop the rest |
| **Door 2** | `Stop` → `{"decision":"block","reason"}` | same shape, `exit 0`, live-verified | none enabled: docs contradict; door 3 carries the rows | none enabled: plugin injection still to probe; door 3 carries the rows | none enabled: `stop` → `{"followup_message"}` documented, not live-verified; door 3 carries the rows | `Stop` → `{"decision":"continue","reason"}`, exit 0; the re-fired `Stop` carries `executionNum: 1` |
| **Houston tools in the child** | `--mcp-config`, added to the user's own servers (no `--strict-mcp-config`) | `-c mcp_servers.*` + token env | user-scope `grok mcp add` with a `${HOUSTON_MCP_TOKEN}` header | `OPENCODE_CONFIG_CONTENT` env with a `remote` server and bearer header | user-scope `~/.cursor/mcp.json` entry with `${env:HOUSTON_MCP_TOKEN}`, `_houston` marker | `~/.gemini/config/mcp_config.json` headers; bearer silently ignored upstream, smoke-test |
| **Verified how** | live, 2.1.263 | local schema + docs, 0.155.1 | docs + repo; login needed to probe | live, 1.18.27 (child sessions, idle, permission event) | docs; login needed to probe | live, 1.1.26 (all six rows) |

Capabilities are typed per session, not per provider name: `orchestrate::ProviderCapabilities`
carries `turn_end`, `last_message`, `block` and `door2`, derived from the event map and the
door-2 shape — so a table that disagrees with the events is structurally impossible — with
the last-message axis as the one explicit list (`LAST_MESSAGE_PROVIDERS`, the providers
whose hook surface actually delivers the field this crate lifts, however it gets there).

What changes per provider, beyond the shared inbox:

- **Codex.** `agent_hooks.rs` installs `~/.codex/hooks.json` in the Claude schema for
  `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, plus
  `SubagentStart`/`SubagentStop`/`SessionEnd`/`PreToolUse`/`PostToolUse` correlation-only, with the
  same managed-marker discipline as Cursor's file; `notify` is removed from `config.toml`
  (parked, or deleted outright if it is Houston's own stale entry). Codex maps to
  `HooksFull`. In the 0.155.1 event shape, `PermissionRequest` has no `tool_use_id`;
  the helper carries its `turn_id` and a SHA-256 digest of `tool_input.command`, and
  `PostToolUse` clears only the matching episode without storing the raw command.
  **Trust** is Codex's own, not Houston's to grant: an untrusted hook is
  silently skipped, so a Codex pane's `SessionStart` drop never arrives and its status
  reads `ProcessOnly` until the operator trusts Houston's hooks in Codex's own review
  screen. Houston never passes `--dangerously-bypass-hook-trust` — a spawn into a repo
  carrying its own `.codex/hooks.json` would run that hook untrusted too. A missing drop
  does not prove distrust (a slow helper, a broken file, a hook that errored all look the
same), so `pane_list` and the Agent setup screen say "Codex hooks installed, not
confirmed for this pane" and name the likely causes, trust first; the setup screen's own
check reads `[hooks.state]` to say whether the trust entry exists — the Codex row reports
`no_config` / `not_confirmed` / `some_trusted`, and when nothing has ever been trusted it
says "Hooks installed, not confirmed: Codex runs a hook only after you accept it once in
its own review screen — open any Codex pane". Writing `trusted_hash`
ourselves is deferred: the algorithm is source, not contract.
- **Grok.** Hooks already installed in `~/.grok/hooks/houston.json`. `SubagentStart`/
  `SubagentStop` are installed correlation-only; `PermissionRequest` was NOT added — the
  docs list `PermissionDenied`, the moment a permission has already been resolved, not the
  "blocked asking" moment `NeedsInput` means — so `Notification` stays the one block
  signal. Grok's field casing is unconfirmed (one docs fetch said camelCase, the code
  assumed Claude's snake_case), so `parse_hook_payload` tries snake_case first, then the
  camelCase twin, for Grok alone. Grok also reads a workspace's `.claude/settings.json`
  hooks, so a Grok pane in a workspace where Houston installed Claude hooks fires the same
  moment twice; the Claude-path helper now exits without writing a drop when `--agent` is
  absent and `GROK_SESSION_ID` is set, so only the Grok-side drop lands.
- **OpenCode.** No native hook contract at all — its plugin bus fires JS callbacks, not a
  shell command with its own stdin — so `houston-notify.js` is the hook contract: it builds
  the JSON `parse_hook_payload` expects itself and pipes it into the same
  `if [ -x … ]; then exec …; fi` command every other provider gets, through
  `printf '%s' <json> | sh -c <cmd>` rather than the plugin's own inherited stdin (the TUI's
  real keyboard). A `sessionID → parentID` map, seeded from `session.created` and falling
  back to `client.session.get` for an id never seen created, tells a task-tool child
  session apart from the root: a child's own creation only updates the map, and a child's
  `session.idle` forwards under Houston's own `SubagentStop` name instead of the pane's
  turn end. The root's idle reads `client.session.messages` and carries the text as
  `last_assistant_message`. A permission event (`permission.asked`, live; `permission.updated`,
  older builds) forwards `permission`/`patterns` as the reason, in whichever session it
  fired — a permission asked inside a child still blocks the pane.
- **Cursor.** `~/.cursor/hooks.json` gains `afterAgentResponse` (the only place Cursor's
  last-said text lives, `{"text": "..."}` — lifted into `last_message` but still never a
  status, since it fires after every assistant message) and `subagentStart`/`subagentStop`
  (correlation-only). No needs-input event exists in Cursor's contract; the stall row
  covers it and `pane_list` says "cursor cannot report a block; a stall stands in".
- **Antigravity.** Binary is `agy`. The installer adds `SessionStart` and
  `PreToolUse`/`PostToolUse`, which fire **only in the matcher-wrapped dialect**
  (`{"matcher": ".*", "hooks": [...]}`); the plain entry the installer writes for the other
  events is silently ignored for these two. Every payload carries `conversationId`,
  `transcriptPath` and `workspacePaths`. The daemon pins the pane's root `conversationId`
  from its first `SessionStart` drop and treats every event with another id as a
  sub-agent's (correlation, dropped); a root `Stop` with `fullyIdle=false` (the parent
  parked on `invoke_subagent`) decides nothing, `fullyIdle=true` closes the round. A
  `PreToolUse` naming `ask_question`, `ask_permission` or `ask_custom_permission` opens a
  `NeedsInput` episode with the question text as reason, and its `PostToolUse` ends it. The
  last message comes from the CLI's own transcript file at `transcriptPath`, not the
  screen. Antigravity has its own agent-to-agent inbox; Houston does not use it, the child
  reaches its parent through `pane_submit` like every other provider.
- **Gemini CLI is not Antigravity.** Its hooks live in `settings.json` under `"hooks"` with
  `BeforeAgent`/`AfterAgent`/`Notification`; Houston's file is Antigravity's. Gemini stays
  `Custom`/quiet-settle.

### What a provider cannot do is said, not hidden

`ProviderCapabilities` has one consumer beyond the tests: `capability_note` turns a missing
axis into one sentence per provider, joined with `"; "`, and `pane_list` carries it per
child — "grok reports no last message; the exit or the submit is what the parent gets",
"cursor cannot report a block; a stall stands in", "opencode has no turn-end continuation;
results wait for its next idle". A `ProcessOnly` CLI gets exactly its own sentence — "this
pane reports no turn end; only a submit or its exit reaches its parent" — because the other
three axes are moot when there is no turn end to hang them off. The renderer's delegation
card shows the same sentence. A door-2 mechanism that is unconfirmed for a provider (Grok,
OpenCode, Cursor) is not enabled for it; that provider's parents use door 3 until a live
probe verifies its continue shape.

### Measured

The live probes that settled these rows, in a real PTY with every hook event logged:

- **Claude Code 2.1.263.** One request that used a sub-agent produced two `Stop`s and two
  `UserPromptSubmit`s, and neither `Stop` carried `agent_id` — the round rule's basis. A
  permission prompt fired both `PermissionRequest` (the one that names the tool) and a
  typed `Notification` with the same `prompt_id`. A `Stop` hook printing
  `{"decision":"block","reason":"…"}` on exit 0 continued the same turn; the second `Stop`
  carried `stop_hook_active: true`.
- **Codex 0.153.4.** Fifteen events for two prompts; `SubagentStart`/`SubagentStop` fired
  with `agent_id`, and the main turn stayed open while the parent waited — Codex has no
  round problem. `PermissionRequest` never fired in the probe (the session ran in
  `bypassPermissions`); its shape is source-verified only.
- **OpenCode 1.18.27.** The task tool created a child session whose `info.parentID` was the
  pane's session; the child's `session.idle` carried only `sessionID`; the parent stayed
  `busy` for the whole child run; `permission.asked` fired (with `permission` and
  `patterns`), and `permission.updated` did not. Root-session permission end to end, and
  plugin injection, are still to probe on a capable model.
- **Antigravity `agy` 1.1.26.** `invoke_subagent` started a second `conversationId`; the
  parent's `Stop` while it waited carried `fullyIdle: false`. `ask_question` fired
  `PreToolUse` with the question and no `PostToolUse` until answered. A `Stop` hook printing
  `{"decision":"continue","reason":"…"}` on exit 0 continued the turn; the re-fired `Stop`
  carried `executionNum: 1`. Registered and never fired: `SessionEnd`, `UserPromptSubmit`,
  `Notification`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `StopFailure`.
- **Grok and Cursor** rely on documented contracts; authenticated live probes remain
  pending. Verify Grok's field casing and whether Cursor's `stop` →
  `followup_message` really continues a turn.

The token budget for a child's `tools/list`, measured on the serialised response with every
in-`core` provider registered (`core/houston-core/tests/tool_roles_wire.rs`, which prints
all three):

| Role | bytes |
|---|---|
| Leaf child (`pane_submit` + `workspace_info`) | 1 996 |
| Orchestrator parent (the management verbs + `workspace_info` + browser relay) | 15 971 |
| Operator pane, switch off (`workspace_info` + browser relay) | 7 968 |

The Tauri shell's own `BrowserTools` cannot be registered from a `core` test; the
string-literal upper bound for that half is 18 613 B, and a leaf filters it out like every
other non-handback tool, so the shipped leaf cost is the 1 996 B measured here. Door 2's
latency budget (`STOP_INBOX_QUERY_MS`, 250 ms) was measured under load at p50 9.9 ms /
p99 15.3 ms.

## `pane_send_keys`

The only lever on a blocked pane, and on a pane whose
CLI Houston hears nothing from. Deliberately NOT refused on `NeedsInput` —
that refusal is `pane_prompt`'s, and it is about prose: a permission prompt
wants a keystroke. What keeps this safe is `orchestrate::SENDABLE_KEYS`, an
allowlist of eight (`esc enter up down tab ctrl+c y n`), checked in full
before any byte is written so a bad key sends nothing rather than half a
sequence. No paste framing and no trailing Enter; `enter` is asked for by
name, because a tool that always submitted could not answer a prompt that
wants a selection first. One encoding on both platforms: ConPTY takes the same
VT input sequences a kernel PTY does.

## `pane_get`

One pane in the caller's subtree as `orchestrate::PaneDetail`:
the session row flattened in (so this is `pane_list`'s element shape plus
extras, not a second vocabulary), the live-children and depth numbers its own
spawn caps are measured against, its `TurnEndSource`, and its `DelegationView`
if it has one. The view deliberately reports `result_staged: bool` — read off the
parent's inbox, since that is where the body lives — rather than the body itself, which
is the parent's next wake and not a field a caller can drain early. This is the one verb a caller may point at ITSELF: the scope gate's
self-refusal exists for the verbs that act on a pane, and this one only reads.

## The brief

`prompt` is unchanged and is still a complete request on its own;
`output_format` and `boundaries` are optional and are composed WITH it, by
`orchestrate::Brief::compose`, into one instruction string before anything is launched.
Additive on purpose: the same bytes reach every provider's CLI, no wire shape changes, and
nothing downstream — the prompt file, `delegations.brief`, `pane_get` — learns a second
shape. Composing IS the validation (the caps live inside `compose`), so no door can build a
brief that skipped them, and an over-long half is REFUSED rather than clipped: the caller of
a spawn is still there to fix what it sent, and half a response schema instructs worse than
none. There are no new columns; the row's `brief` holds the composed text, which is what a
parent reading `pane_get` actually needs to see.

Every composed brief ends with the same short **handback protocol**: call `pane_submit`,
because that and not the child's own pane is what reaches whoever
asked. The MCP `initialize` paragraph says this too, but it is read once at connect and
then has to win against the whole task — and on a small enough task it loses. The
instruction the child is launched with is the one text it cannot skim past, so the protocol
goes there as well, last, after the task and both of its optional halves.

## Artifacts

A worker's handback may carry a one-line `summary` and a list of `artifacts`
— files it wrote, named instead of quoted. This is the exit `SUBMIT_BODY_MAX_CHARS` did not
have: a long result used to have nowhere to go but the child's scrollback, which the parent
then had to read back out of a terminal. Each path is resolved against the CHILD's own
working directory, required to exist, and held to the workspace by the same containment rule
a spawn's `cwd` is (`orchestrate::artifact_scope_verdict`). A path that fails any of those
refuses the WHOLE submit, by name: the worker is still running and can correct the list,
whereas a parent sent to a missing file discovers it only after spending a call on it. What
reaches the parent is the resolved absolute path, appended by `Submission::compose` under
the body it annotates.

## Roles

`pane_spawn{role}` names one child in the parent's own vocabulary.
Validated and lowercased by `orchestrate::validate_role` (lowercase letters,
digits, single hyphens, 32 chars), then checked for uniqueness among the
caller's LIVE children — deliberately not a unique index, because the rule is
per-parent and expires with the pane: two sibling orchestrators may each have a
`reviewer`, and killing one frees the name. Stored on the delegation row, read
back in `pane_list`, and prefixed to the child's name in every wake its parent
gets (`Daemon::child_label`).

## The approval ceiling

`sessions.approval_mode` records what a pane runs as, over the
`ApprovalMode` ladder (`Default < Auto < Bypass`) that names the two existing per-CLI flag
tables. The rule is deliberately NOT `child <= parent`: every orchestrated child is spawned
at `Auto` on purpose, so that rule would drag them all down to the CLI's own prompting
default with nobody there to answer it. Only escalation is gated — `Bypass` is refused
unless the parent already holds it.

A body over `SUBMIT_BODY_MAX_CHARS` is clipped with a marker naming the cap and the actual
size — the worker is told the number in the skill and in `pane_submit`'s own description, so
the clip is a stated rule rather than a surprise.

Waking a pane is not one write: it is a bracketed paste, a settle pause for the target CLI's
line reader, then the `\r` that submits it. Those three steps belong to one drainer thread
per session (`swarm_wake_lanes`), so two wakes racing on one pane arrive as two prompts
rather than one merged paste with a stray Enter behind it. A queue rather than a lock held
across the pause: the lock would stall every enqueuing hook and MCP thread for its duration.

`handoff.rs` curates the context for a *different* handoff — pane-to-pane context transfer
— with `TOTAL_BUDGET` 128 KiB and `BLOCK_CAP` 12 KiB, idle-gap annotation and a markdown
prompt template.

## Legacy scope compatibility

`swarm_*` remains a prefix for orchestration scope infrastructure: `scope.rs`, database
tables, `SwarmMessage`/`SwarmAgent` wire events and the hook-delivery loop `swarm_mail_loop`.
It does not identify a separate user-facing workflow.

`Daemon::swarm_send` writes a `pane_inbox` row addressed to the recipient's live session;
a recipient with no live session is re-addressed to the operator (`reason = "parent_dead"`).
`Db::open` imports legacy message files under `<root>/.houston/swarm/<id>` into
operator-addressed rows (`reason = "migrated"`).

`ScopeLayout`/`scope_dir`/`init_scope` maintain the directories used by the `plan/events/`
GC sweep. Hook drops use the channel's `hooks/drop/` directory, and `hs-pane` wrappers
live under each workspace's `.houston/orchestration/bin/`.
