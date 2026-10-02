# Tasks

Tasks are a local backlog, one list per workspace. Open the **Tasks** tab in the side
panel beside **Source control** and **Files**. The list is grouped by status with a count
per group: **In progress**, **In review**, **Todo**, **Backlog**, **Done** and **Canceled**.
Each row carries a priority glyph, the task key (`HOU-1`), its title and the time since it
last changed. The **Done** and **Canceled** groups start collapsed; click a group header to
fold or unfold it. **Archived** tasks sit in a final collapsed group.

## Creating and editing

Ctrl/Cmd-click a task key (`HOU-3`) in a terminal to open that task in the Tasks tab. The
key links only when the loaded list knows it.

Choose **New task** in the tab header, or the plus on a group header to create straight into
that status. A task has a title, a description, a status, a priority and an optional parent
task. The acceptance list holds the checks the work must satisfy. Open a task to edit any of
these; changes save when a field loses focus. Only one revision is saved at a time, so if the
task changed elsewhere first, a **This task changed elsewhere** banner appears with **Reload**
before you overwrite anything.

Tick an acceptance item to check it. Comments appear in the same chronological activity feed
as the recorded changes, with a composer below. The task menu in the detail header archives
the task; an archived task shows the same menu with **Restore task**.

## Agent access

Settings ▸ Tasks controls whether agents running in a workspace may read and write its
tasks. **Off** withholds them entirely, **Read only** lets them look but not change, and
**Read and write** allows both. The current value is shown on the settings row and in the
Tasks tab's menu, and a write that the setting refuses names the setting that has to change.
Changing access applies to the workspace selected in the sidebar, and open agent sessions
learn about the change immediately: the tools appear or disappear from their list.

## Agents and the backlog

An agent working in a workspace with access can use the backlog through MCP tools —
`task_list`, `task_get`, `task_next`, `task_create`, `task_update`, `task_comment`,
`task_check`, `task_claim` and `task_handback` — or, when its provider cannot use MCP,
through the `hs-task` helper. `task_claim` moves a backlog or todo task to **In progress**
and records which pane took it; `task_handback` writes the agent's summary as a comment and
moves the task to **In review**. Neither closes a task: **Done** stays the user's decision.
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

The task key defaults to `$HOUSTON_TASK` when a task started the pane; otherwise pass
`HOU-n`. Priorities are `1` urgent through `4` low.

## What leaves the machine

Tasks live in Houston's local database, per workspace. Houston sends no task text to any
service. A task's title, description and acceptance only reach a hosted agent CLI if an
agent you allowed reads it; access is per workspace and starts at **Read and write**. An
agent's write is recorded with the pane's codename and role, so the attribution survives
the pane.
