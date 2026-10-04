# Harness review

A harness review reads a workspace's recent agent sessions, compares them with the workspace's
agent harness (CLAUDE.md, AGENTS.md, `.claude/rules` and its subdirectories, skills, settings,
hooks and MCP configuration), and reports what slowed those sessions down and what to change.
It recommends changes and can create a linked Tasks item from a finding; it never edits the
harness itself.

Open **Harness** in the sidebar or choose **Go to Harness** from the command palette. Select
a workspace in the sidebar first; when no workspace is active, choose one on the Harness page.

## What a run sends

A run is an ordinary agent pane in the workspace, which you can open and watch. Its agent calls
`hs-harness`, which writes local files under `<workspace>/.houston/harness/r<run>/`:

- `inventory.json`: the harness files, their sizes and headings, rule paths, skills (including
  your user-level copies in `~/.claude/skills`), permission lists, hook counts and MCP servers.
- `digest.jsonl`: one line per Claude Code or Codex session whose working directory is this
  workspace or below it, within the run's window: your prompts, the skills and subagents used,
  tool failures, permission denials with the command that was denied (secrets in it masked),
  interrupts, counts of the automatic messages the CLI injected, and the last assistant message.
- `decisions.json`: earlier findings and decisions, linked fix tasks, their landing times and the
  number of sessions started since each task landed.

The agent reads those files, which sends their content to the review's provider through that
provider's own CLI, as any turn of that agent does. The view shows this before the first run.
OpenCode, Cursor, Grok, Antigravity and ZCode sessions are not read. Harness shows their Houston-hosted
session counts for the latest review window as provider coverage.

## Running and scheduling

The first time, choose the provider, an optional model and a schedule, then **Run first
review**. Afterwards, **Run review now** starts a run. Change its provider, model or schedule
in **Routines**. Every run spends tokens, so a review runs only when you press the button or
after you choose a schedule.

For Claude and Codex, model choices use Houston's local model catalog, shared with Usage and
context estimates. The list describes model metadata and does not indicate which models your
account can use.

The first run reads the last 14 days; each later run reads from where the previous one
stopped, never less than 7 days nor more than 30. Sessions older than your CLI keeps
(`cleanupPeriodDays` in `~/.claude/settings.json` for Claude Code) cannot be read, and the
report says so.

The review is a routine, so it also appears in **Routines**, where it can be edited, paused or
deleted.

## Reading the result

When the run finishes, its agent publishes `report.md` and `findings.json` to Houston. Reviews
and your decisions are kept per workspace and remain after Houston restarts.

- **Findings** lists each problem with its evidence (how many sessions, short quotes, session
  ids), the file it concerns and the recommended change. Mark a finding **Dismissed** or
  **Resolved**, and **Reopen** it to undo that. A later review does not raise a dismissed or
  resolved finding again unless it finds new evidence; when it does, the finding reopens and says
  so.
- **Active**, **Resolved** and **Dismissed** filter findings by their current phase. An open
  finding can become a linked task; a fixing finding opens that task; a landed task can be
  checked with **Verify now**. Use **Resolve** or **Keep open** when a finding is **Not seen**.
- The Harness rail count shows findings that need attention. A notice reports a newly published
  review until you dismiss it. Dismissing advances the shared seen cursor.
- **Create task** creates a linked task in Tasks with the finding key, recommendation, target and
  apply prompt. It does not copy transcript quotes or start the task. The task uses the current
  Harness provider; start it from Tasks when you are ready.
- A task that is still open marks its finding **Fixing**. A completed task waits for a later review.
  **Verify now** runs the existing Harness routine immediately. A verdict needs at least three
  sessions that started after the task landed; below that, the result stays inconclusive. The task's
  own session is excluded from its verdict.
- **Gone** resolves the finding and adds a comment to the task. **Still present** reopens the finding
  with the review's evidence and comments on the task; the completed task stays done, and you can
  create another linked task. **Inconclusive** leaves the finding awaiting verification.
- If the latest published review omits a finding and it has no open fix task, it becomes **Not seen**
  with the review number. Resolve it or keep it open; Houston never closes it automatically.
- The Harness attention count is based on a review cursor stored by the daemon, so it is shared
  across windows and survives closing the app.
- **Reviews** shows the latest published review with its New, Still there and Gone findings.
  Expand older reviews to inspect their available finding details.
- **Full report** opens a review's `report.md`, and opens it or `findings.json` in the editor
  or in the file manager.

## Removing reviews

Delete the routine in **Routines** to stop runs. Delete `<workspace>/.houston/harness/` to
remove every report, digest and inventory; the directory is ignored by Git. The findings and
decisions Houston keeps stay listed, but their reports can no longer be opened.
