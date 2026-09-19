# Agent status

## How Houston knows

Houston learns what an agent is doing from a small hook it installs into the CLI's own
config — never by reading the terminal. The CLI itself reports its lifecycle (a turn
starting, a turn finishing, asking you for input) back to Houston. Nothing about a
pane's status is guessed from what is printed on screen.

## The statuses

A pane can show:

- **Spawning** — the session just started; Houston is waiting for the first report from
  the CLI.
- **Working** — a turn is in progress.
- **Idle** — waiting for you: a turn finished, or output went quiet.
- **Needs input** — the agent asked a question or is waiting on a permission decision. It
  stays in this state until you address it — it is not a status that clears on its own.

A CLI with no hook support shows none of this: its pane runs, but never reports Working,
Idle or Needs input.

## Settings ▸ Agent setup

This screen lists every CLI Houston knows how to wire, and what each row means:

- **Not found on PATH** — the CLI is not installed on this machine, so there is nothing
  to turn on.
- **Installed · hooks on** — the hook is present and Houston will get status updates.
- **Installed · hooks off** — the CLI is here but you have not turned the switch on.
- **Installed · hooks need attention** — the switch is on but the hook is missing,
  mismatched, or something Houston did not expect — "the file may have been edited
  outside Houston."

Turning the switch on writes into that CLI's own config, and turning it off removes
exactly what Houston added:

- **Claude Code** — adds eight hook entries to each workspace Houston opens.
- **Codex** — writes `~/.codex/hooks.json`, one entry per lifecycle event. An existing
  `notify` line in your `config.toml` is parked (commented out) rather than overwritten,
  and restored when you turn the hook off. Codex also requires you to accept the hook
  once in its own review screen before it actually runs — open any Codex pane to confirm
  it.
- **OpenCode** — drops a small plugin file Houston owns; if one is already there and
  Houston did not write it, install refuses rather than overwriting it.
- **Cursor** — adds one entry to each of your `sessionStart`, `beforeSubmitPrompt` and
  `stop` hooks, leaving your other entries alone.
- **Grok** — writes its own hooks file under `~/.grok/hooks/`, one entry per lifecycle
  event; your own entries in that file stay, and turning Houston's off deletes only what
  it added, removing the file once nothing is left in it.
- **Antigravity** — also installs a hook, into its own config; it has no dedicated
  write-up on this screen beyond the generic "installs a hook for this CLI."

To repair a broken setup, use "Check again" to have Houston re-read every CLI's hooks,
then flip the switch off and back on for a row that shows "needs attention" — that
reruns the install.

## Settings ▸ Notifications

Desktop notifications pop an OS notification when an agent finishes, needs input, or
hits an error, for any detected agent. They are suppressed while you are looking at the
session in question. Play sound gives each alert its own sound, previewable per row
before you turn it on. If the OS has denied Houston permission to notify at all, a
**Blocked by the OS** row appears: nothing will show until you re-allow notifications for
Houston at the OS level.
