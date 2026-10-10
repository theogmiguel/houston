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

**Accept edits** uses the provider's bounded unattended mode. OpenCode and ZCode have none:
ZCode's edit mode stops at every shell command for an approval nobody gives, so both run
only with full access. **Full access** never asks for approval and is therefore available
only with isolation enabled in a Git working directory. The isolated worktree keeps that
run away from the tree you are editing.

## Running and reviewing

Select a routine to see its schedule and run history. Use **Run now** to start the same
execution path used by the schedule; the button shows **Starting…** until Houston reports
the run. Pause a routine to keep its definition and stop future scheduled runs. The detail
view shows when all three run slots are occupied and a due routine is waiting.

The run table shows each run's start time, result and duration. A run with a session link can
reopen its pane. Runs do not reuse a previous conversation or context.

A workspace's [harness review](harness-review.md) is also a routine. It is created from the
**Harness** view and listed here too, where it can be edited, paused or deleted like any other.

Houston runs at most three routines at once and queues due work until a slot is free. If the
daemon was not running when a schedule elapsed, the routine runs once when the daemon returns;
it does not replay every missed interval.
