# Routines

A routine runs the same instructions on a schedule or whenever you choose **Run now**. Each
run opens a fresh agent pane in the selected working directory, so its terminal and result
remain visible like any other session.

Open **Routines** from the rail. **Built in** contains one Weekly review entry showing how
many workspaces have it enabled; **Yours** contains routines you create. Choose **New
routine** for your own instructions. Give it a name and instructions, then choose:

- when it runs;
- the working directory;
- the agent provider and optional model;
- the access level;
- whether every run gets an isolated worktree.

Reasoning effort appears only when the selected provider exposes it for an individual run.
A provider that the selected access does not support is listed as unavailable, with the
reason and the access it needs. Any other unsupported combination is refused with the setting
that needs to change.

Upgrading preserves routines with duplicate names from older versions. The first keeps
its name; later duplicates receive a suffix containing their routine ID. Schedules,
instructions and run history are preserved.

## Access and isolation

**Accept edits** uses the provider's bounded unattended mode. OpenCode and ZCode have none:
ZCode's edit mode stops at every shell command for an approval nobody gives, so both run
only with full access, and they are unavailable in the provider list until you choose it.
While one of them is selected, **Accept edits** is unavailable and isolation cannot be turned
off. **Full access** never asks for approval and is therefore available
only with isolation enabled in a Git working directory. The isolated worktree keeps that
run away from the tree you are editing.

## Running and reviewing

Select a routine to see its schedule and run history. Use **Run now** to start the same
execution path used by the schedule; the button shows **Starting…** until Houston reports
the run. Pause a routine to keep its definition and stop future scheduled runs. The detail
view shows when all three run slots are occupied and a due routine is waiting.

For routines in **Yours**, run history reports each run's start time, result and duration. A run with a session link can
reopen its pane. Runs do not reuse a previous conversation or context.

Houston runs at most three routines at once and queues due work until a slot is free. If the
daemon was not running when a schedule elapsed, the routine runs once when the daemon returns;
it does not replay every missed interval.

## Weekly review

Houston offers one built-in [Weekly review](harness-review.md) per workspace. It reviews
recent agent sessions and recommends improvements to the workspace's agent configuration.
Select **Weekly review** to see the workspaces where it is set up, including paused reviews,
with their schedules and next and last runs. Choose **Set up for a workspace** and select a
workspace that has no review yet. Setup chooses its provider, optional model and schedule
without starting a run immediately. Settings ▸ Agents ▸ Review also supports setup and an
explicit first run.

In the selected workspace's review, choose **Daily**, **Weekly** or **Only when I
run it**. Daily runs at 09:00; Weekly runs on Mondays at 09:00. Only when I run it turns
scheduled runs off while retaining the saved cadence. **Run now** starts an explicit run.
**Enabled** pauses or resumes scheduling without deleting the routine; provider and model
can be changed separately.

During a run, Houston reports the workspace and any available session count and lets you
open its pane. Recent runs report their session and finding counts, or say when those
counts were not reported. **Open report** reads a published result; failed reads can be
retried, and a truncated report points to the complete copy in the workspace. Findings are available in Review and in
Tasks' Suggested work; creating a task from one does not start implementation.

Reviews read from the previous review checkpoint, subject to the review window limits;
**Weekly review** names the built-in routine and does not imply a fixed seven-day input
window. See [Review](harness-review.md#running-and-scheduling) for coverage and provider
transmission.
