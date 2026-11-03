# Houston docs

Documentation for using and contributing to Houston on Linux and Windows.

Documentation on `main` follows the current source, including changes awaiting a release.
For an installed build, use the documentation at its version tag from the
[releases page](https://github.com/theogmiguel/houston/releases).

## Using Houston

- [Installing Houston](user/install.md) — requirements, the desktop app, providers and first
  run
- [Threads and grids](user/threads-and-grids.md) — projects, threads, grids, the sidebar and
  agent-to-agent work
- [The right panel](user/right-panel.md) — Files, Diff, Browser, pull requests, side chat and
  the browser's consent model
- [Agent status](user/agent-status.md) — how Houston reports agent state and provider
  readiness
- [Context](user/context.md) — where a thread's context use is shown, and what it reads
- [Tasks](user/tasks.md) — the queue, projects, sources, planning and handback
- [Settings](user/settings.md) — every settings page and what it controls
- [Environments and task sources](user/connections.md) — machines, access, Slack, GitHub
  issues, Notion and secrets
- [Changes](user/changes.md) — the Git surface, branches, worktrees and stashes
- [Pull requests](user/pull-requests.md) — requests, review, checks and the merge queue
- [Usage](user/usage.md) — token, cost and limit figures, and what they do not cover
- [Keybindings](user/keybindings.md) — defaults, conditions and terminal keys
- [Appearance](user/appearance.md) — themes, typography, chat and diff settings
- [Notifications](user/notifications.md) — thread and in-app notices
- [Updating Houston](user/updating.md) — the update check, and the one-time Houston 1 import

## Working on Houston

Start with the [development runbook](operations/development.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md). The rules that bind a change, and the reasons
behind them, are in [`AGENTS.md`](../AGENTS.md).

Internals pages carry the constraints and traps the source cannot explain on its own. Most
changes need no internals change; before adding a paragraph, ask what a contributor would
get wrong without it.

- [Architecture overview](internals/overview.md) — process model, boundaries, repository
  map
- [Renderer](internals/renderer.md) — shell, layout tree, terminal engine, transport,
  watchdog
- [Invariants](internals/invariants.md) — the rules, what enforces them, and why
- [Glossary](internals/glossary.md) — the words that collide
- [Testing](internals/testing.md) — where tests live, how to read a failure
- [Style guide](internals/styleguide.md) — tokens, typography, layout, components, motion
- [Style guard](internals/style-guard.md) — how the renderer rules and baselines work, and
  how to lower the ratchet
- [CSS conversion patterns](internals/css-conversion-patterns.md) — cookbook for large
  styling sweeps

### Runbooks

- [Development](operations/development.md) — first checkout, channels, `dev.sh`, the gates,
  desktop artifacts
- [Release](operations/release.md) — versions, tags, the draft release, install
- [Linux testbed](operations/linux-testbed.md) — the VM from a Windows host

What changed for a user is in each release's generated notes on the
[releases page](https://github.com/theogmiguel/houston/releases).
