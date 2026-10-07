# Tasks

Tasks are one global local backlog, visible from every workspace. **All** is the default
view; **This workspace** filters to the current workspace, and each viewer remembers its
choice. In All, rows show the workspace folder name or **No workspace**; hover over the
workspace name to see its full path. Open the **Tasks** tab in the side
panel beside **Source control** and **Files**. The list is grouped by status with a count
per group: **In progress**, **In review**, **Todo**, **Backlog**, **Done** and **Canceled**.
Each row carries a priority glyph, the task key (`HOU-1`), its title and the time since it
last changed. The **Done** and **Canceled** groups start collapsed; click a group header to
fold or unfold it. **Archived** tasks sit in a final collapsed group.

## Tasks page

Choose **Tasks** in the rail to see the queue. **Your turn** contains runs waiting for input
and tasks handed back for review; **Agents working** contains live runs; **Stopped** contains
interrupted or stopped work; **Up next** contains ready tasks. Done and archived tasks stay
folded below the queue. The count beside Tasks is the number in **Your turn**. A ready task
shows its pull request number, and a waiting run shows the agent's question when Houston has
received one. Select a task to open its detail in a drawer over the queue. The drawer keeps
acceptance items toggleable; its **…** menu includes **Open session** and task actions. The
Tasks side panel remains available as a shortcut.

## Creating and editing

Ctrl/Cmd-click a task key (`HOU-3`) in a terminal to open that task in the Tasks tab. The
key links only when the loaded list knows it. With text selected in a terminal, the command
palette's **New task from terminal selection** creates a task whose description is that
selection and whose title is its first line, then opens the task.

Choose **New task** in the tab header, or the plus on a group header to create straight into
that status. A task has a title, a description, a status, a priority and an optional parent
task, and an optional workspace. New tasks use the current workspace when one is selected;
otherwise they are unassigned. The **Workspace** property assigns a registered workspace
or clears it with **No workspace**. A task keeps its globally unique `HOU-<n>` key when its
workspace changes; the fixed prefix is always `HOU` and numbers are never reused.
The acceptance list holds the checks the work must satisfy. Open a task to edit any of
these; changes save when a field loses focus. Only one revision is saved at a time, so if the
task changed elsewhere first, a **This task changed elsewhere** banner appears with **Reload**
before you overwrite anything.

A task created from a Harness finding keeps its source finding key and review. Tasks made from
Harness show that origin in their details and list rows. A finding can have several linked fix
tasks over time; only one linked task may remain open at once.

Tick an acceptance item to check it. Comments appear in the same chronological activity feed
as the recorded changes, with a composer below. The task menu in the detail header archives
the task; an archived task shows the same menu with **Restore task**.

## Projects and deliveries

Choose **Projects** in the rail with a workspace selected. A project groups deliveries;
each delivery groups slices, and each slice owns one execution branch and pull request.
Keep the project's tracker description as an unverified snapshot and record local decisions
and corrections separately. Both reach agents as labelled context.

Delivery progress follows its slices. The delivery becomes Done only after every slice is
Done; a reviewer pass or the first merged PR is insufficient. An explicit status edit stays
authoritative over derived progress. Creating a project, importing a delivery or changing
its grouping never starts an agent.

Source links identify tracker items. Pull request links identify execution results; a
Slack permalink or tracker URL is not presented as a pull request. Blockers identify work
that must finish before a slice can enter automatic execution.

## Planning a task

Use **Plan** before starting work when the request needs clarification. Houston opens a
planning agent in the provider's read-only mode with the task, project context and repository.
The proposal contains a description, acceptance items, file pointers, exclusions and open
questions. Planning does not edit code or start implementation.

Answer the questions and approve the proposal to apply it to the task. Approval belongs to
the revision the planner read: if the task changed, refresh and plan again rather than
applying an obsolete proposal. Approval and execution are separate actions.

## Starting a task

A task detail's **Start** button launches an agent for the task. A ready slice has a
workspace, at least one acceptance item, no unanswered planning question or unresolved
tracker conflict, and no unfinished blocker. An unready task shows what is missing. An
explicit **Start anyway** can bypass the content checks for a manual start; automatic
execution and the queue never bypass them. A workspace is always required.

For an unassigned task, choose a workspace before starting. Houston creates a git
worktree on `houston/task/hou-<n>-<slug>` under the workspace’s `.houston/worktrees/` directory, starts the chosen
agent there, exports `HOUSTON_TASK` with the task key and names the pane `HOU-<n> <title>`.
The task moves to **In progress** and the detail shows the run: its attempt, provider,
branch and pane. Starting again after a stop, or **Resume** after a restart interrupted the
pane, reuses the same branch and worktree as the next attempt; nothing is force-pushed.

Settings ▸ Tasks carries the workspace's defaults: the agent a Start uses, and how the
brief is delivered. **Send** (the default) submits the brief as the pane's first prompt.
**Prefill** types it into the input box without sending it, so you can review and press
Enter yourself.

The brief includes the task's key, title, description, acceptance list, source links and
project context. Imported project descriptions are labelled unverified; local decisions
and corrections are kept separately. Its
text is wrapped in explicit data markers so the agent treats it as untrusted data. The whole
brief is capped; a task too large to fit is refused by name instead of truncated.

A pane can also take a task with `hs-task claim` or the `task_claim` tool: that records the
claiming pane as the run and assigns an unassigned task to that pane’s workspace. A second pane is refused while that run is live. When the work
is done the agent hands the task back (or you hand it back yourself); Houston writes the
summary as a comment, warns in that comment when the task changed after the run started, and
moves the task to **In review**. If a pane exits without handing back, its run is marked
interrupted and the task stays in progress.

Every five minutes Houston checks in-review tasks that have a branch: it runs `gh pr view`
in the task's worktree, and a merged pull request moves the task to **Done**. `gh` missing
or not signed in leaves the task in review and states why on the run; it never closes a task
on its own.

## The queue and review

A top-level agent pane that may spawn children can work the backlog through MCP:
`task_execute` starts one task assigned to its own workspace as its child (the same worktree and brief as Start) and
`task_review` opens an independent reviewer for a run. The Children roster's queue runs the
next tasks in that orchestrator’s workspace: it picks the top ready tasks — todo with no unfinished blocker, priority order,
then oldest — and starts them as children of that pane. Content readiness checks also apply.
This is all or nothing: when the
pane has fewer free child slots than asked, nothing starts and the refusal names the cap,
the free count and the requested count. Nothing is queued silently.

Review is off by default. Settings ▸ Tasks ▸ Review sets the workspace's default reviewer
(none) and the automatic **rework rounds** (0, at most `TASKS_REWORK_ROUNDS_MAX`). A task
an orchestrator starts with a reviewer gets an independent, read-only reviewer on the same
branch once the implementer hands back; the reviewer's input is the task text, the
acceptance list, the diff range and the implementation summary, labelled untrusted. A pass
writes a verdict comment and leaves the task **In review** for you. A fail writes the
findings as a comment and marks the run as needing review; **Retry** opens the next attempt
in the same worktree with those findings attached. With rework rounds above zero Houston
retries automatically, at most that many rounds, and records each round in the task's
history. The reviewer never closes a task.

The implementing child reports through a short structured line in its final handoff; that is
how acceptance items are ticked by name, the summary is kept as a comment and the task moves
to review.

## Agent access

Settings ▸ Tasks controls whether agents running in a workspace may read and write the backlog. **Off** withholds them entirely, **Read only** lets them look but not change, and
**Read and write** allows both. The current value is shown on the settings row and in the
Tasks tab's menu, and a write that the setting refuses names the setting that has to change.
Changing access applies to the workspace selected in the sidebar, and open agent sessions
learn about the change immediately: the tools appear or disappear from their list.

Agents can list and read every task in the global backlog, including tasks in progress in
other workspaces. They can create and change tasks only in their own workspace or when
unassigned. A write to another workspace’s task is refused with the task key, workspace and
the rule: “tasks of another workspace are read-only to agents”. Per-workspace access still
gates those agents, and children never get task tools.

Removing a workspace preserves its tasks and history and makes those tasks unassigned.
Open runs in that workspace become interrupted with a visible workspace-removal reason.
Assign a workspace again before starting or resuming.

## Agents and the backlog

An agent working in a workspace with access can use the backlog through MCP tools —
`task_list`, `task_get`, `task_next`, `task_create`, `task_update`, `task_comment`,
`task_check`, `task_claim` and `task_handback`, plus `task_execute` and `task_review` while
it may spawn children — or, when its provider cannot use MCP, through the `hs-task` helper.
Every tool that takes an `id` accepts either the task key (`HOU-42`, case-insensitive) or the numeric id, resolved globally. Reading another workspace’s task does not grant permission to change it.
`task_claim` moves a backlog or todo task to **In progress**
and records which pane took it; `task_handback` writes the agent's summary as a comment and
moves the task to **In review**. Agent create and update operations cannot mark a task
**Done**. Completion comes from a merged pull request or an explicit user decision.
Task text an agent reads is labelled untrusted data, and each text field is capped so one
task cannot fill the agent's context. Child panes of an agent have no task tools at all:
their scope is the brief they were spawned with.

`hs-task` usage:

    hs-task next
    hs-task ls [--mine] [--ready] [--status S] [--query TEXT] [--limit N]
    hs-task show [HOU-n]
    hs-task add TITLE [-p 1|2|3|4] [--parent HOU-n] [--description T]
    hs-task claim [HOU-n]
    hs-task comment [HOU-n] TEXT
    hs-task check [HOU-n] ITEM          (ITEM is the 1-based acceptance position)
    hs-task handback [HOU-n] --summary T
    hs-task ask QUESTION                (a Slack-filed task: asks in its thread)

The task key defaults to `$HOUSTON_TASK` when a task started the pane; otherwise pass
`HOU-n`. Priorities are `1` urgent through `4` low.

## What leaves the machine

Tasks live in Houston's local database as a global backlog. A task's title, description and
acceptance reach a hosted agent CLI when an agent with access reads them or you start the
task. Planning sends the task and project context to the planning CLI;
a default or per-task reviewer sends the task text, the acceptance list and the
implementation summary to the reviewer CLI as well. Access is per workspace and starts at
**Read and write**. An agent's write is recorded with the pane's codename and role, so the
attribution survives the pane.

Tasks filed from Slack mentions are described in [Slack requests](slack.md), including
what that connection sends.

While a task is in review with a run branch, Houston runs the GitHub CLI (`gh pr view`)
in that task's worktree every five minutes. The request uses your `gh` credentials.
With `gh` absent or signed out the task stays in review with a visible reason.

Tracker connections are optional and configured per workspace. Their polling and
write-back run only when enabled. Imported text is stored as a snapshot; a remote change
appears as a divergence. If the same field changed locally and remotely, Houston keeps
both values until you resolve the conflict. Disabling a connection stops synchronization
and keeps the local tasks.

### GitHub Issues

The connection reads matching issues using your authenticated GitHub CLI. Creating a task
for a connected workspace can send its title and description to GitHub as a new issue.
Synchronization sends delivery status and links associated with its work. A delivery may
have several slice pull requests: each PR references the issue, and the daemon closes the
issue after all slices are Done. A single slice merge does not close an unfinished delivery.

### Notion

The connection reads only the configured task and project data sources, filtered to the
configured assignee and active statuses. Store the internal integration token through the
workspace settings; Houston keeps it in the OS keychain. Property mappings use property
IDs. Write-back sends delivery status using existing options, pull request links and a
handback summary as a comment. It does not synchronize comments in both directions.

Bitbucket issue synchronization, two-way comment synchronization and acting as a
delegable Linear or Jira agent are unsupported.
