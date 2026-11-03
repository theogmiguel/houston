# Tasks

Tasks are a project backlog. Open **Tasks** from the sidebar. The count beside it is the
number in **Your turn**.

## Views

The Tasks page has three views:

- **Queue** groups work as **Your turn**, **Agents working**, **Stopped**, **Up next** and
  **Backlog**, each row with its next action. Done and archived tasks are folded below the
  list under **Done and archived**.
- **By project** lists each project's deliveries, their slices, then ungrouped tasks. It
  shows delivery count and slice progress and opens the project editor.
- **Sources** shows where work comes from: Slack requests, per-project GitHub issues and
  Notion, unresolved tracker conflicts and each source's state.

Search by title or key, and scope the list to one project or **All workspaces**. Select a
task to open its detail in the right panel; the task's URL carries its key.

## Task fields

A task has a title, description, status, priority, project, kind, an optional parent
delivery, and an acceptance list. Kinds are **Delivery** and **Slice**; a slice names its
parent delivery and a delivery groups slices. Priorities are **Urgent**, **High**,
**Medium**, **Low** and **No priority**.

Statuses are **Backlog**, **To do**, **In progress**, **In review**, **Done** and
**Canceled**. Starting, handing back and merging move a task; you can also set its status
directly.

Each task gets a key such as `HOU-42`. Keys are unique, and a task keeps its key when its
project changes. `Ctrl`-click a key in a terminal to open that task.

Acceptance items are the checks the work must satisfy. Tick them in the detail panel, or
have the implementing agent tick them during handback. Comments and recorded changes share
one activity feed.

The editor saves with **Save task**. The status, priority, kind and project pills in the
detail save as you choose them. If the task changed elsewhere first, a **This task changed
elsewhere** banner appears with **Reload** before you overwrite anything.

## Creating and editing

Choose **New task** in the Tasks page, or **New task** in the command palette. The editor
sets the title, description, status, priority, project, kind, parent delivery and acceptance
list. A task without a project is unassigned; **Workspace** in its detail assigns one.

**New project** in the **By project** view creates a project grouping for tasks. The
project editor sets the project name, a tracker description and local decisions, opens the
tracker in the system browser and archives the project. Local decisions and corrections are
kept separately from the tracker's unverified description.

## Starting, planning and review

**Start** launches a thread for the task in a new worktree. The branch is
`houston/task/hou-<number>-<slug>`, and the thread is named after the task key and title.
Starting again after a stop, or **Resume** after an interrupted run, reuses the same
worktree and branch.

**Start** is refused while the task has no project, no verifiable acceptance item, an
unanswered planning question, an open planning session or an unfinished blocker. The
refusal names what is missing; **Start anyway** bypasses the content checks for a manual
start, while the queue never does.

**Plan** opens a read-only planning agent with the task, project context and repository.
The proposal contains a description, acceptance items, file pointers, exclusions and open
questions. Answer the questions, then **Approve plan** to apply it. Approval and execution
are separate. **Plan** is disabled with its reason when the task cannot be planned.

An implementation attempt offers **Review with an agent** in its **…** menu. The reviewer
runs on the same branch, reads the task text and the diff, and records its verdict and
findings on the run. The reviewer never closes a task.

While a task is in review with a linked pull request, Houston watches the request. When it
merges, the task moves to **Done**. A stopped, failed or interrupted attempt can be
**Retry**ed or resumed.

## Sources

Slack, GitHub issues and Notion are configured in **Settings ▸ Task sources**; project
sources can also be opened from the **Sources** view.

- **Slack** turns a bot mention in a mapped channel into a pending task. The configured
  owner starts it with Slack's white-check reaction; another member's reaction does not
  approve it. Tokens live in the OS keychain.
- **GitHub issues** reads matching issues with your `gh` sign-in and can write delivery
  status and links back.
- **Notion** reads a configured tasks data source and writes status, pull request links and
  handback summaries.

Imported remote text is a labelled snapshot; local decisions and corrections are kept
separately. If the same field changed on both sides, Houston keeps both values until you
resolve the conflict. The **Sources** view lists unresolved conflicts and opens the task
that holds the resolver.

## Agent access

Agents in a thread reach the backlog through the server's task tools: list, get, next,
create, update, comment, check, claim and hand back, plus execute and review when the
thread may spawn children. Agents can create and change tasks in their own project or on an
unassigned task; another project's task is read-only. Task text an agent reads is labelled
as untrusted data, and every field is capped.

When an agent claims a task, it records the claiming thread and moves the task to **In
progress**. Handback writes the summary as a comment and moves the task to **In review**.
Agent operations cannot mark a task **Done**: completion comes from a merged pull request
or your own decision.

## Scheduled tasks

**Settings ▸ Scheduled tasks** runs a prompt on a schedule, optionally with a webhook.
A scheduled task survives closing the window because the server owns it. **New task** sets
the prompt, schedule, project, provider and model; each row can be enabled, run now or
deleted, and shows its next run and webhook deliveries.
