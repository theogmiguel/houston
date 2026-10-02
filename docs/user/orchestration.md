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
  `pane_prompt`, `pane_wait`, `pane_kill`, `pane_submit`.
- A command-line tool, `hs-pane`, with one subcommand per verb above (plus a CLI-only
  `whoami`) — for an agent CLI that has no MCP tool support of its own.

Which tools a given pane actually sees depends on what it is: a pane with no parent and
no orchestration ability sees none of them; an orchestrator sees the management verbs
and `pane_spawn` for as long as it has spawn budget left; a spawned child sees only
`pane_submit` (its handback) and its own identity check — nothing else from this set is
useful to it, so it is not offered.

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
caps. A child pane cannot hand off, and the approval ceiling still applies.

A related but separate rule: a spawned child never gets a wider permission bypass than
its parent holds. If a parent tries to spawn a child at the full approval bypass while
the parent itself is not at that bypass, the spawn is refused — a pane cannot hand a
child a permission it does not itself have.

## Getting a result back

A child reports back to its parent by calling `pane_submit` — its handback point, and
the only way it ends its side of the delegation. The parent continues independent work,
then waits with `pane_wait`, which blocks until a result, a question, or an exit is ready.
Completion also reaches the parent's inbox through its next supported delivery point.
Routine status checks and terminal reads are unnecessary; reserve them for a reported
blocker, a timeout, or an explicit request to inspect the child.

Waits are capped by the parent provider: Claude uses 90 seconds; Cursor and Antigravity
use 30 seconds; Codex and Houston-configured OpenCode use ten minutes. Grok uses up to
ten minutes, shortened by its effective per-tool timeout. Requests above the cap are
clamped and the response names the requested value and cap. A timeout asks the parent
to wait again. Starting another wait replaces the previous one;
interrupted waits leave results available for delivery. If there are no live children or
pending messages, a whole-inbox wait returns immediately. A result submitted before the
child finishes its turn remains staged; `pane_get` exposes its age when you need to
diagnose a missing completion. Claude background jobs hold a turn open for at most
45 minutes before a missing-handback notice reaches the parent.

Result bodies up to 4096 characters arrive whole; larger bodies arrive as a bounded
excerpt. Use `pane_get` with the child's `session` and the excerpt's `result_id` to
read the full stored body, including after the child closes. The CLI equivalent is
`hs-pane get SESSION --result-id ID`. Only the result's recipient can retrieve it;
the submit storage limit still applies.

A follow-up prompt waits when the child is busy or you have unsubmitted text in its
terminal. The reply names that hold. If Houston can write immediately, a write failure
is returned directly instead of reporting the prompt as queued.

Cursor does not report needs-input. Its capability note and spawn warning say
“needs-input not reported by this provider”; an absent badge cannot prove it is working.

Codex Auto review can show `stalled?` after an observed approval episode remains unresolved
for five minutes. This is a diagnostic heuristic, not a request for human input. It clears
when a matching tool completion or authoritative turn end/interruption arrives. Houston
does not send keys or a desktop notification in response to it.

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

Children are temporary by default. After a durable completed result, Houston ends the
process and keeps the session and transcript under Settled. Done-and-idle reusable
children also leave the live-child quota, but remain in Working until their process ends. Closing a settled child or its parent removes
it; retention expires after 24 hours by default. Claude and Codex conversations can be
continued when a valid resume handle is available. Other providers cannot continue an
ended conversation. A reusable child remains available for follow-up prompts until close
or retention expiry.

After a daemon restart, open Claude and Codex children resume with their parent when
valid conversation handles are available. The parent receives one restored notice naming
which children resumed. Other children remain ended and are named in that notice.

A live daemon handoff preserves parent links, delegation roles and scoped credentials.
An open wait returns a retryable timeout marked `restarting`; call `pane_wait` again
on the new generation. Pending results remain available for that wait.

Claude and Grok children receive a launch-only permission rule for Houston's
`pane_submit` tool, including when automatic approval is disabled. Other tools keep
the selected approval mode. No handback-only launch rule is
configured for Codex, Antigravity, OpenCode or Cursor; their capability note names
this limitation, and their selected approval mode still applies to handback.

## Handing work off to a new pane

When you ask an agent to hand its work off to a new pane, and you no longer need the
original pane, the agent spawns with `handoff: true` (`--handoff` for `hs-pane spawn`).
The new pane is an ordinary pane rather than a child: it does not report back, the
original agent cannot prompt or wait on it, and you can close the original pane without
closing the new one. Only a pane without a parent can hand off, and `reusable` and
`output_format` are refused with `handoff`. Orchestration must be enabled in
Settings → Orchestration.

Each compaction of an agent's context lowers what it remembers of earlier decisions.
Houston counts the compactions that Claude, Codex, Grok, Cursor and OpenCode report
through their hooks, and the orchestrator overview shows the current count. Antigravity
reports no compaction event, so the overview says that no count is available. After every
third compaction, a top-level pane that has children and has not already handed off
receives one inbox note offering a handoff, describing what the state document should
contain. The note is not a question and starts nothing: you or the orchestrator decide
whether to hand off.

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

The orchestrator's roster groups children into Needs you, Working and Settled. Select a
child to inspect its terminal inside the orchestrator pane; return to Orchestrator to
see the parent. Move to grid gives a child its own cell, and Return to roster reverses
that placement. A headless child stays in the roster without consuming a grid cell.
Needs you includes blocked and stalled children; Answer focuses their terminal prompt.
Houston never answers a child's question for you.

Overview opens a closable side-panel tab for that orchestrator. Group its children by
status or worktree, select a terminal, or review changes in the child's checkout.
Managed worktrees show their branch and changed-file count. Live siblings sharing a
checkout are identified by role. The latest result excerpt remains available after reopening
the overview, subject to inbox retention. Review comments can be sent back to that child. Closing the overview only closes the view.

Settled contains ended sessions. A settled child's process has exited; selecting it shows
its saved transcript read-only, with when it ended and how long it is kept. Continue and
Close sit under the transcript. A live resumed child stays in Working or Needs you even
if its previous delegation was marked unknown. Close settled counts only ended children
and offers five seconds to Undo; a child that resumes during that interval is preserved.
Continue resumes a retained Claude or Codex conversation with its earlier transcript.
Set **Settled retention** in Settings ▸ Orchestration to change the default 24-hour horizon.

When a parent ends, pending messages go to its nearest running ancestor. If none remains, they appear under **Addressed to you** in the overview.
Acknowledge marks a message delivered; Resolve marks it handled. Restart notices list
which child conversations resumed and why others remained ended. Successfully resumed
children are Working; an interrupted mission is not reported as successful.

Children report results, requests for input and delivery problems to their parent
orchestrator. The orchestrator answers the child or asks you for a decision. Spawn
warnings return to the orchestrator; they do not appear in "Addressed to you".
Only a top-level pane waiting for your input triggers a desktop notification.
The "Addressed to you" group is hidden when empty.
