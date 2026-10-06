# Agent status

## How Houston knows

Houston learns what an agent is doing from lifecycle hooks and supported native
provider reports. The CLI itself reports a turn starting, a turn finishing or a
request for input. Nothing about a pane's status is guessed from what is printed
on screen.

## The statuses

A pane can show:

- **Spawning** — the session just started; Houston is waiting for the first report from
  the CLI.
- **Working** — a turn is in progress.
- **Idle** — ready for another prompt after the provider confirmed startup readiness
  or reported that the turn ended.
- **Needs input** — the agent asked a question or is waiting on a permission decision. It
  stays in this state until you address it; providers that report the answer move back to
  Working immediately.
- **Status unavailable** — the CLI did not report lifecycle within the startup window.
  Inspect the pane for startup or trust requests and check its hook setup. A parent
  receives a startup notice; missing reports do not prove that human input is needed.

A CLI with no hook support shows none of this: its pane runs, but never reports Working,
Idle or Needs input. Claude Code reports tool questions, permission prompts and MCP
elicitations. Codex reports approvals, interruptions and `request_user_input` questions.
OpenCode reports permissions, structured questions, busy/retry, completion and errors.
Starting a supported CLI from a shell pane gives it that provider’s reported status
and orchestration capabilities once its first hook arrives.

Quiet or prolonged approval review is a warning on ongoing work, rather than a request
for your input. A live child can show Done or Failed while its process remains open;
its result may still be pending delivery to its parent.

The pane and grid indicators use the same language: blue pulse for starting or working,
neutral gray for ready, amber for needs input, and a hollow gray dot when status is
unavailable. Green is reserved for successful completion and red for failure. A grid's
tooltip lists the contributing pane states, so the indicator does not rely on color alone.

On Linux with user systemd, Codex 0.160.0 and later use a private app-server for each
pane while keeping the normal Codex terminal. Houston confirms startup readiness from the provider's
thread status, so a restored pane can become Idle before its first turn. Hook review
still belongs to Codex: a pane waiting for review stays unconfirmed.

Older Codex versions, hosts without user systemd, other platforms and custom launches
use lifecycle hooks only.
Native Codex profiles (`--profile`), explicit remote endpoints and unsupported CLI
flags also keep the hook path, with a notice in the terminal. Houston account profiles
remain supported. Codex delays its startup hook until the first turn; on these fallback
paths, inspect the pane and send the first prompt directly. Queued delivery waits for
reported Idle. Houston does not read prompt text to infer readiness.

## Settings ▸ Agents

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

- **Claude Code** — adds managed lifecycle hook entries to each workspace Houston opens.
- **Codex** — writes `~/.codex/hooks.json`, one entry per lifecycle event. An existing
  `notify` line in your `config.toml` is parked (commented out) rather than overwritten,
  and restored when you turn the hook off. Codex also requires you to accept the hook
  once in its own review screen before it actually runs — open any Codex pane to confirm
  it. Reopening a pane or reinstalling unchanged hooks preserves that decision.
  Changed hook definitions require another review in Codex.
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
