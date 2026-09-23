# Houston docs

Two halves. The first is for using Houston; the second is for working on it.

## Using Houston

- [Installing Houston](user/install.md) — requirements, the desktop app, and what Houston
  installs into each agent CLI (and how to undo it)
- [Panes and grids](user/panes-and-grids.md) — workspaces, sessions, splits, scrollback
- [Agent status](user/agent-status.md) — how Houston knows what an agent is doing, and
  Settings ▸ Agent setup
- [Context](user/context.md) — the pane-header indicator that shows context use, which
  providers it covers, and how to hide it
- [Orchestration](user/orchestration.md) — letting an agent open and drive other panes
- [Routines](user/routines.md) — scheduling repeatable work in an agent pane
- [Changes](user/changes.md) — the git surface
- [Files, editor and browser panes](user/files-editor-browser.md) — the three non-terminal
  pane types, and the browser pane's consent model
- [SSH](user/ssh.md) — a remote shell in a pane, and what that does not cover
- [Dictation](user/voice.md) — local and cloud engines, and what leaves the machine
- [Usage](user/usage.md) — token and cost figures, and what they do not cover
- [Keybindings](user/keybindings.md) — what is rebindable, and passing keys through
- [Appearance](user/appearance.md) — themes, the window background, terminal settings
- [Updating Houston](user/updating.md) — the update check, and the signed click that installs

## Working on Houston

Start with the [development runbook](operations/development.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md). The rules that bind a change, and the reasons
behind them, are in [`AGENTS.md`](../AGENTS.md).

Internals pages carry the constraints and traps the source cannot explain on its own. Most
changes need no internals change; before adding a paragraph, ask what a contributor would
get wrong without it.

- [Architecture overview](internals/overview.md) — process model, boundaries, repository
  map, budgets
- [Daemon](internals/daemon.md) — sessions, the PTY pipeline, scrollback, persistence, loops
- [Agent lifecycle](internals/agent-lifecycle.md) — hooks, drop files, status, liveness
- [Orchestration](internals/orchestration.md) — MCP, `pane_*`, credentials, caps, `hs-pane`
- [Renderer](internals/renderer.md) — shell, layout tree, terminal engine, transport,
  watchdog
- [Invariants](internals/invariants.md) — the rules, what enforces them, and why
- [Glossary](internals/glossary.md) — the words that collide
- [Testing](internals/testing.md) — where tests live, how to read a failure
- [Style guide](internals/styleguide.md) — tokens, typography, layout, components, motion
- [CSS conversion patterns](internals/css-conversion-patterns.md) — cookbook for large
  styling sweeps
- [Wire protocol](../protocol/protocol.md) — every message, current version

### Runbooks

- [Development](operations/development.md) — first checkout, channels, `dev.sh`, the gates,
  desktop artifacts
- [Release](operations/release.md) — versions, tags, the draft release, install
- [Linux testbed](operations/linux-testbed.md) — the VM from a Windows host

What changed for a user is in each release's generated notes on the
[releases page](https://github.com/theogmiguel/houston/releases).
