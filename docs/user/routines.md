# Routines

A routine runs the same instructions on a schedule or whenever you choose **Run now**. Each
run opens a fresh agent pane in the selected working directory, so its terminal and result
remain visible like any other session.

Open **Routines** from the left rail and choose **New routine**. Give it a name and
instructions, then choose:

- when it runs;
- the working directory;
- the agent provider and optional model;
- the access level;
- whether every run gets an isolated worktree.

Reasoning effort appears only when the selected provider exposes it for an individual run.
An unsupported provider or access combination is refused with the setting that needs to
change.

## Access and isolation

**Accept edits** uses the provider's bounded unattended mode. **Full access** never asks for
approval and is therefore available only with isolation enabled in a Git working directory.
The isolated worktree keeps that run away from the tree you are editing.

## Running and reviewing

Use **Run now** to start the same execution path used by the schedule. Pause a routine to
keep its definition and stop future scheduled runs.

Expand a routine's history to see each run's trigger, status, time and error. A run with a
session link can reopen its pane. Runs do not reuse a previous conversation or context.

Houston runs at most three routines at once and queues due work until a slot is free. If the
daemon was not running when a schedule elapsed, the routine runs once when the daemon returns;
it does not replay every missed interval.
