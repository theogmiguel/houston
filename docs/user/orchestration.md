# Orchestration

Orchestration lets an agent running in a Houston pane open new panes of its own, brief
them, and wait for what they report back. A parent pane becomes an orchestrator; the
panes it opens are its children. A child can itself become an orchestrator, up to a
depth limit you control.

## Turning it on

Orchestration is off by default. Turn it on in Settings ▸ Orchestration ▸ Enable
orchestration. Until you do, an agent in a pane has no way to spawn another pane — the
tools for it are not even offered to it.

## The two surfaces an agent uses

An agent drives orchestration through either of two doors, which always agree with each
other on names and arguments:

- An MCP tool set: `pane_spawn`, `pane_list`, `pane_get`, `pane_send_keys`, `pane_read`,
  `pane_prompt`, `pane_wait`, `pane_kill`, `pane_submit`, `pane_report`, `pane_reply`, `pane_message`,
  `pane_deny`, `pane_escalate`, and the `pane_instruction_*` controls.
- A command-line tool, `hs-pane`, with one subcommand per verb above (plus a CLI-only
  `whoami`) — for an agent CLI that has no MCP tool support of its own.

An orchestrator sees the management verbs and `pane_spawn` while spawning is allowed.
Management remains available for retained children when spawning is disabled, so the
parent can inspect their results and close completed panes.
A child that cannot delegate keeps its handback, report, reply, wait and identity tools.
Reply remains available when spawning is disabled, so an ancestor can answer inherited
questions and retry a recorded answer. Houston checks the recipient and delegation
ancestry on every answer; unrelated panes cannot answer another parent's questions.
Hosted agents are instructed to delegate coding-agent work through Houston panes.
Reaching a child or nesting cap does not authorize using internal sub-agents instead.

When a Codex shell pane uses the Houston MCP entry, Houston keeps its `pane_wait` tool
timeout long enough for orchestration turns to complete. Houston refreshes its own local
endpoint and manages only its marked timeout setting in `~/.codex/config.toml`; an explicit
`tool_timeout_sec` value and other Codex settings remain unchanged, including when the
local daemon port changes.

## The caps, and what happens when one trips

Two caps bound how far a tree of agents can grow, both editable in Settings ▸
Orchestration:

- **Max child panes per agent** — how many panes one agent may have live at once.
  Defaults to 4. A spawn attempt past the cap is refused with a message naming the
  pane, how many live children it already has, and the cap: `spawn refused: pane
  <id> already has <n> live children (cap <n>)`.
- **Max nesting depth** — how many generations deep a spawn chain may go. Defaults to
  1: a pane you opened may spawn a child, but that child does not itself spawn.
  A spawn attempt that would sit past the cap is refused naming the depth it would
  land at and the cap, with an explanation that nesting is off by default because the
  cost of a tree compounds per generation, and a pointer to raise the cap in Settings ▸
  Orchestration if a longer chain is what you meant.

Both caps can be raised (up to a fixed ceiling in Settings). They limit child delegations;
a top-level pane's explicit handoff creates an independent pane outside those per-parent
caps. A child pane cannot hand off.

Children use their provider's Auto mode by default. To request a different mode, the
orchestrator uses `auto_approve: true` (`hs-pane spawn --bypass`) for Bypass or
`auto_approve: false` (`--ask`) for the provider's ordinary approval prompts. The child's
mode is selected independently of the parent's mode: a Claude pane in Auto can create
a Codex pane in Bypass when you authorize that launch.

Codex Auto uses an operating-system sandbox, even when its configuration normally
selects full access. Codex Bypass disables that sandbox and approval prompts, allowing
commands to write outside the worktree and use the network with your terminal's
permissions. Claude Auto does not impose the same operating-system sandbox. Choose
the child's mode for the task's required access; a worktree isolates Git changes,
not operating-system permissions.

## Getting a result back

A child reports back to its parent by calling `pane_submit` — its handback point, and
the only way it ends its side of the delegation. The parent continues independent work,
then waits with `pane_wait`, which blocks until a result, a question, or an exit is ready.
Completion also reaches the parent's inbox through its next supported delivery point.
Routine status checks and terminal reads are unnecessary; reserve them for a reported
blocker, a timeout, or an explicit request to inspect the child.

Waits are capped by the parent provider: Claude uses 90 seconds; Cursor and Antigravity
use 30 seconds; Codex, Houston-configured OpenCode and ZCode use ten minutes. Grok uses up to
ten minutes, shortened by its effective per-tool timeout. Requests above the cap are
clamped and the response names the requested value and cap. A timeout asks the parent
to wait again. Starting another wait replaces the previous one;
interrupted waits leave results available for delivery. An active child can wait for a
reply even when it has no children itself. Otherwise, with no live children or pending
messages, a whole-inbox wait returns immediately. A result submitted before the
child finishes its turn remains staged; `pane_get` exposes its age and hold reason when
you need to diagnose a missing completion. Wait timeouts also explain staged-result
holds. For children without an ACP stream, until a child reports a lifecycle hook,
Houston uses a quiet period of 15 seconds on a still screen with no running descendants
to release its submitted result. After hooks report, Houston waits for the provider's
turn-end event. ACP streams report turn completion directly. Claude background jobs
hold a turn open for at most
45 minutes before a missing-handback notice reaches the parent.

Result bodies up to 4096 characters arrive whole; larger bodies arrive as a bounded
excerpt. Use `pane_get` with the child's `session` and the excerpt's `result_id` to
read the full stored body, including after the child closes. The CLI equivalent is
`hs-pane get SESSION --result-id ID`. Only the result's recipient can retrieve it;
the submit storage limit still applies.

The orchestrator's overview keeps result previews after children close. Open a result
to read its full stored body and artifact links. Copy result copies that full body.
Pending and partial results remain labelled as such. Older previews can be loaded in
bounded pages, subject to the inbox retention policy.
If a child submits a body before asking for input, Houston delivers it as a provisional
result while keeping the input request open. Receiving that body does not mean the
child's work is finished.

During work, a child can call `pane_report` with `kind: progress`, `question` or
`blocked`, a `body` and its current `request_id`. The CLI equivalent is
`hs-pane report question "Use the existing fixture?" --request-id 1`. Reports do not
complete the task. Questions and blockers remain open after the parent reads them.
The parent answers with `pane_reply{message_id,text}` or `hs-pane reply ID TEXT`.
The child waits with `pane_wait` without a `session`, then matches the reply's
`reply_to` and `request_id` to its question. It still finishes through `pane_submit`.

The parent agent resolves routine questions within the assigned scope. The child shows
Asked orchestrator while its parent handles the request; this state does not alert you.
For a decision that belongs to you, the parent calls `pane_escalate{child,reason}`.
The child then shows Needs you with the escalation reason. Amber status and input
notifications mean that a request is waiting on you.
After escalation, the parent cannot answer that request with `pane_reply` or
`pane_send_keys`. Answer in the child's terminal; provider confirmation clears the
request and informs the parent.

Every actual permission prompt goes to the parent first, regardless of Ask, Auto or
Bypass launch mode. It stays gray as Asked orchestrator and creates an actionable
parent inbox request. The parent can deny or escalate a permission; it can never
approve one. Only you, the operator, may approve in the child's terminal.

The parent denies with `pane_deny{child,episode_id}` or `hs-pane deny CHILD
--episode-id ID`. Houston sends only a verified provider denial and leaves the request
pending until provider evidence confirms resolution. Unsupported paths refuse with a
reason; the parent can then escalate. Denial currently requires Linux and verified
default bindings; other platforms explicitly refuse. Codex and Grok denial can also
interrupt the turn. While any permission episode is pending,
`pane_send_keys` refuses every key, including Escape and n. Input episode ids identify
one prompt and are separate from worker request numbers.

Escalation assigns the request to you, with amber status and input notifications.
The parent supplies its recommendation through `pane_escalate.reason`; it never invents
a command or block reason absent from provider evidence. A bare Codex Auto permission
event does not prove a waiting prompt and does not alert you.

An unanswered request escalates when the parent's provider confirms the end of its
turn, or when the parent closes or dies. A quiet terminal does not trigger escalation.
Unanswered inbox questions, including ones already read, follow the existing ancestor
route; without a live ancestor they remain Addressed to you in the operator inbox.
You can open a child and answer before escalation. Houston records your intervention
for the parent, including the answer when the provider reports it. A reply does not
expand the child's authority or grant permission for an action outside its brief.

Each report or reply allows 1–8000 characters. A worker can have at most 64 outstanding
reports and 64 unread replies; delivered unanswered questions count toward the limit.
Starting a new request or ending the current one closes its obsolete dialogue.
Unanswered questions survive mailbox cleanup; resolved messages follow retention.

A follow-up prompt waits when the child is busy or you have unsubmitted text in its
terminal. Its receipt identifies the instruction and names the hold. The bounded queue
retains instructions across daemon restarts. After recovery, untouched instructions
remain held until explicitly resumed after checking the child and conversation.
An uncertain delivery is shown for inspection and is never replayed automatically.

Cursor does not report needs-input. Its capability note and spawn warning say
“needs-input not reported by this provider”; an absent badge cannot prove it is working.

Codex Auto review can show `stalled?` after an observed approval episode remains unresolved
for five minutes. This is a diagnostic heuristic, not a request for human input. It clears
when a matching tool completion, a new user prompt or authoritative turn end/interruption arrives. Houston
does not send keys or a desktop notification in response to it.

## Children talking to each other

Children of the same orchestrator can message each other directly, so a back-and-forth such
as an implementer and a reviewer does not pass through the orchestrator. A child calls
`pane_message{to, body}` (`hs-pane message ROLE TEXT`) with the sibling's role or session id;
`workspace_info` lists its live siblings. The message arrives in the sibling's `pane_wait`,
and the orchestrator receives no copy; it still receives each child's result.

A message reaches only a sibling that is still working on its current task. A sibling that
has already handed back is refused, because only the orchestrator starts new work. One child
can send at most 32 messages to one sibling during that sibling's task, and the refusal names
the limit. To use this, the orchestrator spawns both children with roles and names the peer
in each brief.

## Watch a pull request

From an agent pane, ask the agent to watch an open GitHub pull request. The agent calls
`pane_pr_watch` with a pull request number or URL, then ends its turn. Houston checks the pull
request once a minute and wakes that pane when a check fails, all reported checks pass, a new
review or comment arrives, or the branch becomes conflicted with its base. A watch stops when the
pull request is merged or closed, after repeated read failures, or after ten comment-only wakes.
Panes watching the same pull request share one read per check. When GitHub reports a rate
limit, Houston pauses every pull request watch until GitHub's reset time instead of counting a
failed read; starting a watch during the pause is refused with "paused until HH:MM", and an
in-review task's run shows the same reason.
Use `pane_pr_unwatch` when updates are no longer needed.

## Workspaces and child lifetime

By default, a child starts in the parent's current directory when it is inside the
registered workspace, including a worktree. Otherwise it starts at the workspace root. `target_workspace` may
select another workspace already registered in Settings; Houston does not treat an
arbitrary filesystem path as authority. If `cwd` is supplied, it must be inside that
target workspace. The parent may still address the child because delegation ancestry,
not workspace equality, controls access. A child token remains scoped to its own
workspace, and unrelated panes remain inaccessible.

For an isolated checkout on Linux or Windows, set `worktree` to a new directory slug
in `pane_spawn` (`hs-pane spawn --worktree SLUG`). Houston creates and records it under
`.houston/worktrees/SLUG`, using branch `houston/SLUG` unless an explicit `branch` is
supplied. Existing branches and occupied paths are refused. If creation or provider
preparation fails, Houston rolls back the fresh checkout and branch. If Git checkout fails
after a hook has added commits, Houston preserves them and reports that rollback needs attention.

While an orchestrator has worktrees from `pane_spawn`, Houston checks about once a minute
whether their committed branches would conflict with their base or with each other. A
new predicted conflict arrives once in the orchestrator's inbox, naming both branches and
the files, so it can reassign or sequence the work before either branch becomes a pull
request. It reads only the local repository and requires Git 2.38 or newer; with an older
Git, the orchestrator receives one note naming the installed and required versions.

A new worktree is a fresh checkout, so files Git ignores, such as `.env` or local settings,
are missing from it. To carry them over, list them in a `.worktreeinclude` file at the
repository root, using `.gitignore` syntax. When Houston creates a worktree (for
`pane_spawn`, a task, or the Changes pane), it copies each file that matches the list and
is ignored by Git in your checkout. Tracked files are never copied, and a file that already
exists in the new worktree is kept. Symlinks and paths that resolve outside the checkout are
refused. A copy stops at 256 files or 32 MiB. Anything not copied is named in a
`worktree_include` warning in the `pane_spawn` result, in the task brief, or in the Changes
pane's message; the worktree is created either way. Houston runs no command from the
repository while doing this.

Children are temporary by default. After a durable completed result, Houston ends the
process, but keeps the session and transcript under Settled until the parent closes the
pane or retention expires. After receiving a completed result, preserve any needed output
and artifacts, then promptly close the child with `pane_kill` or `hs-pane kill`; do not
accumulate completed panes. Keep a reusable child only when you intentionally plan more
assigned work. Do not close a child that is still working, or confirm closing live
descendants unless their work is also complete and preserved. Closing a settled child or
its parent removes it; retention expires after 24 hours by default. Claude, Codex and ZCode conversations can be
continued when a valid resume handle is available. Other providers cannot continue an
ended conversation. A reusable child remains available for follow-up prompts until close
or retention expiry.

Final result delivery reminds the parent to close the child after preserving its
output when no further task is planned. A reusable flag alone is not a reason to
keep a completed pane. Questions, blockers, progress and provisional or late results
do not carry this cleanup instruction because they do not establish completion.

After a daemon restart, open Claude, Codex and ZCode children resume with their parent when
valid conversation handles are available. A Claude, Codex or ZCode conversation detected
inside a POSIX shell pane resumes inside that shell, which remains a shell pane; a Windows
shell pane cannot relaunch it. Houston restores its
children only after the parent's exact conversation resumes; otherwise the children stay
deferred until the parent can resume. The parent receives one restored notice naming which
children resumed. Other children remain ended and are named in that notice.

A live daemon handoff preserves parent links, delegation roles and scoped credentials.
An open wait returns a retryable timeout marked `restarting`; call `pane_wait` again
on the new generation. Pending results remain available for that wait.

Claude and Grok children receive launch-only permission rules for exactly Houston's
`pane_submit`, `pane_report`, `pane_reply`, `pane_message`, `pane_deny`, `pane_escalate` and `pane_wait` tools, including when
automatic approval is disabled. Other tools keep the selected approval mode.
Codex, Antigravity, OpenCode, Cursor and ZCode have no equivalent launch rule; their
selected approval mode still applies to these tools. Outside yolo mode ZCode asks for
approval before every Houston tool call, so a ZCode parent also asks before each
`pane_spawn` and `pane_wait`.

A ZCode child whose turn fails — an API error, an exhausted Coding Plan quota, a network
failure — or is interrupted reports no turn end: its parent's wait times out instead of
returning, and the child shows Working until it is prompted again. A ZCode child's brief
is pasted into its interface; if ZCode does not report it as submitted, the parent gets a
`prompt_failed` note and can resend it with `pane_prompt`.
Inspect it with `pane_read` when a wait on a ZCode child keeps timing out.

## Handing work off to a new pane

When you ask an agent to hand its work off to a new pane, and you no longer need the
original pane, the agent spawns with `handoff: true` (`--handoff` for `hs-pane spawn`).
The new pane is an ordinary pane rather than a child: it does not report back, the
original agent cannot prompt or wait on it, and you can close the original pane without
closing the new one. Only a pane without a parent can hand off, and `reusable` and
`output_format` are refused with `handoff`. Orchestration must be enabled in
Settings ▸ Orchestration.

Creating a worktree does not request a handoff. Normal delegation uses child panes,
including isolated branch work with `worktree`. The agent uses an independent handoff
only when you explicitly ask to continue in a new pane, passing context via `state_doc`
(`--state-doc` or `--state-doc-path`). It must not edit a child's worktree from the primary
checkout; the new pane reports the checkout where it works.

Each compaction of an agent's context lowers what it remembers of earlier decisions.
Houston counts the compactions that Claude, Codex, Grok, Cursor and OpenCode report
through their hooks, and the orchestrator overview shows the current count. Antigravity
reports no compaction event, so the overview says that no count is available. After every
third compaction, a top-level pane that has children and has not already handed off
receives one inbox note offering a handoff, describing what the state document should
contain. The note is not a question and starts nothing; the orchestrator may recommend
a handoff, and you decide whether to continue in a new pane.

Spawn may also request `effort` (`low`, `medium`, `high`, `xhigh` or `max`) through MCP,
HTTP or `hs-pane spawn --effort`. Workspace routing can supply model and effort choices;
without a matching route, the agent chooses them. Providers without a per-run effort
setting refuse that request.

`model` must be an identifier accepted by the selected agent CLI. Houston forwards it
unchanged; it does not expand display names or shorthand. For example, Codex uses
`gpt-5.6-luna`, not `luna`. Omitting `model` keeps the CLI default.

After cleanup, the parent can still call `pane_wait` for that child id and receive its
durable result, including the child's codename and role. Whole-inbox waits remain
unchanged. Follow-up input or live descendants cancel or defer cleanup, and legacy
explicit pane close keeps its existing operator semantics.

For a clean-context review, provide the exact target and base/head (or a snapshot), the
requirements, and focused evidence such as `file:line` and test results. Do not paste a
parent transcript; temporary review panes clean up after their final handback.

## Follow-up delivery and retries

`pane_prompt` accepts `mode: "queue" | "steer" | "restart"`; `hs-pane prompt` uses
`--mode`. Queue is the default and waits until the child can accept a prompt.
Steer writes into the PTY immediately, including during a working turn; the CLI
controls how it uses that input. Restart interrupts a working turn and delivers
the prompt after the child reports idle. It supports Codex with its default Escape
binding and Grok with Ctrl+C. Claude, OpenCode, Cursor, Antigravity and ZCode are refused
by name because a reliable interrupt-to-idle path is not verified. Keep the
supported provider's default interrupt binding.

Steer and restart refuse an operator draft, a question or permission prompt, or
another queued prompt. Answer routine questions with `pane_send_keys`; deny or escalate
permissions. Use queue to wait for a busy composer. These modes never paste over operator text.

Each accepted instruction has a stable id and a current delivery state. Accepted means
Houston retained the instruction; delivered means it wrote the complete prompt and
Enter, and does not mean the task finished. Queued instructions receive distinct
request numbers when dispatched after startup. An instruction delivered before the first
prompt starts uses the child's initial request number. Restart preserves an interrupted result as partial
and protects the replacement instruction from automatic child cleanup.

Inspect the child's instruction queue to see ordering and hold reasons. Cancel an
unwanted queued or held instruction, or explicitly resume a held instruction after
recovery. For uncertain delivery, inspect the full instruction and the child before
cancelling and issuing a new instruction. The agent has the same operations through
`pane_instruction_list`, `pane_instruction_get`, `pane_instruction_cancel` and
`pane_instruction_resume`, with matching `hs-pane` subcommands.
If delivery becomes uncertain after acceptance, Houston also informs the sender's
inbox with the instruction id and an inspection action. If the sender is gone, the
note follows the ancestor or Addressed to you route.

To retry a spawn, prompt, report or reply after a timeout, choose `client_request_id` before the
first call (`--client-request-id` in `hs-pane`) and repeat the same key and arguments.
Keys accept 1–64 ASCII letters, digits, dots, underscores and hyphens. Houston
returns the recorded success without repeating the mutation. Omitted defaults and
their explicit values share a receipt. A refusal before any action releases the key,
so it can be retried when a child cap or needs-input condition clears. Reusing a key with
different arguments or a different operation is refused. Keys belong to the
calling pane and expire after seven days or eviction from the newest 4096 receipts.

Reports and replies commit the message and retry receipt together. Repeating a
recorded answer returns the same receipt even after the question or request closes.

If an error may have acted or a daemon crash leaves a key pending, Houston reports an uncertain outcome.
Inspect the child before choosing a new key; retrying that pending key cannot
spawn another child or send another prompt. Calls without a key keep their usual
behaviour.

## Mailbox retention

**Mailbox retention** (Settings ▸ Orchestration) controls how long a delivered mailbox
file survives before Houston sweeps it. It only moves the cleanup horizon — it never
changes whether a message is delivered.

## Staying in the loop as the human

Orchestration does not lock you out of a pane an agent opened. Any pane in the grid,
including one spawned by another agent, is a real terminal you can click into and read,
and you can type into it directly at any time — the same as any pane you opened
yourself. Delegation changes who briefed the pane, not who is allowed to use it.

Handoff requests may include `state_doc` as text or `{path: "state.txt"}` inside the
target workspace. The handoff state is limited to 64 KiB and included in the new pane's
brief. It is refused on ordinary child spawns.

## Following delegated work

The orchestrator's roster groups children into Needs you, Waiting on orchestrator, Working,
Stalled, Idle, Status unavailable and Settled. Select a
child to inspect its terminal inside the orchestrator pane; return to Orchestrator to
see the parent. New children stay in this roster by default. Move to grid gives a child
its own cell beside its parent, selecting the parent's grid even when another grid was
active. The roster remembers whether you explicitly collapsed or expanded it, including
when you return to the pane or reopen Houston. Return to roster reverses that placement. A headless child stays in the roster
without consuming a grid cell.
Needs you includes requests explicitly assigned to you and children whose descendants
are waiting on you; Answer focuses their terminal prompt. Questions awaiting a parent
appear under Waiting on orchestrator and count separately in Overview. Idle and staged-result children stay outside Working. Stalled carries a visible heuristic
label and reason; children without lifecycle reports appear under Status unavailable.
All live children still consume orchestration slots regardless of their status group.
Show only on the Needs you heading hides the other groups until you select it again, or
until no child needs you. The parent agent can answer routine reported questions;
the daemon does not make decisions or approve provider prompts on your behalf.

When children run in their own git worktrees, the orchestrator's header shows a branch
count next to its branch chip. Select it to list each child's own branch, commits ahead
and changed lines; select a child to focus its pane, or use the row's copy-path and
reveal actions.

Overview opens a closable side-panel tab for that orchestrator. Group its children by
status or worktree, select a terminal, or review changes in the child's checkout.
The parent’s Inbox count opens pending messages. A child’s Pending delivery badge
means messages have not reached its parent; Result staged means a result was submitted
while the turn was still running. Neither badge means that the child process exited.
Managed worktrees show their branch and changed-file count. Live siblings sharing a
checkout are identified by role. The latest result excerpt remains available after reopening
the overview, subject to inbox retention. Review comments can be sent back to that child. Closing the overview only closes the view.

Settled contains ended sessions. A settled child's process has exited; selecting it shows
its saved transcript read-only, with when it ended and how long it is kept. Continue and
Close sit under the transcript. A live resumed child stays in a live status group even
if its previous delegation was marked unknown. Close settled counts only ended children
and offers five seconds to Undo; a child that resumes during that interval is preserved.
Continue resumes a retained Claude, Codex or ZCode conversation with its earlier transcript.
Set **Settled retention** in Settings ▸ Orchestration to change the default 24-hour horizon.

When a parent ends, pending messages go to its nearest running ancestor. If none remains, they appear under **Addressed to you** in the overview.
Acknowledge marks a message delivered; Resolve marks it handled. Restart notices list
which child conversations resumed and why others remained ended. Successfully resumed
children are Working; an interrupted mission is not reported as successful.

Children report results, questions and delivery problems to their parent orchestrator.
An input request alerts you only when it belongs to you: an explicit escalation,
the authoritative turn-end or parent-unavailable safety net. Settings ▸ Notifications controls desktop and in-app notices for these
requests, as it does for top-level input. Snapshot replay does not repeat old alerts.
Spawn warnings return to the orchestrator. Addressed to you is hidden when empty.

Provider usage limits and API failures reported by Claude, Grok or OpenCode leave
the child available for inspection with a failed delegation and send its parent
the reported reason. A Claude rate limit sends one `claude limited` note per limit
episode, naming the account profile; the child shows **Limited** until its next turn
starts, and a `pane_wait` timeout on it names the limit. Claude's hooks report no
reset time, so Houston cannot say when the limit resets. Send a follow-up when the
provider allows another turn; Claude may also continue on its own.

When a child's process ends before it hands anything back, for example a CLI that
fails at launch, its parent receives the exit status and the last lines the pane
printed; `pane_get` shows the same text as the stop reason.

Use `workspace_info.providers` before choosing a provider or model. It reports
installed CLIs, locally known versions and model identifiers, per-run effort
support, and orchestration capabilities. `workspace_info.routing` contains the
current workspace's model and effort routes. A null model list means unknown;
it does not mean that the provider accepts no models.
