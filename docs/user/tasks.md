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

**Blocked by** lists the tasks this one waits for: add one from the picker, remove one with
its chip. A blocker that already waits for this task is refused, since the two could never
start. A task with children shows how many are done beside its title (`2/3`); a canceled
child leaves the count. Use a parent task to group the slices of one delivery.

The detail lists the external items a task mirrors, such as the Slack request or the GitHub
issue it came from; click a link to open its page.

A task created from a Harness finding keeps its source finding key and review. Tasks made from
Harness show that origin in their details and list rows. A finding can have several linked fix
tasks over time; only one linked task may remain open at once.

Tick an acceptance item to check it. Comments appear in the same chronological activity feed
as the recorded changes, with a composer below. The task menu in the detail header archives
the task; an archived task shows the same menu with **Restore task**.

## Starting a task

A task is **ready** when it has a workspace, at least one acceptance item, no open question
and no unfinished blocker. An open question is an acceptance item that starts with `[?]`, for
example `[?] Which endpoint does the form call?`; rewrite the item once it is answered. A task
filed from Slack needs no acceptance item, because its triage writes its own. Start refuses a
task that is not ready and names what it lacks; **Start anyway** on that message starts it
regardless. Agents and the Slack owner's accept never start a task that is not ready.

A task detail's **Start** button launches an agent for the task. Start requires a workspace;
for an unassigned task, choose one beside the agent before starting. Houston creates a git
worktree on `houston/task/hou-<n>-<slug>` under the workspace’s `.houston/worktrees/` directory, starts the chosen
agent there, exports `HOUSTON_TASK` with the task key and names the pane `HOU-<n> <title>`.
The task moves to **In progress** and the detail shows the run: its attempt, provider,
branch and pane. Starting again after a stop, or **Resume** after a restart interrupted the
pane, reuses the same branch and worktree as the next attempt; nothing is force-pushed.

Settings ▸ Tasks carries the workspace's defaults: the agent a Start uses, and how the
brief is delivered. **Send** (the default) submits the brief as the pane's first prompt.
**Prefill** types it into the input box without sending it, so you can review and press
Enter yourself.

The brief is assembled from the task's key, title, description, acceptance list and links,
and its text is wrapped in explicit data markers so the agent treats it as untrusted data. For
a task linked to a GitHub issue the brief also asks for `Closes <owner>/<repo>#<n>` in the
pull request, so merging it closes the issue. The whole
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
next tasks in that orchestrator’s workspace: it picks the top ready tasks — todo and ready as described above, priority order,
then oldest — and starts them as children of that pane. This is all or nothing: when the
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
moves the task to **In review**. Neither closes a task: **Done** stays the user's decision,
and an agent's `task_update` or `task_create` with status `done` is refused. `task_update`
also sets `blocked_by` (task keys) and reads it back from `task_get`.
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
    hs-task ask --question Q --option A --option B [--option …] --recommended N
                [--why T] [--context T]  (a Slack-filed task: asks in its thread)

The task key defaults to `$HOUSTON_TASK` when a task started the pane; otherwise pass
`HOU-n`. Priorities are `1` urgent through `4` low.

## GitHub Issues

Settings ▸ Tasks ▸ GitHub Issues connects a workspace whose git remote is on github.com to its
repository's issues. It is off by default and works through your own `gh` login; Houston keeps
no GitHub token. The settings show the current state, the repository, the last sync and the
last error.

- **Import issues**: open issues carrying the **Label**, and open issues assigned to your
  `gh` user, become **Backlog** tasks linked to their issue. The issue's unchecked task-list
  items (`- [ ]`) become acceptance items. An issue is imported once; later edits on GitHub
  do not overwrite the task. Importing never starts a task.
- **Open an issue for every new task**: a task you create in that workspace opens an issue
  with its title, description and acceptance list. Without it, choose **Open GitHub issue**
  in a task's menu.
- When a linked task is handed back, Houston comments on its issue once per run with the
  branch and the pull request `gh` finds for it.

## What leaves the machine

Tasks live in Houston's local database as a global backlog. Houston sends no task text to any
service unless a workspace's GitHub Issues connector is on, as described below. A task's title, description and acceptance only reach a hosted agent CLI if an
agent you allowed reads it, and the brief a Start submits reaches the agent you started;
a default or per-task reviewer sends the task text, the acceptance list and the
implementation summary to the reviewer CLI as well. Access is per workspace and starts at
**Read and write**. An agent's write is recorded with the pane's codename and role, so the
attribution survives the pane.

Tasks filed from Slack mentions are described in [Slack requests](slack.md), including
what that connection sends.

Tasks makes these network calls on its own, all through the GitHub CLI with your `gh`
credentials:

- The merge check: while a task is in review with a run branch, Houston runs `gh pr view` in
  that task's worktree every five minutes. With `gh` absent or signed out the task simply
  stays in review.
- With a workspace's GitHub Issues connector on, Houston lists that repository's open issues
  with the label and assigned to your `gh` user (`gh api`), every minute while the app is
  open and every five minutes otherwise; an unchanged list costs no GitHub rate limit. It
  sends the title, description and acceptance list of a task it opens an issue for, and a
  comment with the task key, the branch name and the pull request link when a linked task is
  handed back. Nothing else from the backlog is sent.
