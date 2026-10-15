# Orchestration

> For maintainers. Start at [overview.md](overview.md) for the process model.

An agent in a Houston pane can open more panes, read them, prompt them, wait on them and kill
them. It does that over MCP, against the daemon that owns its own PTY, with a credential
minted for its pane alone. Every signal one pane owes another is one row in `pane_inbox`, the
single table the three delivery doors read — see "The inbox" below.

Children default to their CLI's Auto mode; Ask and Bypass use the provider's launch flags. Unless `cwd` is supplied, it inherits
the parent's reported working directory when that directory exists inside the target
workspace; otherwise it starts at the workspace root. There is no merge gate or sandbox
isolating it. The one
exception is asked for, never implied: `pane_spawn { worktree: "<slug>" }` (`hs-pane spawn
--worktree SLUG`) first creates a git worktree at `<workspace>/.houston/worktrees/<slug>` on
branch `houston/<slug>` (or `branch`), records it in `managed_worktrees`, and starts the
pane there, including an independent pane when combined with `handoff: true`.
The base resolves in order: `origin/HEAD`, `main`, `master`, then `HEAD`;
it does not follow the caller's feature branch. `branch` names the new branch, not its
base; `pane_spawn` has no base override. `worktree` with `cwd` is refused, as is a `branch` that `git check-ref-format`
rejects. A child that fails to start takes its new worktree and branch with it; a worktree
that cannot be removed keeps its branch and record. Removing a worktree from the Changes
pane drops its record, and a new worktree at a recorded path replaces the stale record, so
a slug is reusable once its worktree and branch are gone. Houston does not commit changes
on an agent's behalf.

Every path that records a `managed_worktrees` row calls `worktree_include::carry_over` once
the tree exists. Git decides what is copied: `ls-files --others --ignored` with
`.worktreeinclude` as the exclude file, narrowed by `check-ignore`, so only untracked files
the checkout ignores qualify and the patterns mean what they mean in `.gitignore`. No
repository-defined command runs and no matcher is reimplemented. Copies never overwrite,
never follow a symlink in either tree, and are bounded by `MAX_FILES` and `MAX_BYTES`;
logs name counts and relative paths, never contents. A copy failure is a warning, never a
failed creation. `pane_spawn` returns it as `worktree_include`; a task appends it to the
brief when the brief stays within its limit; the Changes pane appends it to its reply
message. Cleanup does not count an ignored file that is byte-identical to the same path in
the workspace checkout, so unchanged copies do not keep a worktree; the comparison shares
the same file and byte bounds, and a file past them counts as local work.

Creating a worktree does not request a handoff. Normal delegation uses child panes
with `worktree`; independent handoff is reserved for an explicit operator request to
continue in a new pane, passing context via `state_doc`. A contributor must not edit
a child's worktree from the primary checkout: the pane's checkout must describe where
its process works.

## Guarantees

These are the properties orchestration promises, and the only ones. Each is enforced by the
invariant checker in `tests/it/orchestration_chaos_wire.rs`, which drives every spawnable
provider through `fake_agent` with randomized seeds, daemon kills and slow writers. A change
that weakens one of them changes this list in the same PR.

- **No lost signal.** A row is persisted before any door reads it. A crash between a child's
  `pane_submit` and the end of its round cannot leave a result that is neither stored nor
  eligible (`ready_at` is set in the transaction that closes the round). Restart recovery
  releases reservations and returns unconfirmed pastes to pending.
- **At-least-once, recognisably.** Delivery is never claimed exactly-once. A redelivered row
  keeps its `pane_inbox.id`, carries a new `delivery_id` and says "possibly delivered before";
  a stale confirmation cannot mark a later attempt.
- **One door per attempt.** Doors claim disjoint rows through a conditional reservation, and
  an active HTTP body or PTY write pins its reservation until it completes or is cancelled.
- **No paste into the wrong process.** A row is pasted only into the process generation it
  was addressed to. A restored pane receives pending rows on its first prompt or through
  `pane_wait`.
- **Every row has a live owner.** A row addressed to an ended pane moves to the nearest live
  ancestor orchestrator, keeping `original_to`; it reaches the operator only when no
  ancestor is live. Delegated children never address the operator directly.
- **Status comes from the provider.** Lifecycle state comes from hooks or supported streams,
  never from terminal text. Where a provider has no signal for a state, the provider table
  says so, and Houston does not guess.
- **Limits refuse visibly.** Every cap names the limit, the actual value and the refused
  operation, and is returned to the caller that hit it. A producer is refused only when the
  insert itself fails.
- **Untrusted text is bounded and redacted.** Every agent- or hook-written field passes
  `orchestrate::inbox_row_new`, which caps it and runs secret redaction, before it is stored.

Known limits:
- A server body completing is not an application acknowledgement.
- Codex has no authoritative human-escalation event; an unresolved Auto review shows the
  `stalled?` diagnostic described below, which can be a false positive.
- Cursor has no needs-input signal.
- Windows writer cancellation has no automated test yet.

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

## Provider lifecycle capabilities

These are Houston's installed hook contracts, not proof that every provider version emits
all supported events. Every PTY additionally reports process exit independently.

| Provider | Turn start | Tool use | Turn end | Needs-input | Session end | Parent wait cap | API failure | Restart |
|---|---|---|---|---|---|---|---|---|
| Claude | UserPromptSubmit | Interactive PreToolUse; PostToolUse/Failure | Stop; native mod interruption on supported launches; StopFailure is failure | PermissionRequest, interactive tools, blocking notifications, elicitation | PTY exit | 90 s | StopFailure; error and details | Unsupported: live restart contract unverified |
| Codex | UserPromptSubmit | request_user_input; PostToolUse | Stop; Interrupt is interruption | Ask approvals, request_user_input; Auto approvals are activity | SessionEnd correlation; PTY exit | 600 s | Unsupported in hooks | Escape |
| Antigravity | PreInvocation (each invocation) | PreToolUse/PostToolUse | Stop | Supported ask tools only | PTY exit | 30 s, provisional | Unsupported in hooks | Refused: no verified key |
| OpenCode | User messages; busy status is activity | Permission/question events | session.idle; session.error is failure | Permission/question requests | PTY exit | 600 s with managed launch timeout | session.error | Unsupported: interrupt-to-idle contract unverified |
| Cursor | beforeSubmitPrompt | No generic tool signal installed | stop | Needs-input not reported by this provider | PTY exit | 30 s | Unsupported in hooks | Refused: no verified key |
| Grok | UserPromptSubmit | No generic tool signal installed | Stop; StopFailure is failure, StopCancelled is interruption | Typed blocking notifications | SessionEnd, filtered for subagent teardown; PTY exit separately | Up to 600 s after reading effective tool timeout | StopFailure | Ctrl+C with empty composer |
| ZCode | UserPromptSubmit | AskUserQuestion PreToolUse; the PostToolUse/Failure with the same tool_use_id (a denial fires no hook) | Stop (successful turns only); an interrupt cancels ZCode's hooks and reports nothing | PermissionRequest, AskUserQuestion | PTY exit | 600 s with the plugin's 630 s tool timeout | Unsupported: a failed turn fires no hook and stays Working | Refused: an interrupt reports no idle |

Wait budgets belong to the calling parent, regardless of its children's providers. Requests
above the cap are clamped and report the provider, requested value and cap. Claude's cap
stays below foreground auto-backgrounding; Cursor keeps a margin under its inspected
60-second timeout. Codex's launch timeout is 630 seconds. OpenCode's Houston registration
uses a process-scoped inline timeout of 630000 ms, reversed automatically on exit. Grok's
`tool_timeouts.pane_wait` overrides the server timeout; unknown or invalid configuration
uses a provisional 30-second cap. Antigravity's numeric client limit is still unknown.
A timeout returns one line asking the parent to call `pane_wait` again.

Codex Auto PermissionRequest is approval-flow evidence, not human-wait evidence. An
unresolved episode after five minutes raises a deduplicated `stalled?` marker with its
episode, elapsed time and `approval_outcome_unobserved`. The threshold is a conservative
heuristic: hermetic fake-agent timing is only a latency lower bound, and does not measure
real reviewers. On Linux, an episode whose session still has a running external process
is treated as approved and raises no marker, because hooks report the outcome only when
the tool completes. Slow review and missing hooks can still produce false positives.
The marker leaves the agent Working, produces no desktop notification and reaches parents
only through an explicit wait. Matching PostToolUse, Stop, Interrupt or a new root user
prompt clears it. Without a call id, matching requires turn, tool and canonical input
digest; incomplete evidence survives unrelated tools until an authoritative turn boundary.
Live daemon adoption carries tracked native permission, question and Auto-review episodes,
including exact correlation identities, generation counters, digests, root prompt replay and
provider conversation fences, evidence that lifecycle hooks were seen, and operator-intervention fences.
Reported lifecycle evidence keeps its precedence over program-status and quiet-settle fallbacks
after adoption. The database remains authoritative for typed request ids, ownership and denial
attempts; adoption does not reopen requests or repeat
a denial. Descriptive metadata is bounded and redacted, and the snapshot shares the existing
manifest byte cap. Structured matching evidence can resolve an adopted episode before a turn
ends, with the same cardinality checks for denial.

Older manifests remain readable when no native input is pending. A pending NeedsInput status or
persisted provider request without matching recovery state refuses adoption before commit, naming
the session and leaving the old daemon owning its PTYs. The owning daemon also refuses a
handoff to a candidate lacking snapshot support when native episodes or intervention fences
remain pending. The operator must resolve unknown input before retrying; Houston invents no
permission identity or verified denial. Captured operator answer text is not transferred;
resolution still records the intervention without it.
A legacy Working session without a persisted native request remains adoptable; a later typed
waiting signal reconstructs the request normally. Bare activity alone does not invent an ask.
Native hook passes and operator writes admitted before handoff drain before snapshot capture.
They remain fenced through commit; new hook files stay queued for the adopting daemon, and
operator or parent input during handoff is refused for retry against the owning generation.

Internal inbox prompts never clear permission episodes. Ordinary root tool activity
reports Working only when no human-input episode remains open, preserving concurrent
questions. A SessionStart arriving during Working or Needs input cannot end that turn.

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
| `pane_prompt` | `mcp_orchestration.rs` | `hs-pane prompt` | send follow-up text into a child; return immediate write failures and queue held prompts on the bounded wake lane |
| `pane_wait` | `mcp_orchestration.rs` | `hs-pane wait` | door 1: block on the caller's own `pane_inbox` until an eligible row exists (or the timeout runs out), reserve it, return the rows in this same call, and mark `delivered_via = 'wait'` after the response body completes. `session` (optional) scopes to one child; `kind` (optional) filters to one row kind but never hides an urgent one for a waited child. `until` is removed and refused by name, naming `kind` as its replacement |
| `pane_kill` | `mcp_orchestration.rs` | `hs-pane kill` | end a child pane |
| `pane_submit` | `mcp_orchestration.rs` | `hs-pane submit` | worker→parent result handoff, with an optional summary and artifact paths; wakes the parent |
| `pane_report` | `mcp_orchestration.rs` | `hs-pane report` | worker progress, question or blocker during its current request; does not complete the request |
| `pane_reply` | `mcp_orchestration.rs` | `hs-pane reply` | answer a question addressed to the caller and atomically store a correlated reply |
| `pane_deny` | `mcp_orchestration.rs` | `hs-pane deny CHILD --episode-id ID` | deny an exact pending descendant permission with verified provider input |
| `pane_escalate` | `mcp_orchestration.rs` | `hs-pane escalate` | transfer an unresolved descendant input request to the user with a reason |
| `pane_instruction_list` / `pane_instruction_get` | `mcp_orchestration.rs` | `hs-pane instruction-list` / `instruction-get` | inspect durable instruction delivery states or explicitly read a retained body |
| `pane_instruction_cancel` / `pane_instruction_resume` | `mcp_orchestration.rs` | `hs-pane instruction-cancel` / `instruction-resume` | cancel an inactive pending instruction or explicitly resume an untouched recovery-held instruction |
| — | — | `hs-pane keys` | press a small set of keys in a pane (the CLI-only spelling of `pane_send_keys`) |
| `pane_send_keys` | `mcp_orchestration.rs` | — | press a small set of keys in a pane (see the tool's own description for the list) |
| `harness_publish` | `mcp_harness.rs` | `hs-harness publish` | not a pane verb: a harness review run hands its `report.md` and `findings.json` to the Harness view. Offered only to that run's pane while it is in flight, whatever the orchestration setting |
| — | — | `hs-harness` | the extractor a harness review run calls (`inventory`, `digest`, `publish`); its wrapper sits beside `hs-pane`, and `digest` refuses outside a routine run (carve-out #6 in `invariants.md`) |
| `task_list` | `mcp_tasks.rs` | `hs-task ls` | list the workspace's active tasks, filtered by `status`, `ready`, `mine`, `query` and a capped `limit`; ready applies the same content and dependency gate as automatic execution |
| `task_get` | `mcp_tasks.rs` | `hs-task show` | one task's full text, acceptance items and recent comments. Every `task_*` tool's `id` is an integer id or a `HOU-<n>` key resolved globally (`Daemon::task_ref_in`; `hs-task` keys go through `task_id_for_key`, the same lookup) |
| `task_next` | `mcp_tasks.rs` | `hs-task next` | the highest-priority ready task (urgent, high, medium, low, then none) |
| `task_create` | `mcp_tasks.rs` | `hs-task add` | create a task, attributed to the calling pane |
| `task_update` | `mcp_tasks.rs` | — | edit a task's fields; requires the `expected_revision` the last read showed, so a stale edit is refused naming expected and actual |
| `task_comment`, `task_check` | `mcp_tasks.rs` | `hs-task comment`, `hs-task check` | append a comment, or tick one acceptance item by its id (the CLI's `ITEM` is the 1-based position) |
| `task_claim`, `task_handback` | `mcp_tasks.rs` | `hs-task claim`, `hs-task handback` | claim moves backlog/todo to in progress and records the session; handback writes the summary as a comment and moves to in review. Neither sets Done |
| `task_execute` | `mcp_tasks.rs` | — | start a task as a child of the calling orchestrator: the task's worktree and branch, a delegation and the child brief; the run stores the delegation and the child's `pane_submit` settles it. Offered only to a spawnable caller, exactly like `pane_spawn` |
| `task_review` | `mcp_tasks.rs` | — | open an independent read-only reviewer child for the task's newest implementation run, on its worktree once that run settled or a detached tree of the same branch while it is still running |
| — | — | `hs-task` | the Tasks helper, a shell wrapper beside `hs-pane`; the key defaults to `$HOUSTON_TASK` and there is no `done` verb |
| `browser_current_page` | `src-tauri/src/browser/mcp_tools.rs` | — | URL, title, favicon, loading state |
| `browser_capture` | `mcp_tools.rs` | — | PNG screenshot of the browser pane |
| `browser_navigate` | `mcp_tools.rs` | — | load an http(s) URL, opening a pane at it when the workspace has none |
| `browser_snapshot` | `mcp_tools.rs` | — | accessibility-style snapshot with `ref`s |
| `browser_click`, `_type`, `_hover`, `_press_key`, `_select_option` | `mcp_tools.rs` | — | act on an element by `ref` |
| `browser_go_back`, `_go_forward` | `mcp_tools.rs` | — | history navigation |
| `browser_wait_for` | `mcp_tools.rs` | — | poll until text is visible, or time out |
| `browser_tabs` | `mcp_tools.rs` | — | list live workspace tabs and active tab |
| `browser_new_tab`, `_select_tab`, `_close_tab` | `mcp_tools.rs` | — | open or select a workspace tab; close only tabs this session opened |
| `browser_reload`, `_scroll` | `mcp_tools.rs` | — | reload with optional cache bypass, or scroll the page or a referenced element |
| `browser_console_messages` | `mcp_tools.rs` | — | bounded, filtered console messages labelled untrusted |
| `browser_local_servers` | `core/houston-core/src/browser_relay.rs` | — | discover local servers belonging to live workspace sessions on Linux |

Browser schemas and relay routing live in the daemon. The native page operations run in
Tauri against the credential workspace's live surfaces. The app explicitly registers its
relay connection after authentication; ordinary renderer connections receive no tool calls.
Only pending calls belonging to a disconnected connection fail. With no registered relay,
page operations fail immediately. Local server discovery runs directly in the Linux daemon.

Page tools accept an optional `tabId`. Explicit ids must be live in the caller's workspace;
refusals list its available tab ids and URLs. Without an id, the active live tab wins, then
the most recently registered live surface. Capture, tab selection and the five confirmation-gated
acts reveal the target. Reads (current page, snapshot, console messages, wait and tab listing),
navigation, history, reload and scroll on existing surfaces preserve the selected workspace
and panel, including when the target is hidden.
Opening a tab uses a host-selected id and waits for that exact surface to register.

All five element acts (`browser_click`, `browser_type`, `browser_hover`,
`browser_press_key`, `browser_select_option`) pass the human confirmation gate. Read tools
are ungated. Reload, scroll, new, select and close follow the ungated navigation policy:
they do not address form controls or insert text. Close is restricted to tabs opened by the
calling session, so it cannot discard the user's existing tabs. Reload can repeat a page
request; agents must use it only when the user's task requires it. Console messages are
untrusted page content, bounded to 256 entries of 4096 characters per surface. Main-world
capture includes console calls, uncaught errors and unhandled rejections on Linux;
`browser_console_messages` refuses other platforms by name.

`pane_spawn` takes `kind` (`claude | codex | antigravity | opencode | cursor | grok | zcode`), `prompt`,
and optional `model`, `cwd`, `target_workspace`, `worktree`, `branch`, `reusable`, `handoff`, `state_doc`, `effort`,
`auto_approve`, `profile`, `role`, `output_format`, `boundaries`. `target_workspace` must match a registered
workspace after canonicalization, and `cwd` must remain under that root. `reusable` defaults
to false for new API spawns; legacy delegation rows migrate as reusable to preserve their
prior behavior. `effort` is provider-validated at the launch boundary.
`handoff: true` opens a top-level pane instead of a child: no `spawned_by`, no delegation
row, so no handback, cleanup or live-children guard on the caller's close. It bypasses the
child and depth caps, so it is refused from any pane that has a parent, and with `reusable`
or `output_format`, which only mean something to a parent. Orchestration must still be on.
`pane_submit` takes `body` and optional `summary`, `artifacts`, `request_id`. A pane nobody
spawned has nobody to submit to and is refused; a harness review run's refusal names
`harness_publish` instead.

Reports and replies use the inbox without treating an intermediate question as a
handback. Their round must still be open; Codex steer can reconcile the pending
request header without a new prompt hook, using the same rule as submit. A question
remains unresolved after delivery. Only its recipient, with recorded ancestry over
the worker, can answer it. The answer and resolution share a transaction with the
retry receipt, so transport loss cannot duplicate an answer or leave a committed
message behind a permanently pending receipt. Receipt lookup precedes current-round
validation, allowing a successful answer to be retried after the round closes.

Delivered unanswered questions remain eligible for ancestor rerouting and count
toward the worker's pending-report limit. Rerouting compares the observed recipient,
reservation, delivery and attempt state before releasing a lease; an old failure
cannot erase a newer delivery. An ancestor's ability to answer inherited questions
is independent of its ability to spawn. Replies keep the original question id in
`reply_to`, rather than in a reason that recovery may replace. Round changes close
obsolete dialogue; retention removes resolved messages even if they were never
delivered, while preserving unanswered questions.

The `task_*` tools are the one non-pane family: they reach every top-level pane and no
child, whatever the orchestration switch, and the workspace's Settings ▸ Tasks access
decides advertisement and enforcement together (`off` withholds every task tool, `read`
withholds the writes). An agent's write is attributed `agent:<codename> (<role>)` in the
task's history, comments and `created_by`, so the provenance outlives the pane. A change to
the access setting pushes `tools/list_changed` at that workspace's open tool lists. Task
text in a tool result is wrapped as labelled untrusted data and each text field is capped by
`mcp_tasks::TASK_TOOL_TEXT_MAX`.

Agents list and read the whole global backlog. Writes are limited to tasks of their own
workspace and unassigned tasks; another workspace’s task is refused naming its key,
workspace and the rule “tasks of another workspace are read-only to agents”. Task keys
resolve globally, and per-workspace access gates the caller rather than the task.
`task_execute` and queue starts require tasks assigned to the orchestrator’s workspace.

`task_claim` assigns an unassigned task to the caller’s workspace and binds the calling pane as the task’s run (a `backlog_task_runs` row with that
session and no worktree), and `task_handback` finishes it, so a pane that merely claims
follows the task exactly as a Started one does, including the pane-exit interruption and the
one-live-run rule. The run's `reason` is the surface for a failure the pane did not cause
(an interrupted daemon or an unavailable `gh`), and its `initial_revision` is the drift
guard: a task edited during the run says so in the handback comment. A task brief is
composed by the daemon — task text between explicit data markers under
`TASK_BRIEF_MAX_BYTES` — and handed to the pane by `HOUSTON_TASK` plus either a submitted
prompt or a bracketed prefill, never by transcript scraping.

`task_execute` and `task_review` are the two verbs that open a child, so they follow
`pane_spawn`'s advertisement rule and count against `orchestration_max_live_children`;
settled children do not count, and a refusal names the cap, its value and the task.
`task_execute` starts the task through the orchestration spawn path with a delegation, so
the child's `pane_submit` settles the run: Houston parses one trailing single-line JSON
object, `{"task_result":{"status":...,"summary":...,"checks":[...]}}`, ticks the acceptance
items whose names match, writes the summary as a comment (with the drift marker when the
task's revision moved since `initial_revision`) and moves the task to in review. The same
settlement parses `{"task_review":...}` from a reviewer run. A missing or malformed line
never guesses: the run becomes `needs_review` and keeps the raw text as its summary. The
inbox row is unchanged, so exactly-once delivery is untouched. A reviewer's pass comments
the verdict and leaves the task in review for the user; a fail comments the findings, marks
the implementation run `needs_review`, and — when the workspace's `tasks_rework_rounds`
is above zero — opens attempt N+1 with the findings appended as labelled data until
`TASKS_REWORK_ROUNDS_MAX`. `TaskRunAction::retry` is the same attempt N+1 by hand. The
reviewer runs in the implementer's worktree once that run settled and in a detached tree of
the same branch while it is still running; its boundaries text says read-only, report
evidence, never mark Done.

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
| `TASKS_REWORK_ROUNDS_MAX` | 5 | automatic rework rounds a failed review may take per workspace: a reviewer-and-implementer pair must cost a bounded number of agent runs |
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
debounces the composer hold, `STOP_INBOX_QUERY_MS` (250) bounds door 2's reserve query and
`STOP_INBOX_CONFIRM_MS` (250) gives its post-stdout confirmation a separate budget,
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
| Claude Code | `--mcp-config` with inline JSON, added to the user's own servers. No `--strict-mcp-config`: it would make the argv config the only source and suppress the user's `mcpServers`, their project's `.mcp.json`, their plugins and their connectors |
| Codex | repeated `-c key=value`, with the token read from `HOUSTON_MCP_TOKEN` so it stays out of argv |
| OpenCode | `OPENCODE_CONFIG_CONTENT` (its own config-content env var) with a `remote` `mcp` entry; not live-verified, built from `https://opencode.ai/config.json` |

Env constants: `HOUSTON_MCP_TOKEN`, `HOUSTON_MCP_URL`, `HOUSTON_MCP_CONFIG`.

With shell integration enabled, a hand-typed `claude` in a bash or zsh shell pane uses a shell
function that passes the pane's `HOUSTON_MCP_CONFIG` through `--mcp-config`. Without
that variable, it runs `claude` unchanged. On Unix, boot removes the old user-scope
`houston` entry only when its URL and sole Authorization header have the exact
placeholders Houston previously wrote. It invokes `claude mcp remove --scope user houston`
and leaves every other entry alone. Windows PowerShell and cmd panes have no shell
integration, so Windows retains the placeholder registration for hand-typed `claude`.
An agent pane's inline configuration takes precedence over that Windows entry.
Codex gets the same user-scope entry through
`codex mcp add`, holding the literal endpoint (Codex expands no placeholders) and the
token's env-var name, refreshed each release-channel boot because the port is ephemeral.
Grok has no per-spawn `mcp_launch.rs` mechanism at all, only this persistent one:
`mcp_register_grok.rs` runs `grok mcp add --transport http houston ${HOUSTON_MCP_URL}
--header "Authorization: Bearer ${HOUSTON_MCP_TOKEN}"`, verified against
`docs.x.ai/build/features/mcp-servers`; live authentication remains unverified.
Grok's own `config.toml` expands `${VAR}` in both `url` and `headers` (unlike
Codex's, which never expands `url`), so this entry holds `${VAR}` placeholders
and is never refreshed once written — there is no literal port to go stale.
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
Grok's entry uses. Placeholder expansion remains unverified.
`google-antigravity/antigravity-cli` issue #25 reports the
`headers.Authorization` bearer is accepted by the schema but silently ignored by the
CLI's own HTTP MCP transport at runtime. Live authentication remains unverified.
ZCode has no MCP command or per-launch flag, and its user `mcp.servers` entries expand no
variables. Its plugins do (`packages/adapters/src/plugins/mcp.ts`): a URL expands only
`${ZCODE_*}` names, headers expand any variable. Houston therefore owns a plugin directory
in the channel's state dir, named `houston` or `houston-<channel>`, whose one HTTP server
reads `${ZCODE_HOUSTON_MCP_URL[_<CHANNEL>]}` and `Bearer ${HOUSTON_MCP_TOKEN}`, and lists
that directory in `plugins.dirs` of ZCode's settings file alongside the hook entries.
A ZCode pane, or a shell pane that may run ZCode, receives only its own channel's URL variable, so another channel's plugin
fails variable resolution there and registers nothing; no port or token reaches disk. The
plugin is written and listed with the ZCode hook toggle and removed with it.

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
value per flag name, so a repeated flag would silently keep only the last. `hs-task` follows
the same shape for the backlog: its wrapper sits beside `hs-pane`, the `/task/*` routes carry
the `task_*` verbs over plain HTTP, and each command lands on the daemon path the MCP tool
uses.

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
can keep naming a result after temporary settlement ends the process.
`kind` is one of `InboxKind`: `result` (a `pane_submit` body), `no_handback` (a turn ended
with nothing submitted), `needs_input` (urgent), `exited` (urgent, the child's process is
gone), `stalled`, `operator_note` (the operator ended or interrupted the child), `mail`
(a swarm-scope message addressed to a pane's label), and worker `progress`, `question`,
`blocked` and `reply`. `needs_input`, `exited`, `question`, `blocked` and `reply` are urgent,
and they bypass every batch window. Swarm mail between siblings remains agent-to-agent
traffic. A top-level pane may address the operator; delegated children hand results to their
orchestrator and its live ancestors.

Three timestamps, three words: `created_at` is **persisted**, `delivered_at` is **sent**,
`confirmed_at` is **proven**. What "sent" is worth depends on the door:

| door | sent means | proof exists? | retention counts from |
|---|---|---|---|
| `wait` | returned inside the tool result of a live turn | no mechanism; final | `delivered_at` |
| `stop_hook` | the helper printed it and the CLI accepted the hook's stdout | no mechanism; final | `delivered_at` |
| `paste` | bytes reached the PTY | yes, the parent's own prompt hook | `confirmed_at`, or the seven-day unconfirmed cap |
| `operator` | opened in the renderer | yes, the ack | `confirmed_at` |

`confirmed_at IS NULL` is therefore never read as "failed" on its own; the door says.
Delivery is never claimed exactly-once. A message's identity is `pane_inbox.id`, stable across
attempts and printed with every delivered entry; `delivery_id` names one attempt and
changes on every reservation. `attempts` counts delivery attempts by any door — every
reservation, not only door-3 pastes — which is what lets door 2's "possibly delivered
before" note and door 3's re-address threshold share one counter. A duplicate after a retry
is recognisably the same message under a second delivery id, and a stale confirmation from
an earlier attempt cannot mark a later body. Stop-hook reservations expire after
`INBOX_RESERVATION_MS`. Active HTTP bodies and PTY
writes pin their reservations until completion or cancellation, so a slow writer cannot
lose its row to another door. Boot releases all reservations. Unconfirmed paste attempts
expire after `UNCONFIRMED_PASTE_MAX_MS` (seven days), counted from the first attempt across
restarts; this also bounds providers whose prompt fixture carries no receipt text.

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
lost — the DB is the truth, the notify is only a hint to re-check it sooner. Reserved
rows remain undelivered until the response body consumer completes the final frame.
Dropping a queued frame or an incomplete body releases its reservation. Disconnects cancel
through the response sender's closed signal; `notifications/cancelled` cancels the matching
request in the caller's scope. This applies to SSE progress responses and plain JSON waits.
Body completion is a server-side transport boundary; it cannot prove that the client
application or model read the bytes. MCP returns each body once in textual content;
structured rows carry metadata and omit `body`.

Zero tokens are spent while blocked. After spawn, agents must wait instead of polling
`pane_get`, `pane_read` or `pane_list`; those are diagnostics after a timeout, for help,
or at the operator's request. Timeouts are bounded by `DEFAULT_WAIT_TIMEOUT_MS`, below
Codex's tool timeout. A whole-inbox wait with no live children or pending rows returns
`nothing_to_wait_on` immediately.

Rows come ordered by `created_at, id`, capped at `INBOX_BATCH_MAX_ROWS` /
`INBOX_BATCH_MAX_BYTES` with `has_more: true` when cut. A `kind` filter never hides urgent
rows for a waited child. A new wait supersedes an active wait, which returns `superseded`.
A batch already returned for transport delivery remains reserved until that sender confirms
or releases it; its confirmation cannot remove a replacement wait. Releasing an in-flight
batch wakes the replacement waiter to retry. Gateway `call_tool` refuses `pane_wait`: the
agent must call it directly so the streaming path can acknowledge delivery.

A result staged during a working turn is released when the round closes, including an
intentional cancellation. `pane_get` exposes `result_staged_age_ms` for a result that
has not become eligible; no age-based automatic release is applied.

Claude's Stop reports with running background tasks hold an unstaged round open and
prevent stall notices. `pane_get` names the hold as `background job running (N)`. A Stop
with zero jobs removes the hold. After `BACKGROUND_HOLD_MAX_MS` (45 minutes), the daemon
releases a stored result or emits one `no_handback` naming the bound and elapsed time.

Delegation registration precedes PTY creation, and a failed spawn removes its spawning
record. An in-flight reservation protects the parent and counts against child caps and
role uniqueness while worktree creation runs outside the cleanup lock. Failure rolls
back the reservation. PTY startup and registration remain under the cleanup lock. Operator keystrokes record composer
occupancy immediately and defer cleanup cancellation to the watcher when that lock is
busy, so unrelated terminal input does not wait for a spawn.

`pane_prompt` defaults to `mode: "queue"`: it applies the same status and
operator-composer hold as inbox pastes. Acceptance and its retry receipt retain the
instruction body atomically before any terminal action. Each target origin admits
sixteen active instructions; the channel retains at most 4096 bodies of 64 KiB each.
Pruning removes only terminal history. Request numbers are assigned under dispatch
serialization, and start/adoption evidence prevents an old idle event from dispatching
the next instruction. Before the first prompt hook, dispatch uses the spawn's reserved
initial request; its start and completion must still release the next queued instruction.
A retry returns the same instruction's current state. Sessions without retained
instructions do not emit queue updates for ordinary lifecycle events.

Untouched instructions become held after recovery. Explicit resume validates the
target origin, provider, directory, profile and conversation. A write-ahead marker
precedes PTY input; partial writes, withheld Enter and ambiguous crash recovery become
uncertain and block replay. Delivery records the complete prompt and Enter writes;
provider start or named request adoption confirms processing. Full instruction bodies
are read only on explicit inspection; snapshots
carry bounded previews. `steer` permits a paste while the provider is working;
`restart` sends the provider's interrupt key while working and queues delivery
until authoritative idle. Both immediate modes refuse an operator draft,
needs-input, or an occupied wake lane before writing. The composer and
needs-input guards are rechecked before paste and before Enter. A partial or
unsubmitted paste creates a note for the sender and is never retried automatically.
Windows Codex submission waits for its paste-buffering window before writing Enter.
The same delay applies to first prompts, instructions, inbox wakeups and phone input;
the delay never establishes status or authorizes input at a permission prompt.
Restart or a superseding request releases an old staged handback as partial with its
body retained. A pending replacement prevents temporary child cleanup.
Queued prompts retain their sender; a dead sender's nearest live ancestor inherits
the note, or the operator receives it when no ancestor is live.

Restart supports Codex's default Escape binding and its documented
[Interrupt hook](https://learn.chatgpt.com/docs/hooks#interrupt), mapped to idle.
Grok 1.0.13's bundled hook documentation specifies `StopCancelled` for user
interrupts, including Ctrl+C with an empty composer; that event maps to idle.
Claude is refused: its native mod can report interruptions on supported launches,
but a live key-to-interrupt restart contract has not been verified. Its
[Stop hook](https://code.claude.com/docs/en/hooks#stop) excludes user interrupts.
OpenCode is refused: the root `session.idle`
fixture proves normal idle, not interruption; its installed TUI uses an Escape
counter before abort, without a captured or documented interrupt-to-idle contract.
Cursor and Antigravity have no verified interrupt/idle pair and are also refused.
Custom remapped interrupt bindings are not detected; supported providers must
retain their default binding for restart delivery.

Optional `client_request_id` keys for spawn and prompt are shared by HTTP, MCP and
`hs-pane`. Keys are scoped to the calling pane and admit 1–64 ASCII letters,
digits, dots, underscores and hyphens. The daemon stores only an argument digest
and the recorded success in SQLite; prompt receipts additionally retain their durable
instruction identity and body. Defaults and normalized request fields are applied
before hashing. Matching spawn retries return their original outcome; prompt retries
return the retained instruction's current delivery state;
a different operation or argument set is refused with the key's name. Reservation
precedes the mutation and completion precedes the response. A refusal before the
action discards its pending receipt, so a retry can act after a cap, input or busy
condition clears. Errors after a process, checkout, queued prompt or PTY write may
have acted preserve the pending receipt. A crash between reservation and completion
leaves a pending receipt; retry is refused with an uncertain-outcome message rather
than repeating a possibly successful mutation. Receipts expire after seven days;
at most 4096 remain across the channel, evicting oldest completed receipts first.
The retry mutex precedes temporary-cleanup and session/delivery locks; receipt DB
locks are released before entering spawn or delivery. No cleanup, hook or wake
path acquires the retry mutex. Spawn releases temporary-cleanup during checkout
creation and reacquires it for registration while retaining the retry mutex.
A full set of pending receipts refuses new keyed calls until expiry. An expired
or evicted key is a new request.

### Door 2: the synchronous `Stop` hook

A parent that is still `Working` never gets a paste — door 3 only fires once it settles —
so its own `Stop` hook is the seam: the helper asks `POST /inbox/reserve` for rows
addressed to its session and, if any, prints the provider's continue shape and exits 0. The
CLI splices the text into the same turn instead of ending it. `POST /inbox/delivered
{delivery_id}` afterwards marks the row `delivered_via = 'stop_hook'`; a failed confirm
just lets the reservation expire, leaving the row eligible again.
`orchestrate::door2_continue_json(provider, text)` is the one place that shape lives,
`None` for a provider door 2 does not serve — Grok, OpenCode and Cursor stay on door 3.
Claude, Codex and ZCode print `{"decision":"block","reason"}` (Codex's `~/.codex/hooks.json`
`Stop` hook takes the exact same shape, verified live on 0.153.4; ZCode's is read from its
`hooks/output.ts`, which also caps continuations at three, matching
`STOP_BLOCKS_PER_TURN_MAX`); Antigravity prints
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
  anything else — including a backend that cannot say — is `reason = 'partial: …'` and remains with
  its live parent through `pane_wait`, without further automatic delivery. The same
  rule applies after `PASTE_ATTEMPTS_MAX` proven-zero attempts. A dead parent's nearest
  live ancestor inherits the row; only the absence of a live ancestor reaches the operator.

The framing's first line carries the `delivery_id`. For providers whose prompt hooks
include text, the next prompt hook whose prompt head carries that exact id sets
`confirmed_at`; payloads without prompt text cannot provide this confirmation.
A partial paste keeps a durable receipt associated with its row. If the operator submits
that complete receipt header from the composer, the prompt hook resolves the wait-only row
before a later wait can deliver it again. An incomplete header provides no such proof.
A database failure after submitting Enter makes the row wait-only with the failure reason;
automatic delivery cannot blindly repeat the submitted paste.
Held wake lanes back off to 640 ms between checks and stop after a 30-second hold, reporting
undelivered text to its sender. Durable inbox rows remain available through wait. Ended
sessions stop their lanes immediately. Session state is never held while writing to a PTY;
Unix teardown interrupts its active counted writer before releasing the handle.
`PASTE_CONFIRM_MS` counts from the submitting `\r`, not from enqueue. Delivery ids use
compact lowercase hexadecimal so prompt redaction preserves the receipt while still
removing bearer UUIDs.

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

**Codex automatic approval reviews.** `PermissionRequest` in Auto mode precedes
approval processing, so an unresolved request is not evidence of a human prompt. The
session stays Working with `hold_reason: auto-review in progress` until matching tool
completion resolves the episode. After five minutes the hold reads
`stalled? approval_outcome_unobserved`; this is an uncertain diagnostic, not a human prompt. `request_user_input` remains an urgent needs-input
event. A native approval prompt after reviewer denial has no distinct verified hook in
the installed CLI; it cannot be inferred from elapsed time or terminal text.

**Tool-boundary context (door 2b).** Claude and Codex `PostToolUse` command hooks can
return `hookSpecificOutput.additionalContext`. The hook queries the authenticated daemon
for bounded, once-per-row needs-input hints. This does not consume the durable row, block
the parent's turn or paste into a Working terminal. Antigravity, OpenCode, Cursor and Grok
rely on the operator channel for immediate attention and their existing idle delivery.
Post-tool context queries run after the lifecycle drop is written. Each pane receives a
local signal path at spawn; the signal is created when it first hosts a child, including
children spawned after orchestration is enabled. Panes that have never hosted children
skip the daemon round trip. The signal carries no prompt or result content.

Verified output contracts: [Claude hooks](https://code.claude.com/docs/en/hooks#posttooluse)
and [Codex hooks](https://learn.chatgpt.com/docs/hooks), also present in the installed binaries.

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

Over `INBOX_PENDING_PER_PANE_MAX` a row remains addressed to its live parent, naming
the limit, count and row in its reason. Backlog, exhausted paste attempts and partial
paste disable automatic Stop-hook and paste delivery for that row; `pane_wait` can
still deliver it with the reason. A full prompt wake lane reports to the prompt sender.
A failed insert is returned to the producer with the body's size and caps.

### The operator inbox

Rows addressed to a dead pane go to its nearest live ancestor orchestrator, keeping
`original_to`, `workspace` and `reason = 'parent_dead'`. Only when no ancestor is live
do they reach `to_session = 0` (the operator). Restart recovery uses the same rule.
The operator inbox is a **workspace** surface,
not a pane surface: the pane may be gone, so `inbox_list{workspace}` answers rows by the
workspace they came from. The wire carries `InboxList { workspace }` → `inbox_rows`,
`InboxAck { id }`, `InboxResolve { id }` and `SessionInfo.inbox_unread`; clients can
request the list after reconnecting. **Read is not resolved**: `inbox_ack` sets
`delivered_via = 'operator'` and `confirmed_at`; only an explicit resolve (or the block
ending) sets `resolved_at`, because reading about a blocked child does not unblock it. Children keep
running. Retention is `INBOX_OPERATOR_MAX_ROWS` for confirmed rows, never for unconfirmed
ones or unanswered worker questions. A delivered unanswered question reopens for
delivery to its new recipient when the parent dies. The overview shows genuine operator rows in "Addressed to you" and hides that group when empty. Child warnings and delivery failures with a live ancestor remain in the orchestrator inbox.

### Restart and migration

The migration from legacy staging columns moves each `staged_result` into a `Result` row
with `ready_at = now` and `reason = 'migrated'`, then removes the columns in the same
transaction. An already-migrated database is unchanged. Recovery at boot is idempotent, so two
restarts produce one state, and it runs **after** restore:

1. Open delegations become `unknown`; a restart alone does not prove success or failure.
2. The restore policy brings parents and their open children back through valid Claude
   and Codex resume handles, rebinds session IDs and inbox recipients, and writes exactly
   one `restored` notice per parent. Its JSON array names role, child, provider and whether
   the conversation resumed, with a reason for each outcome. Successfully resumed children
   enter `working`: their mission is live again, while `unknown` describes an interrupted
   mission whose process has not resumed. Children of deferred parents inherit the visible
   deferral and resume through the same policy when the parent is manually respawned.
   Rebinding updates every inbox reference to the current session generation in one
   transaction, so a later ancestor reroute still closes the original delegation round.
   Unsupported children remain ended; settled children remain
   archived. A child without a valid resume handle never starts a bare replacement CLI.
   Shell-hosted recovery reserves the parent's lifecycle while provider preparation runs
   outside the hook drain and global cleanup lock, so unrelated panes remain usable.
   Parent exit is checked around each launch; a replacement whose parent exited is closed.
3. `db::inbox_recover_after_restart` runs against the live set restore actually brought
   back, not the empty roster boot started with — a respawned husk keeps its own rows
   addressed to it instead of re-addressing them to the operator on the strength of an
   empty live set. It releases every reservation; puts `paste` rows sent and unconfirmed
   back to pending (the paste may or may not have landed; the row keeps its attempt count);
   puts unacked `operator` rows back to unread; leaves `wait` and `stop_hook` rows final and
   untouched; and re-addresses rows whose `to_session` did not survive to the nearest
   live ancestor, or the operator if none remains, with `reason = 'parent_dead'`. A row is never auto-pasted into a process that is not the one
   it was addressed to: a restored pane's pending rows wait for its first
   `UserPromptSubmit` (the operator is there) or go through door 1 when it asks.

## The delegation record

Every spawn opens a row in `delegations` (one per child, keyed uniquely by child
session) carrying the brief, the lifecycle state, and the request counter. What the child
hands back is NOT here — it is a `pane_inbox` row addressed to the parent. The states are
`spawning -> working <-> asked_orchestrator | needs_input`, closing at
`done | failed | cancelled | unknown`. Input ownership distinguishes the two waiting
states without replacing the provider's reported `AgentStatus::NeedsInput`.
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
Settlement persists scrollback and ends a temporary child's PTY while retaining its
session and resume handle. Done-and-idle reusable children stay live but no longer consume
a child slot. Both carry settled and retained-until timestamps. The existing delegation
watch loop removes expired settled children after `SETTLED_RETENTION` (24 hours by default,
configured through daemon settings). Ordinary idle reaping skips retained delegations.
Explicit close and parent close remove the retained sessions.
Continue carries the retained scrollback into the replacement PTY before its reader starts,
so stream offsets and the earlier transcript survive. It uses the existing resume machinery
for Claude and Codex; other providers are
refused by name. A new request clears the previous settlement and retention timestamps.

Role routing is stored per registered workspace and exposed through `workspace_info`.
The seeded skill consults ordered role-pattern routes for model and effort selection;
explicit operator choices take precedence. Handoff state is bounded UTF-8 text or a
workspace-contained file and becomes part of the independent pane's brief.

Closed records carry `ended_at`; done and unknown records reopen only on a fresh
turn start. Failed and cancelled records normally describe an ended process and
refuse prompts. A provider API-failure hook is the live-process exception: its
failed delegation carries `stop_reason`, its staged result remains withheld, and
its parent receives one urgent `operator_note` per round. Duplicate failure drops
and later idle events do not settle or clean up that child. A fresh prompt into
the live child reopens the record to working through `delegation_reopen`, clears
the failure reason, and opens the next request. Failed children continue occupying
child slots until explicitly ended or resumed.
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

**Quiet-settle** is the third named exception to "PTY content is not a status machine"
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
pane's live children have user-owned input requests, derived in the daemon — never reduced
client-side), and `inbox_unread`. `ServerMsg::DelegationChanged { session, delegation }`
carries one child's whole record and fires from every seam that writes it — the spawn that
opens it, `advance_delegation` (hooks and ACP both reach the row through it), a submit, a
round close, the stall flag on BOTH edges, the quiet-settle close, a cancel, and a child's
exit. Stalled flags do not increase the human-input count. One `pane_inbox` row's own changes ride `ServerMsg::InboxChanged` instead, which
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

One alarm identifies input owned by the user. Asked orchestrator is neutral even when
the provider reports needs-input. A user-owned request uses `--warn` and displays its
escalation or permission reason. A stalled child remains ongoing work
with a static warning dot; silence alone does not place it in Needs you. A live child’s
Done or Failed verdict also controls its dot and label. Reported human input and
waiting descendants take priority over that verdict. On the
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
hold reason (`hold_reason`, covering pending delivery, background work or automatic
approval review). The card
renders an "owed" row, the last result's state (a corrected result struck
through with its correction, a provisional one marked), the capability
sentence, and a "waiting" row with the hold reason in the daemon's words —
without which the hold would be a one-way door the operator cannot see.

## Role-scoped advertisement

A pane's tool list is its role. A leaf child —
spawned by another pane, unable to spawn, with no managed children of its own —
keeps `pane_submit`, `pane_report`, `pane_reply`, `pane_wait` and `workspace_info`:
its handback, intermediate dialogue and identity. The `task_*` tools are withheld from every child, not only a leaf:
a child's scope is the brief, so its provider checks parentage before access
and its direct calls are refused the same way. An orchestrator — one that may spawn,
has managed children or owes an answer to an inherited question — sees
the management verbs, with `pane_spawn` only while actually spawnable (out of
slots keeps the rest; only the spawn verb drops) and `pane_submit` only with
a parent to hand back to. `pane_reply` remains advertised to every role, including
after the last inherited question is resolved, so retries can reach receipt lookup.
The daemon still enforces recipient, ancestry and request checks. An operator-opened
pane with the switch off and no managed children sees only this reply verb from orchestration.
Retained ended children keep their parent's management authority until explicitly closed
or removed by retention; cleanup does not depend on spawning remaining enabled.
The gate lives in `ToolRegistry::list`, which
merges every provider, so browser, mail and routine tools are filtered for a
leaf with the rest; the rule itself is one pure function
(`orchestrate::tool_role`), fed by `Daemon::tool_role_of`.

Advertisement is not authorisation — except for a leaf, whose hidden tools
are also refused at `tools/call` (every tool hidden there is one the leaf
could never use and pays for on every turn). The switch gating stays
advertisement-only: a child whose operator turned orchestration off can still
call the dialogue tools it keeps. The Codex gateway's `call_tool` enforces the same
predicate, so a leaf Codex pane cannot bypass the gate through the meta-tool;
its `list_tools` still serves the full catalogue, listable-but-not-callable.

A tool Codex's own Auto-mode approval rule would never gate (read-only, or
local and not open-world — `mcp_server::codex_requires_approval`) is listed
directly in `tools/list` by its own name and schema instead of behind
`call_tool`, so a Codex caller spends no approval round-trip on it; a gated
tool named directly is refused, naming `call_tool` as the way to reach it.

**No string beside another scalar type.** A tool property's `type` names one value type,
plus `null` where null means something, and no `oneOf` or `anyOf` offers a string beside
an integer, number or boolean. GLM, which ZCode drives, writes a string argument unquoted
when the property's type is a union such as integer or string; ZCode cannot parse that
call and drops the argument before validating it. A task `id` and `pane_pr_watch`'s `pr`
are therefore strings, and the daemon still accepts an integer for either. `pane_spawn`'s
`state_doc` is text or an object; how GLM fills that union has not been observed.
`no_tool_property_unions_a_string_with_a_scalar_and_a_task_id_reads_in_every_form` checks
every advertised schema.

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

## Child input ownership

Input ownership is durable and independent of provider status. Native episodes and
reported questions retain stable identities until resolution; delivery alone never
resolves them. Parent-owned requests project Asked orchestrator. User-owned requests
project Needs you and alone contribute to `children_waiting`. Renderer snapshots include
the current identity and reason, allowing ownership changes to alert once even when the
raw status remains NeedsInput. A child raw-status update received before its ownership
projection remains neutral.

`pane_escalate` transfers the current unresolved request to the user under the same
cleanup guard used by input delivery. Authoritative accepted Stop/ACP turn completion
escalates unanswered parent-owned requests. Continued Stop and internal-subagent-held
events have not ended the turn. Quiet-settle is excluded because terminal silence cannot
prove the orchestrator finished handling a question. Parent close/death also escalates;
existing ancestor routing and the operator inbox remain available when a parent is lost.
Closing a parent retains its existing child-close semantics.
An escalated question rejects parent `pane_reply` and `pane_send_keys` responses;
the operator answers in the child terminal. Reply ownership is checked against that
question's episode, allowing the parent to handle other requests without reclaiming
the operator's decision.

Houston classifies from supported structured signals, never action names or terminal
text. Every actual question, blocker and permission wait starts parent-owned in all
launch modes. Its actionable `needs_input` inbox row identifies the input episode and
includes a bounded snapshot when available. Delivery does not resolve the episode.
Parent ownership stays gray; explicit or safety escalation transfers ownership to User,
with amber status and notifications. Input episode ids differ from worker `request_id`.

| Provider or source | Waiting evidence | Verified denial or refusal |
|---|---|---|
| Claude | `PermissionRequest`; typed `Notification.permission_prompt` | Escape with the default permission cancel binding. Custom rebinding is refused. `AskUserQuestion`, `ExitPlanMode` and elicitation are questions. |
| Codex | Permission request outside Auto, or typed waiting notification | Escape cancels the approval overlay and may interrupt the turn. A bare Auto `PermissionRequest` is approval activity, with no input ownership or alert. `request_user_input` is a question. |
| OpenCode | `permission.asked` / legacy `permission.updated` | Unsupported: root and native child permissions share pane input, and Escape depends on permission/reject/always stage. Event evidence does not prove which stage receives the key. Question events remain parent-owned questions. |
| Cursor | No needs-input signal | Unsupported. A missing badge cannot prove the pane is working or awaiting permission. |
| Grok | Typed `Notification.permission_prompt` | Ctrl+C cancels the permission; Escape is not a verified denial. Elicitation and unclassified blocking notifications remain parent-owned. |
| Antigravity | Blocking `PreToolUse.ask_permission` / `ask_custom_permission` | n without Enter for the verified default prompt. Refuse when the default input contract cannot be verified. `ask_question` is a question. |
| Supported ACP stream | `session/request_permission` | Unsupported response path: Houston observes the stream but does not answer ACP permissions. |
| Houston report | `pane_report` question / blocked | Parent answers through `pane_reply`; a reply cannot approve a native permission. |

Denial bindings are verified against the live provider process on Linux. Claude uses
`~/.claude/keybindings.json` or the launched `CLAUDE_CONFIG_DIR`; a custom bindings
file refuses denial. Grok's custom-binding guard checks `~/.grok/keybindings.json`.
Antigravity's documented default `confirm.no` is n and its customization file is
`~/.gemini/antigravity-cli/keybindings.json` ([keybindings reference](https://www.antigravity.google/docs/cli/using/#keybindings));
Houston refuses custom bindings rather than adding Enter or choosing a default button.
Codex Escape and Grok Ctrl+C can interrupt the turn while denying. On other platforms,
effective process bindings cannot currently be verified, so `pane_deny` explicitly
refuses and directs the parent to `pane_escalate`. An agent adopted inside a shell also
refuses denial when its effective provider configuration cannot be verified.

The parent NEVER approves a permission, including in Ask mode. `pane_send_keys` refuses
ALL keys for any pending permission under the ownership/cleanup guard, naming the child,
episode and “use pane_deny or pane_escalate; only the operator may approve”. Question
keys remain available within existing authority. `pane_kill` and inbox management remain
available for inherited descendants even when spawning is disabled.

`pane_deny{child,episode_id}` verifies the exact current episode and provider path before
sending bytes. It never adds Enter or sends a default selection. A successful write
leaves the episode pending until matching provider completion or an authoritative
boundary resolves it. Stale ids, non-permissions, user-owned episodes, unsupported paths
and unverifiable bindings refuse. `pane_escalate.reason` records the parent's recommendation
in `escalation_detail`; prose or a mailbox reply alone cannot transfer ownership.

Permission metadata stores only bounded, redacted provider evidence. `command` and
`block_reason` use tagged `ProviderReportedText`: `reported{text}` or
`not_reported{provider}`. Missing evidence remains explicitly unreported; terminal reads
and action names cannot fill these fields. Accepted direct renderer input records an
intervention for the parent at provider lifecycle evidence, with an answer only when
structured provider data reports it. Terminal bytes remain ordinary PTY input.

## The provider table

Every provider gets the same six answers. "Works perfectly" cannot mean identical
mechanics — the six CLIs expose different hook surfaces — so the table records what each
one actually reports, and a missing capability is named, never silent. Fixtures for every
provider's captured payload shapes live under
`core/houston-core/tests/fixtures/hooks/<provider>/` with the CLI version in the file
name.

| | Claude | Codex | Grok | OpenCode | Cursor | Antigravity (`agy`) |
|---|---|---|---|---|---|---|
| **Turn end** | `Stop`; main-loop mod `turn.complete.isAborted` for interruptions | `Stop` (hooks.json; `notify` retired) | `Stop` | `session.idle` for the root session only | `stop` (`status`, `loop_count`) | `Stop` (`fullyIdle`, `terminationReason`) |
| **Last message** | `Stop.last_assistant_message` | `Stop.last_assistant_message` | not in payload: capped tail | plugin reads `client.session.messages` at idle | `afterAgentResponse.text` | not in payload; every payload carries `transcriptPath` (the CLI's own JSONL), read the last assistant entry there, never the screen |
| **Needs input, with reason** | `PermissionRequest.tool_name` + typed `Notification` | `PermissionRequest.tool_name`; `PostToolUse` resolves the matching permission episode | `Notification` (`permission_prompt`, `elicitation_dialog`) | `permission.asked` (`permission`, `patterns`); also subscribed `permission.updated` for older builds | **none exists**: stall row, named in `pane_list` | `PreToolUse` (matcher dialect) for `ask_question` / `ask_permission` / `ask_custom_permission` with no `PostToolUse` yet; `toolCall.args.questions[].question` is the reason |
| **Sub-agent vs child** | the round rule above | `SubagentStop` is separate; main `Stop` fires once, parent stays busy | `SubagentStart`/`Stop` separate; `spawn_subagent` blocks the parent by default | child is a session with `parentID`; plugin maps ids from `session.created`, parent stays busy | `subagentStart`/`Stop` carry `subagent_id`, `parent_conversation_id` | sub-agent is a second `conversationId` firing the same hooks; the parent's own `Stop` while it waits has `fullyIdle=false`. Pin the root id at the first `SessionStart`, drop the rest |
| **Door 2** | `Stop` → `{"decision":"block","reason"}` | same shape, `exit 0`, live-verified | none enabled: docs contradict; door 3 carries the rows | none enabled: plugin injection still to probe; door 3 carries the rows | none enabled: `stop` → `{"followup_message"}` documented, not live-verified; door 3 carries the rows | `Stop` → `{"decision":"continue","reason"}`, exit 0; the re-fired `Stop` carries `executionNum: 1` |
| **Houston tools in the child** | `--mcp-config`, added to the user's own servers (no `--strict-mcp-config`) | `-c mcp_servers.*` + token env | user-scope `grok mcp add` with a `${HOUSTON_MCP_TOKEN}` header | `OPENCODE_CONFIG_CONTENT` env with a `remote` server and bearer header | user-scope `~/.cursor/mcp.json` entry with `${env:HOUSTON_MCP_TOKEN}`, `_houston` marker | `~/.gemini/config/mcp_config.json` headers; bearer silently ignored upstream, smoke-test |
| **Compaction (counted, never a status)** | `PreCompact`, live on 2.1.287 | `PreCompact`, in the 0.159.1 hook event list | `PreCompact`, in the 1.0.13 hook table | `session.compacted` for the root session only, 1.18.33 bus schema | `preCompact`, in the 2026.08.11 bundle | none: no count, and the overview says so |
| **Verified how** | live, 2.1.263 | local schema + docs, 0.155.1 | docs + repo; login needed to probe | live, 1.18.27 (child sessions, idle, permission event) | docs; login needed to probe | live, 1.1.26 (all six rows) |

Capabilities are typed per session, not per provider name: `orchestrate::ProviderCapabilities`
carries `turn_end`, `last_message`, `block` and `door2`, derived from the event map and the
door-2 shape — so a table that disagrees with the events is structurally impossible — with
the last-message axis as the one explicit list (`LAST_MESSAGE_PROVIDERS`, the providers
whose hook surface actually delivers the field this crate lifts, however it gets there).

What changes per provider, beyond the shared inbox:

- **Claude.** Houston launches a local lifecycle mod with `--plugin-dir` on verified
  versions at least 2.1.290 when status hooks are enabled. The documented
  [turn events](https://code.claude.com/docs/en/plugins/mods/events) identify user
  interruption through `turn.complete.isAborted`. The mod ignores
  subagent completions, forwards the middleware unchanged, and sends only conversation,
  turn and working-directory identifiers to the existing hook helper. One bounded helper
  call at turn start establishes correlation; an interrupted completion uses a second.
  The daemon rejects missing, replayed or superseded turn identities. No transcript or
  terminal content drives this signal. `next.signal` alone is insufficient because hook
  budget expiry and middleware abandonment also abort it. Unknown or older CLI versions,
  policy-disabled mods and manually typed shell commands retain classic hooks without
  interrupt reporting. The installed 2.1.296 mod validator and isolated event harness
  cover the API contract; a synthetic event test does not verify a live Esc dispatch.
- **Codex.** `agent_hooks.rs` installs `~/.codex/hooks.json` in the Claude schema for
  `SessionStart`, `UserPromptSubmit`, `Stop`, `PermissionRequest`, plus
  `SubagentStart`/`SubagentStop`/`SessionEnd`/`PreToolUse`/`PostToolUse` correlation-only, with the
  same managed-marker discipline as Cursor's file; `notify` is removed from `config.toml`
  (parked, or deleted outright if it is Houston's own stale entry). Codex maps to
  `HooksFull`. In the 0.155.1 event shape, `PermissionRequest` has no `tool_use_id`;
  the helper carries its `turn_id` and a SHA-256 digest of `tool_input.command`, and
  `PostToolUse` clears only the matching episode without storing the raw command.
  Codex status hooks default to on unless the user explicitly disables them. Houston
  grants trust only to its own installed hook definitions, using a reversible marked
  block in `~/.codex/config.toml`. Codex keys each state entry by source path, event,
  group ordinal and handler ordinal; its trusted hash covers the normalized handler
  and matcher. Houston checks every installed definition against its saved hash and
  enabled state. A failed trust write removes Houston's hooks and restores parked
  `notify` configuration; unrelated hook and trust entries are preserved.
  Houston never passes `--dangerously-bypass-hook-trust`: project hooks retain Codex's
  own review boundary. Reinstall preserves group positions and unchanged file contents,
  and refreshes Houston's marked trust block when its definitions change. The trust
  algorithm follows Codex source rather than a stable public contract.
  A Codex launch with hooks off, absent or unconfirmed starts with `unavailable` status
  and an operator note naming the cause and repair path. Spawn warnings carry the same
  cause through their existing code and message fields. Late provider lifecycle
  evidence can recover the status; missing reports alone never prove distrust.
  Codex 0.160.0 queues SessionStart until turn creation. On Linux with user systemd, normal Codex
  launches use a pane-owned app-server and the native TUI's `--remote` transport.
  A startup-only observer confirms the loaded root's Idle status with documented
  read-only requests and writes one guarded SessionStart drop. It never takes over
  the conversation or bypasses hook review. A contained shell pane's managed PATH wrapper keeps interactive Codex on lifecycle
  hooks with `--no-daemon`, preserving the shell's recorded scope instead of creating
  an unrecorded sibling scope. Native startup readiness is unavailable on this path;
  CLI management subcommands pass through.
  The server receives the pane's MCP environment and applicable CLI configuration
  overrides, preventing a shared backend from retaining another pane's credentials.
  Unsupported native options and hosts without user systemd retain hooks and, when available, `--no-daemon`.
  Other platforms keep hooks only. See [the app-server contract](https://learn.chatgpt.com/docs/app-server)
  and [agent lifecycle](agent-lifecycle.md).
- **Grok.** Hooks already installed in `~/.grok/hooks/houston.json`. `SubagentStart`/
  `SubagentStop` are installed correlation-only; `PermissionRequest` was NOT added — the
  docs list `PermissionDenied`, the moment a permission has already been resolved, not the
  "blocked asking" moment `NeedsInput` means — so `Notification` stays the one block
  signal. Grok's field casing is unconfirmed (one docs fetch said camelCase, the code
  assumed Claude's snake_case), so `parse_hook_payload` tries snake_case first, then the
  camelCase twin, for Grok alone. Grok also reads Claude-format workspace hooks. A remaining
  Claude-path entry could deliver the same event twice; the helper exits without writing a
  drop when `--agent` is absent and `GROK_SESSION_ID` is set, so only the Grok-side drop lands.
- **ZCode.** Hooks run only from ZCode's settings file (`setting.json` in the community
  package, `config.json` upstream) and only with `hooks.enabled`, so the installer parks
  the previous value (see invariants). The stdin carries Claude's snake_case aliases next
  to ZCode's camelCase fields; its `transcript_path` is a temporary file ZCode deletes after
  the hook, so it is never recorded. `SessionStart` fires inside the first turn rather than
  at launch, so neither status nor first-prompt delivery can wait for it: the first prompt
  is pasted once ZCode's composer reports focus (bracketed paste enabled, then the cursor
  shown; after `FIRST_PROMPT_DEADLINE` it is pasted regardless), and counts as delivered
  when a `UserPromptSubmit` that begins like it arrives (invariants, carve-out 4). The
  Claude correlation rules apply: `AskUserQuestion` blocks through `PreToolUse`, and a
  `PostToolUse`/`PostToolUseFailure` resolves the episode with its own `tool_use_id`, which
  ZCode passes unchanged through every hook of one call. A denied or dismissed permission
  fires no hook, so it stays open until `Stop` or the next prompt. A `SessionStart` that
  arrives with the first turn also exempts ZCode from the spawn-grace expiry to Unavailable.
  `Stop` runs only after a successful turn, never after an API, quota or network failure.
  An interrupt aborts ZCode's hook runner with the turn, so it reports nothing; an
  `is_interrupt` failure that does arrive names one cancelled tool in a running turn and is
  handled like any other tool result. Resume is by exact `--resume <session id>` without a
  transcript check, since ZCode keeps sessions in its own database; a resumed process fires
  `SessionStart` with source `resume`, which releases a shell pane's deferred children.
  ZCode's `--mode` accepts only build, edit and yolo; `/plan` inside its TUI is read-only
  (subagents inherit it, non-destructive MCP tools stay allowed), but no flag, setting or
  hook payload lets the daemon set or confirm it, so task planning refuses ZCode by name.
  Handoff generation runs `zcode --mode build -p`, because `-p` defaults to yolo and its
  build mode denies every call that would ask for approval. Routines
  run only with isolated full access: `--mode edit` approves workspace file edits alone and
  waits on every other command's approval without a timeout. On Windows ZCode runs a
  `command` hook through `ComSpec`, where the POSIX guard cannot run, so each entry is a
  `process` hook: `command` names `<state dir>\bin\claude-hook.exe` and `args` carry the
  event and sentinel, and ZCode starts it without a shell. ZCode resolves that file only
  with its extension (an extension-less path is spawned as is, which Windows refuses), so
  the daemon places the `.exe` copy beside the plain launcher and points it before
  installing. Nothing guards a missing file or an empty `TR_SESSION` before the start; the
  helper itself exits 0 for both an absent session and another channel's launcher, and
  ZCode ignores the closed stdin pipe. Ownership checks read the sentinel from `args`.
  Evidence is ZCode's source, not a live authenticated probe.
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
  covers it and `pane_list` says "cursor: needs-input not reported by this provider".
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
"cursor: needs-input not reported by this provider", "opencode has no turn-end continuation;
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

The role regression measures serialized `tools/list` responses with every in-core
provider registered and verifies that a leaf keeps a bounded dialogue tool set.
The Tauri shell's browser tools are filtered by the same role gate. Tool schemas
and inbox JSON stay on the control plane; terminal bytes use binary PTY frames.

## `pane_send_keys`

Keys can answer a routine question within the caller's existing authority. Pending
permission episodes refuse every key before any PTY write; `pane_deny` and
`pane_escalate` are the parent's permission actions, and only the operator may approve.
The eight-key allowlist (`esc enter up down tab ctrl+c y n`) is checked in full so an
invalid key sends nothing. Keys have no paste framing or implicit Enter. ConPTY and
kernel PTYs use the same VT input sequences.

## `pane_get`

One pane in the caller's subtree as `orchestrate::PaneDetail`:
the session row flattened in (so this is `pane_list`'s element shape plus
extras, not a second vocabulary), the live-children and depth numbers its own
spawn caps are measured against, its `TurnEndSource`, and its `DelegationView`
if it has one. The view deliberately reports `result_staged: bool` — read off the
parent's inbox while `ready_at` is absent, with `result_staged_age_ms` showing its age — rather than the body itself, which
is the parent's next wake and not a field a caller can drain early. This is the one verb a caller may point at ITSELF: the scope gate's
self-refusal exists for the verbs that act on a pane, and this one only reads.

## The brief

File-backed launch briefs have unique paths for each launch. A sibling launch cannot
overwrite instructions that an existing agent may reread after compaction or resume.

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

## Launch approval modes

`sessions.approval_mode` records the selected launch mode. Orchestrated panes default
to `Auto`; `auto_approve: false` selects `Default` and `true` selects `Bypass`. Explicit
choices apply to children and independent handoffs regardless of the caller's launch
mode. Modes describe provider-specific flags, not comparable operating-system
permissions: Claude Auto and Codex Auto impose different sandbox boundaries. Requiring
a caller to run in Bypass would prevent an Auto orchestrator from launching an
explicitly authorized full-access worker.

The recorded mode still distinguishes Codex automatic approval review activity from
actual permission waits. Every actual permission episode remains subject to the
parent-first input policy; selecting a launch mode does not grant `pane_send_keys`
permission to approve it.

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
a recipient with no live session is re-addressed to its nearest live ancestor. If the recipient has no session identity, the sender's parent inherits the failed delivery. Only the absence of a live ancestor reaches the operator (`reason = "parent_dead"`).
`Db::open` imports legacy message files under `<root>/.houston/swarm/<id>` with
`reason = "migrated"`. A known recipient keeps the row until restart recovery determines
its live ancestor. Without a recipient, a known sender's parent inherits it; only mail
without a known owner starts in the operator inbox.

`ScopeLayout`/`scope_dir`/`init_scope` maintain the directories used by the `plan/events/`
GC sweep. Hook drops use the channel's `hooks/drop/` directory, and `hs-pane` wrappers
live under each workspace's `.houston/orchestration/bin/`.

## Renderer placement and operator inspection

A headless child has a real daemon-owned PTY but no separate grid cell. The renderer's
roster selects it inside its orchestrator pane; moving it to the grid changes placement,
not delegation ancestry. New children remain in the roster. Explicit promotion finds
the grid containing the parent across loaded and persisted layouts, rather than using
the child's workspace or the currently selected grid. Layout ownership stays in the
renderer. Roster and overview grouping use session liveness before
mission state: an ended child is Settled, a live child with user-owned input Needs you, and other live
children Working. Stalled children remain in Working with a warning; the parent’s
Inbox count and each child’s Pending delivery or Result staged badge expose delivery
state independently of process liveness. A resumed child must never be included in Close settled, including
when it resumes during the Undo interval.

Each orchestrator can have one overview tab in the workspace's side panel. It exposes
retained result previews independently of live child sessions. Stable inbox ids identify
full-body reads and copying; artifact links use the stored validated paths. Pagination is
bounded and ordered by message id so clock changes do not skip archive pages. Readiness
and provisional reasons prevent archived staged or interrupted bodies from appearing as
completed work. The overview also exposes the operator queue without intercepting terminal input. Queue acknowledgement
and resolution use durable inbox receipts. Source control reviews use the child's own
checkout and can return a review prompt to that child.

The side panel stores tab placement per workspace in localStorage. Browser surfaces
remain mounted while their tabs or panel are hidden, with id-scoped native suppression;
closing a browser tab destroys its surface and frees a native-webview slot. Popovers,
menus, modals and resize drags assert shared suppression reasons because native children
paint above the renderer DOM. Tooltips never suppress: they sit over chrome rows, and a
global hide on every hover blanks the page.

Worktree spawning passes Codex a session-local inline `projects` trust table for the
child checkout and the repository's main checkout,
passes Cursor its supported `--trust` flag, and appends a reversible managed-marker
block to Grok's folder-trust TOML. Existing unmanaged trust decisions are preserved.
Claude, Antigravity and OpenCode worktree spawns return a `worktree_trust` warning to the caller: the provider may ask to trust the new folder before starting. The parent inspects the warning and asks the operator to handle folder trust; permission approval belongs only to the operator. When no lifecycle report arrives within the startup window, the child becomes
Unavailable and a deduplicated `startup_unconfirmed` note reaches its parent. This
notice names hook and folder trust as possible causes without inferring a human wait. Claude's parent-folder trust
walk stops at the linked worktree's git root, so workspace trust does not carry over.
Houston never rewrites Claude's global project state or uses undocumented environment
variables to bypass folder trust. Trust flags do not change the requested tool approval mode.

A second live child in the same checkout returns a `shared_checkout` warning to the caller. Spawn replies carry typed `warnings: [{code, message}]` and retain the legacy nullable `warning` string; neither creates an operator inbox row. The `effort` reply names the requested effort or `CLI default` when
none was supplied. Omitted `pane_submit.request_id` uses the current request reported by
`workspace_info` and the reply states that default.

Temporary children end their PTY after their accepted result is delivered to the parent;
settled records and transcripts remain until the parent closes the pane or retention
expires. The parent should preserve needed output and artifacts, then promptly close each
completed child; reusable panes may remain only for intentionally assigned follow-up work.
This is a parent instruction, not automatic settlement: do not close a running child or
confirm closing live descendants unless their work is also complete and preserved. A child
with `no_handback`
settles as failed after five minutes of authoritative Idle status, with no background,
composer or descendant hold. Its stop reason names `NO_HANDBACK_SETTLE_MS`.

Worktree cleanup claims are shared by repository common directory, rechecks live session
use immediately before removal, and measures only trees with no keep reason. Kept rows
retain their last byte count and measurement timestamp, or null for not measured.

Parent-owned child input writes an urgent parent inbox row and remains neutral in every
renderer attention consumer. User-owned input produces the same amber, banner and
notification policy as top-level input, with the displayed reason. Notifications identify
the stable input episode, including ownership transitions, and suppress roster replay.
Parent rollups do not produce a second alert for that same request. Settings › Notifications
still controls desktop and in-app notices. Taskbar counts use user-owned input where the
platform supports them and clear the opened pane's count.

No supported API-failure hook carries a verified machine-readable reset time,
so Houston does not schedule automatic resume.

The workspace-info provider catalog checks executable presence and reuses cached versions
and derives capabilities from the event map and launch rules. It reads Codex's
local `models_cache.json` under `CODEX_HOME` or `~/.codex`, without a network
request. Other providers have no verified local model-list source. Cache reads
are limited to 2 MiB; the response includes at most 64 identifiers of 128 bytes
per provider and marks truncation. Model identifiers describe the local cache,
not guaranteed account access. Unknown or over-128-byte versions remain null; workspace-info never
launches version probes. It reports the routes alongside the provider catalog.
