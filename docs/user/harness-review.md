# Harness review

A harness review reads a workspace's recent agent sessions, compares them with the workspace's
agent harness (CLAUDE.md, AGENTS.md, `.claude/rules` and its subdirectories, skills, settings,
hooks and MCP configuration), and reports what slowed those sessions down and what to change.
It recommends; it never edits the harness itself.

Open **Harness** in the sidebar. The view opens on the active workspace; choose another with
the workspace selector. Without an active workspace, choose one before running a review.

## What a run sends

A run is an ordinary agent pane in the workspace, which you can open and watch. Its agent calls
`hs-harness`, which writes local files under `<workspace>/.houston/harness/r<run>/`:

- `inventory.json`: the harness files, their sizes and headings, rule paths, skills (including
  your user-level copies in `~/.claude/skills`), permission lists, hook counts and MCP servers.
- `digest.jsonl`: one line per Claude Code or Codex session whose working directory is this
  workspace or below it, within the run's window: your prompts, the skills and subagents used,
  tool failures, permission denials with the command that was denied (secrets in it masked),
  interrupts, counts of the automatic messages the CLI injected, and the last assistant message.
- `decisions.json`: the findings earlier reviews raised and what you decided about each.

The agent reads those files, which sends their content to the review's provider through that
provider's own CLI, as any turn of that agent does. The view shows this before the first run.
OpenCode, Cursor, Grok, Antigravity and ZCode sessions are not read, and ZCode cannot run a
review: its first prompt is pasted into its interface, which an unattended run cannot confirm.

## Running and scheduling

The first time, choose the provider, an optional model and a schedule, then **Run first
review**. Afterwards, **Run review** starts a run now and **Schedule** changes the provider,
model and schedule. Every run spends tokens, so a review runs only when you press the button
or after you choose a schedule.

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
- **Prepare fix** shows a prompt for the change, which you can edit, and opens an agent pane in
  the workspace with it. Opening the pane does not mark the finding resolved.
- **Run history** lists every run with its window, sessions, findings and status. A run that
  ended without publishing shows as failed, with the reason. A finished run does not mean its
  findings are resolved.
- **Full report** renders a review's `report.md`, and opens it or `findings.json` in the editor
  or in the file manager.

## Removing reviews

Delete the routine in **Routines** to stop runs. Delete `<workspace>/.houston/harness/` to
remove every report, digest and inventory; the directory is ignored by Git. The findings and
decisions Houston keeps stay listed, but their reports can no longer be opened.
