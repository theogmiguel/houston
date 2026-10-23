# Routines

A routine runs the same instructions on a schedule or whenever you choose **Run now**. Each
run opens a fresh agent pane in the selected working directory, so its terminal and result
remain visible like any other session.

Open **Routines** from the rail. **Built in** contains a Weekly review entry and a Night shift
entry, each showing how many workspaces have it enabled; **Yours** contains routines you
create. Choose **New routine** for your own instructions. Give it a name and instructions,
then choose:

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

## Night shift

Night shift runs an orchestrator agent on a workspace for a window, usually overnight. The
orchestrator researches the focus areas you choose, plans, starts worker panes in their own
worktrees, gates each change and opens pull requests. Houston writes its brief, enforces the
window and the budget, and leaves a morning report. Night shift never merges anything
itself.

Select **Routines ▸ Built in ▸ Night shift**, pick a workspace (it must be a Git repository)
and choose **Set up Night shift**. The routine is created paused with these defaults:

| Setting | Default |
|---|---|
| Window: start, wrap-up, hard stop | 23:30, 06:45, 07:30 (local time, at most 16 hours) |
| Nights | None: it runs only with **Run now** until you choose nights and turn it on |
| Focus levels | Reliability and performance Normal; UI and UX polish, competitor gaps, platform parity, docs accuracy and test gaps Off |
| Goal | Empty; a Claude orchestrator receives it as `/goal <goal>`, typed before its brief |
| Orchestrator, reviewer | Claude (Opus); the reviewer is the same as the orchestrator. The orchestrator is Claude, Codex or OpenCode: a ZCode orchestrator is refused because a pull request watch cannot wake it to follow CI |
| Workers, in fallback order | ZCode, then Claude; Cursor, Antigravity and Grok are refused because they report no usage limit |
| Live workers | 4; a reviewer and a QA pane may run beside them, and Houston refuses a spawn past that |
| Output | Draft pull requests only, grouped by theme, up to 5 changes each, screenshots for visible changes |
| App check: start command, address or story, smoke flows | None; App QA is off until a start command is set |
| Checks before hand-back | None; at least one is required before a run starts |
| Safety cap | 60 pane-hours |
| Questions at night | Parked for the morning report |

Change the settings in the **Setup** view and choose **Save**. Unsaved edits survive
updates from elsewhere; if the settings changed in another window meanwhile, **Save** is
refused and **Discard changes** loads the current ones. The routine is changed and started
only here: the generic routine edit and Run now refuse a Night shift routine.

**Merge queue** output hands ready pull requests to the workspace's merge queue; it is
refused until the workspace has a merge queue verification command and Night shift has an
App check. With **Pull requests only**, the run's panes cannot add a pull request to the
queue. With **Hold for my QA** on, a visible change stays out of the queue until you choose
**Mark QA passed** in the report, which adds it after the earlier pull requests of the
suggested merge order that are queued; if adding it fails, it stays held and you can mark
it again.

The run's panes also count against the orchestration caps in Settings ▸ Agents ▸
Orchestration: the child panes per agent must allow the live workers plus two, and workers
start their own children only when the nesting depth allows it.

### Running

**Run now** asks for a duration and runs preflight first. Preflight lists every check with
its limit and actual value; **Start** stays disabled, naming how many items to fix, while any
item blocks:

- agent spawning is off (Settings ▸ Agents ▸ Orchestration);
- a chosen provider's CLI is missing or its hooks are off (Settings ▸ Agents ▸ Hooks);
- the machine is on battery;
- less than 6 GiB of memory or 20 GiB of disk is free;
- no check before hand-back is configured.

On Windows, preflight warns when a restart is pending or when the run's own window (Run
now's duration, or the nightly window) reaches outside Windows Update active hours. On Linux
it warns when `systemd-inhibit` is missing. A refused run is recorded with its items and
opens no pane, and its notice says why it did not start. A scheduled start missed while the
machine was off runs once if Houston is back before wrap-up.

A run opens the orchestrator with full access in an isolated worktree under the workspace's
`.houston/worktrees/`; its panes appear in the workspace's grid. At wrap-up Houston
tells it once to start nothing new and write the report; **Wrap up now** does the same
immediately. At the hard stop, at the safety cap, or when you confirm **Stop**, Houston
closes every pane the run started and then the orchestrator. A run that ends any other way,
by publishing its report or by its orchestrator exiting, closes them too. The run's panes
cannot hand off a pane outside it. While a run is in flight Houston keeps the machine awake
(a system-required power request on Windows, an idle and sleep inhibitor on Linux) and
releases it when the run ends or the daemon exits. Pane-hours count time while Houston
runs; a gap while the machine slept is not charged.

The **Live run** view shows the time left, the timeline with any interruptions, the crew
and their status, the machine's free memory and disk and the plan board. When a worker's
provider reports its usage limit, later spawns in the run use the next worker provider and
the orchestrator is told once. Houston never spends a provider's quota reset.

ZCode reports no usage limit, so Houston probes it: when a run whose workers include ZCode
starts, and when a ZCode pane has been Working for 20 minutes without ending a turn, it runs
one `zcode -p` request with the prompt "Reply with the single word OK." and no tools. A
failed probe (a spent quota, a signed-out CLI, or no answer within 90 seconds) marks ZCode
limited for the run; at the start it is also recorded as a warning on the run. Each probe
sends that one prompt to your ZCode provider.

If the daemon restarts during a run, the run continues when the orchestrator pane is still
running (a Linux daemon handover keeps it), or when the daemon is back before wrap-up and
the orchestrator pane was restored: held instructions resume, keep-awake is taken again and
the interruption is recorded. Otherwise the run ends with the interruption recorded.

### Morning report

When a run ends, Houston shows one notice such as "7 PRs, 2 decisions"; **Open report** opens
the **Morning report**. It lists the parked decisions with answer buttons (an answer is
final), pull requests grouped by theme with their gates, the suggested merge order, events
such as interruptions and limits, and the cost in pane-hours per provider. Checks and CI are
what ran; review and QA are agents' verdicts. A pull request whose CI failed on a test the
ledger lists as flaky is re-run once.

Every run's ledger (plans, pull requests, deferred and rejected work, lessons and flaky tests)
is kept in Houston's database, and the next run's brief includes earlier pull requests and
what became of them (merged, closed, or not merged yet), deferred and rejected entries,
lessons and flaky tests, so it does not repeat them. Houston learns a pull request's fate
from its watch during the run, or with `gh pr view` when the next run starts. The orchestrator writes the
report to `<state directory>/night-shift/<run>/report.md`, beside the `brief.md` it was given.

The orchestrator sends its prompts, the repository files it reads and its tool output to its
provider through that provider's own CLI, like any agent pane. Worker panes do the same with
their providers.
