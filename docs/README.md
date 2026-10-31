# Houston docs

Documentation for using and contributing to Houston on Linux and Windows.

Documentation on `main` follows the current source, including changes awaiting a release.
For an installed build, use the documentation at its version tag from the
[releases page](https://github.com/theogmiguel/houston/releases).

## Using Houston

- [Installing Houston](user/install.md) — requirements, the desktop app, and what Houston
  installs into each agent CLI (and how to undo it)
- [Panes and grids](user/panes-and-grids.md) — workspaces, sessions, splits, scrollback
- [Agent status](user/agent-status.md) — how Houston knows what an agent is doing, and
  Settings ▸ Agents
- [Context](user/context.md) — the pane-header indicator that shows context use, which
  providers it covers, and how to hide it
- [Tasks](user/tasks.md) — a global local backlog, workspace access, execution and review
- [MCP servers](user/connections.md) — agent configuration and connection checks in Settings
- [Changes](user/changes.md) — the git surface
- [Files, editor and browser panes](user/files-editor-browser.md) — the three non-terminal
  pane types, and the browser pane's consent model
- [Usage](user/usage.md) — token and cost figures, and what they do not cover
- [Keybindings](user/keybindings.md) — what is rebindable, and passing keys through
- [Appearance](user/appearance.md) — themes, the window background, terminal settings
- [Notifications](user/notifications.md) — turn completion and input notices, sound and platform limits
- [Updating Houston](user/updating.md) — the update check, and the signed click that installs

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
- [CSS conversion patterns](internals/css-conversion-patterns.md) — cookbook for large
  styling sweeps

### Runbooks

- [Development](operations/development.md) — first checkout, channels, `dev.sh`, the gates,
  desktop artifacts
- [Release](operations/release.md) — versions, tags, the draft release, install
- [Linux testbed](operations/linux-testbed.md) — the VM from a Windows host

What changed for a user is in each release's generated notes on the
[releases page](https://github.com/theogmiguel/houston/releases).
