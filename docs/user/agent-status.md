# Agent status

## How Houston knows

Houston learns what an agent is doing from lifecycle hooks and supported native
provider reports. The CLI itself reports a turn starting, a turn finishing or a
request for input. Nothing about a pane's status is guessed from what is printed
on screen.

## The statuses

A pane can show:

- **Spawning** — the session just started; Houston is waiting for the first report from
  the CLI. A ZCode pane stays here until its first prompt, because ZCode reports its start
  only with its first turn.
- **Working** — a turn is in progress.
- **Idle** — ready for another prompt after the provider confirmed startup readiness
  or reported that the turn ended.
- **Needs input** — the agent asked a question or is waiting on a permission decision. It
  stays in this state until you address it; providers that report the answer move back to
  Working immediately.
- **Status unavailable** — the CLI did not report lifecycle within the startup window,
  or Codex hooks are off, missing or have unconfirmed trust at launch. Check the operator
  note and hook setup. A parent receives a startup notice; missing reports do not prove
  that human input is needed.

A CLI without hooks can still report status using the Program Status Protocol below.
Without either reporting path, its pane runs without lifecycle updates. Claude Code
reports tool questions, permission prompts and MCP elicitations. Codex reports approvals,
interruptions and `request_user_input` questions.
OpenCode reports permissions, structured questions, busy/retry, completion and errors.
Starting a supported CLI from a shell pane gives it that provider’s reported status
and orchestration capabilities once its first hook arrives.

Quiet or prolonged approval review can show **Stalled** with a muted gray dot. This is a
heuristic about ongoing work; its tooltip names the observed reason. Amber remains
reserved for requests for your input. A live child can show Done or Failed while its
process remains open;
its result may still be pending delivery to its parent.

The pane and grid indicators use the same language: blue pulse for starting or working,
neutral gray for ready, amber for needs input, and a hollow gray dot when status is
unavailable. Green is reserved for successful completion and red for failure. A grid's
tooltip lists the contributing pane states, so the indicator does not rely on color alone.

Screen readers announce the focused pane's reported status when it changes: working, needs
your input, finished, or ready. They also announce how many other panes need you when that
number changes. Moving focus to another pane announces nothing; a status that changes back
within 1.5 seconds is not announced. Terminal output is never announced.

### Plan and rate limits

A Claude pane whose turn ends with a reported rate limit (`StopFailure` with
`error: rate_limit`) shows a neutral **Limited** detail beside its status. The tooltip names
the error and the details Claude reported. Claude's hooks report no reset time, so the
detail does not show one. It clears when the next turn starts or when Claude reports that
its own automatic continue resumed the task (`quota_auto_resume_fired`). Limited is not a
request for input and raises no alert. It is held in memory, so a daemon restart clears it.

Other providers do not show Limited: Codex, Cursor and Antigravity report no limit through
the hooks Houston installs, Grok and OpenCode report a failed turn without classifying it as
a limit, and ZCode reports no failed turn at all.

On Linux with user systemd, Codex 0.160.0 and later use a private app-server for each
pane while keeping the normal Codex terminal. Houston confirms startup readiness from the provider's
thread status, so a restored pane can become Idle before its first turn. Houston trusts
its own installed status hooks; other hooks still use Codex's review process.

On Windows, Houston launches Codex with `--no-daemon` when the installed CLI
advertises support. This keeps status hooks and tools associated with their own pane.
The same applies to ordinary `codex` commands in PowerShell, cmd and Git Bash
shell panes through a workspace wrapper. Custom launch commands, aliases and
absolute CLI paths retain their own launch policy. User sandbox and approval
settings remain unchanged.
`agents`, `queue`, `remote-control` and `--remote` launches retain the shared
server; their tools and hooks cannot be guaranteed to identify the invoking pane.
Sessions started with `--no-daemon` are absent from the shared agent overview.
Older CLIs without this flag retain their original launch behavior.

Interactive Codex typed into a contained Linux shell, older Codex versions, hosts
without user systemd, other platforms and custom launches use lifecycle hooks only.
On Linux, native Codex profiles (`--profile`), explicit remote endpoints and unsupported CLI
flags also keep the hook path, with a notice in the terminal. Houston account profiles
remain supported. Codex delays its startup hook until the first turn; on these fallback
paths, inspect the pane and send the first prompt directly. Queued delivery waits for
reported Idle. Houston does not read prompt text to infer readiness.

## Program Status Protocol

On Linux and macOS, a program inside a pane can report its own state through the
[Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status)
(OSC 7501, revision 0.3). Houston answers its support probe and consumes reports even
when the pane is hidden or the application is closed. Programs that do not emit this
protocol continue to use their existing reporting path. Windows does not advertise
support; lifecycle hooks and supported provider reports remain available.

`working` becomes Working and `blocked` becomes Needs input. `idle`, `done` and
`error` become Idle; these reports do not deliver a delegation result or end a provider
turn. When several records exist, blocked takes precedence over working. Clearing the
last record makes status unavailable. Shell prompt boundaries discard ongoing work
records; completed and error records remain until cleared or the terminal resets.

Lifecycle hooks take precedence from the first hook until the pane respawns. ACP
sessions always use ACP status. No switch or CLI configuration change is required for
this fallback. Houston reads explicit state fields, never visible terminal text; it
keeps at most 64 records per pane and drops report message text. Consuming reports sends
no report content to an external service. The support-probe reply returns through
the session's existing terminal connection, including SSH for remote sessions. A terminal
multiplexer may suppress the probe or reports; then the program cannot negotiate this fallback.

## Settings ▸ Agents ▸ CLIs

This screen lists every CLI Houston knows how to wire, and what each row means. It
opens with the result of the last check, which Houston also makes when it starts, and
updates in place when checking again finds a CLI installed, removed or upgraded:

- **Not found on PATH** — the CLI is not installed on this machine, so there is nothing
  to turn on.
- **Installed · hooks on** — the hook is present and Houston will get status updates.
- **Installed · hooks off** — the CLI is here but you have not turned the switch on.
- **Installed · hooks need attention** — the switch is on but the hook is missing,
  mismatched, or something Houston did not expect — "the file may have been edited
  outside Houston."

Each row also shows the account the CLI is signed in to, and each account card under
the list shows the identity of that directory. Checking again re-reads these files. Houston
reads only an identifier and never changes the file:

- **Claude Code** — `oauthAccount.emailAddress` (and `organizationName`) in `~/.claude.json`,
  or in `.claude.json` inside `CLAUDE_CONFIG_DIR` and each account profile directory.
- **Codex** — the email and plan in the `id_token` of `auth.json` in `CODEX_HOME`
  (default `~/.codex`) and each account profile directory. An API-key sign-in shows
  "API key" with no identifier.
- **OpenCode** — the provider names in `auth.json` under `$XDG_DATA_HOME/opencode`
  (default `~/.local/share/opencode`). OpenCode 2 moves credentials into its own database,
  which Houston does not read, so a missing file shows "Sign-in unknown".
- **Antigravity** — only whether `~/.gemini/antigravity-cli/antigravity-oauth-token`
  exists. This location is unverified against Antigravity's own documentation, so the row
  reads "Signed in (unverified)", and a missing file shows "Sign-in unknown" because the
  token may be in the OS keyring.
- **ZCode** — "Sign-in unknown"; its sign-in storage is not documented.

Below the accounts, **Default view** chooses whether a Claude session you open yourself
(new pane menu, empty grid, command palette or a handoff) starts as a terminal or as a
thread; the selected value is the current one, and Terminal is the default. Review and
check agents and panes started by an agent stay terminals; see
[threads](panes-and-grids.md#moving-a-conversation-between-views).

Tokens and keys are never stored in Houston's database, written to logs or sent anywhere.
The identifier is read on demand, shown in this screen and discarded; nothing leaves your
machine. A file that is missing, unreadable, malformed or larger than the read limit shows
"Not signed in" with the reason.

Claude Code and Codex status hooks are on by default. An explicit off setting stays off
across restarts. Turning the switch on writes into that CLI's own config, and turning
it off removes exactly what Houston added:

- **Claude Code** — adds managed lifecycle hook entries to `~/.claude/settings.json`,
  or `settings.json` in `CLAUDE_CONFIG_DIR` and Houston account profile directories.
  Hook installation requires an absolute config directory. Houston expands `~` and
  `$HOME` in account profile paths; directories that remain relative are skipped and
  reported in Settings ▸ Agents ▸ CLIs. Use an absolute profile path for status reporting.
  Claude started from any directory inside a Houston pane reports status. The commands
  exit silently when `TR_SESSION` is empty, so they do nothing outside Houston.
  With Claude Code 2.1.290 or later, Claude panes opened or resumed by Houston also report
  Esc interruptions and return to idle. Older or unknown versions, and Claude commands
  typed manually into a shell pane, keep reporting ordinary turns through hooks but
  cannot report an Esc interruption; status remains working until another prompt or
  reported turn end. Mods disabled by CLI or organization policy have the same limitation.
  Your other settings and hooks are preserved. Houston removes its old workspace entries
  from `.claude/settings.local.json` during migration to avoid duplicate events.
  Turn Claude off in Settings ▸ Agents ▸ CLIs ▸ Claude to remove its global entries;
  the setting stays off across restarts. On Windows, Claude runs these commands through
  Git Bash, so install Git for Windows before turning Claude on. Each entry allows
  30 seconds, so a slow start on a heavily loaded machine still reports its status.
- **Codex** — writes `~/.codex/hooks.json`, one entry per lifecycle event. An existing
  `notify` line in your `config.toml` is parked (commented out) rather than overwritten,
  and restored when you turn the hook off. If you add a replacement `notify` while
  hooks are on, turning them off keeps your replacement and the parked original,
  and reports a restoration conflict. Remove the replacement before retrying if you
  want to restore the original. Houston also writes a reversible managed
  block of `[hooks.state]` entries in `~/.codex/config.toml`, trusting only its own
  installed commands so Codex runs them without a `/hooks` review prompt. Other hooks
  and trust entries stay unchanged. Houston checks the saved trust against its installed
  definitions and removes its hooks if trust setup fails.
  On Windows, Codex hooks explicitly launch the Windows command interpreter, including
  when Codex uses PowerShell for its session. Git Bash is not required.
  Launches using another Codex config directory check that directory's hooks and trust.
  A new pane with hooks off, missing hooks or unconfirmed trust immediately shows
  **Unavailable**, with an operator note naming the cause. Repair the setup in
  Settings ▸ Agents ▸ CLIs ▸ Codex and reopen the pane.
- **OpenCode** — drops a small plugin file Houston owns; if one is already there and
  Houston did not write it, install refuses rather than overwriting it.
- **ZCode** — adds one entry per lifecycle event to ZCode's settings file
  (`~/.zcode/cli/setting.json` for the `zcode-app-cli` package, `~/.zcode/cli/config.json`
  for the upstream command; see [install](install.md#zcode)), turns on `hooks.enabled`
  (which also runs any hooks of yours that were switched off) and lists Houston's plugin
  for the pane tools. Turning it off removes only Houston's entries and restores
  `hooks.enabled` once no Houston channel has entries left; a `false` you set yourself
  afterwards is kept, and the row then shows that the hooks need attention.

  ZCode sends no hook when a turn fails (an API error, an exhausted Coding Plan quota, a
  network failure). An interrupt (Esc or Ctrl+C) cancels ZCode's own hooks along with the
  turn, so Houston cannot report it either. Such a pane shows Working until its next
  prompt, and a parent waiting on it gets no turn end. A question or permission is closed
  only by the result of the same tool call; another tool finishing meanwhile leaves it
  open. A denied or dismissed permission sends no hook, so the pane stays in Needs input
  until the turn ends or the next prompt starts. On Windows the entries start Houston's
  hook helper directly instead of through a shell, so status, a confirmed first prompt,
  pane tools and resume work there as well.
- **Antigravity** — also installs a hook, into its own config; it has no dedicated
  write-up on this screen beyond the generic "installs a hook for this CLI."

To repair a broken setup, use "Check again" to have Houston re-read every CLI's hooks,
then choose **Repair hooks** for the affected CLI. Open its details to inspect the
configuration path, full consent description or hooks switch.

## Agent setup

Open **Settings ▸ Agents ▸ Overview** to see reported setup problems across CLIs,
skills, MCP servers and reviews. The Settings row carries the combined attention
count; each Agents page carries its own count. Repair hooks and Check again run
the existing hook installation and MCP test actions. Other fixes open their owning page.

Agent accounts and hook settings live in **Agents ▸ CLIs**. Skills, MCP servers and
Review have separate pages in the same group. Review schedules live in Routines.
The work rail contains Tasks, Pull requests, Routines and Usage. In Settings, Escape
clears the navigation filter first, then returns to workspaces.
