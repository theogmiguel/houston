# Panes and grids

Text pastes are limited to 65,536 UTF-16 code units (a supplementary Unicode
character counts as two). Use a file for larger content. Houston refuses input
when the connection's outgoing backlog would exceed 1 MiB and reports the current
backlog, requested size and limit. Retry after the connection drains. An accepted
paste remains one transaction, including its bracketed-paste markers.

## The model

A **session** is one PTY running an agent CLI — Claude Code, Codex, Antigravity,
OpenCode or ZCode — or a plain shell, in a project directory. A
**pane** is its cell in the grid: the place you see and type into that session. A
**workspace** is a project directory Houston knows about; every session belongs to one.
A **grid** is a named layout of panes under a workspace, so a workspace can hold several
grids for different arrangements of the same project.

## Making a workspace and opening a pane

Add a project directory as a workspace, then open a pane and pick which CLI runs in it.
Your home directory can also be a workspace. The disk root (`/`), credential directories
such as `.ssh`, `.gnupg` and `.aws`, and paths containing secrets cannot be workspaces.
A grid can also hold Files or editor panes. Browser, Changes, Pull request and Linked pull
requests are side-panel surfaces; see [Files, editor and browser](files-editor-browser.md)
and [Changes](changes.md).

## Launching sessions

Choose **New session** beside a workspace to create a new empty grid. Choose **Terminal**
or an installed agent in the empty grid to open its first pane directly. The pane **+**
menu adds more terminals or agents to the current grid. Choose model and effort inside
an agent CLI. For coordinated multi-agent work, use [orchestration](orchestration.md).

New terminal sessions support 256-colour and true-colour output even when the
launcher disables its own colours. Existing sessions retain their original
environment; restart an affected session after updating Houston.

### Workspace actions

From an empty grid or the new pane menu, choose **Add action** and enter a name, command
and optional shortcut. Houston saves actions per workspace. Run one from either list or
from the command palette's **Run** group; Houston opens a real shell pane and submits the
command there only after that creation succeeds. A refused or disconnected creation
reports an error without sending the command to another pane. Edit or delete an action from its More actions menu. Deleting asks for
confirmation.

## Terminal input

Input is delivered in order even when a program temporarily stops reading it. Other panes
and resize or termination requests remain available. Each session can admit up to 4 MiB
and 128 pending input writes, including the active write. An error names the limit if a
write cannot be admitted; retry that input after the program resumes reading. Terminating
the session cancels pending input and reports delivery failures, including any bytes
already written. Input already admitted continues after disconnecting the client. SSH input follows the
same ordering and admission rules. Cancelling an active SSH write reports that its partial
delivery is unknown; queued writes report that nothing was transferred. Cancelling an
upload may leave a partial file on the remote host; at most four uploads can be pending.

On Linux, closing an Exited pane also stops descendants still holding its terminal open
and completes the output reader. On Windows, closing an Exited pane whose terminal is still
open waits up to one second for EOF and refuses if it stays open. Restart follows the same
rule. A daemon handoff asks you to close Exited panes that still retain
output readers.

## Splitting and stacking

Split a cell to place two panes side by side, or stack several panes into one cell as a
tab strip, one visible at a time. A stack has a capacity: reaching it blocks adding
another pane to that stack until you raise the limit in Settings ▸ Terminal ▸ Panes per
stack, or open a new cell instead.

The command palette also offers **Set grid layout: 1×** through **4×**, which rearranges the
current grid's panes into an even grid with that many columns.

## Renaming a pane

Houston names panes automatically from a codename, a cleaned first prompt, a delegated role,
the CLI's native title or a bound task, in that order of precedence. Automatic/manual
provenance appears beside the name. A name you type wins and survives Restart, application
reopen and daemon handoff. Choose **Reset to automatic** beside a manually renamed pane to
restore the strongest available automatic name. Older panes may only retain their codename
and current role or task; Houston cannot recover titles that were never stored. Older
non-codename names without recorded provenance stay protected until you reset them.

Claude, Codex and OpenCode native titles are adopted when their CLIs provide contextual
window titles; supported ACP agents can also provide session titles. Product labels are
ignored. Antigravity's status-bearing window title is excluded. First-prompt cleanup and
native-title adoption add no transmission beyond the agent CLI's existing operation.

Automatic grid names follow the first pane's meaningful title, then its task key, an already loaded pull-request title or worktree
branch, with the agent label as a fallback. A grid name you type stays fixed. Clear the grid
name while renaming it to return to automatic naming. Older grids locked to an agent label
migrate to automatic naming; other custom legacy names remain fixed.

Agent panes involved in orchestration also have a stable codename. Houston shows the
codename beside the task name in the pane header and uses it in the orchestration
roster and details card. Roster entries put the codename first, followed by the
delegated role or task, so messages can be matched to a pane without translating a
numeric session ID.

When an inbox row offers a jump to a pane, Houston opens the workspace that contains
that target pane. This also works when the message was recorded in a different
workspace from the pane it names.

### Doing now and generated titles

The rail shows the latest hook-delivered prompt or reply. While an agent needs input, its
pending question takes precedence. This text does not rename the pane or change its
reported status.

Settings ▸ Workspaces ▸ Automatic titles is off by default. Enabling it requests one title
at the first turn end while the name is still a codename or first prompt, including for an
agent started inside a shell pane once its hooks report it. **Generate title**
in a pane's Terminal actions requests it manually. Generated titles rank above a prompt
and below a delegated role; native titles, task names and manual names still win. A rename,
reset, close or replacement while generation runs discards its result. Each session admits
one generation attempt, with one active generation across the daemon and a 30-second deadline.

**What leaves your machine:** up to 1 KB of redacted first-prompt and first-reply hook text
is sent through the pane's own CLI and provider account. Houston reads no transcript or
scrollback for this feature. Claude uses Haiku with tools, MCP, slash commands and session
persistence disabled, in a temporary directory. Its safe mode excludes customization files,
including global CLAUDE.md instructions and automatic memory, while preserving account
authentication. Codex, OpenCode, Antigravity
and ZCode are refused by name until equivalent controls are verified. Authentication and
billing use the CLI's existing account. A pane without both hook excerpts cannot generate
a title; excerpt availability is lost after a daemon restart. A restored account profile
whose original configuration cannot be recovered is also refused.

## Tags

A tag is a named colour you attach to mark work, such as `code review`. Choose a preset or
enter a custom `#rrggbb` colour when creating or editing a tag. Tag controls open the same
anchored popover next to the control that invoked it. Grids and panes carry tags
independently: choose **Tags** from a grid's menu to assign its tags, or use a pane's
actions or context menu to assign that pane's tags.
Adding a tag to a grid does not add it to the grid's panes, and a pane's tag does not
appear on its grid card. Each grid and each pane carries at most five tags.

The rail's tag filter keeps a grid when the grid itself or any of its panes carries an
active tag. Create, rename, recolour and delete tags from the tag popover; deleting a tag
removes it from every grid and pane that carries it.

Grids saved by a version in which a grid's tags were its panes' combined tags keep those
tags as the grid's own the first time they open; their panes' copies are removed.

## Grid cards

The Workspaces rail shows one card for each grid. **Detailed** cards show the primary
checkout, a pull request with its reported check state, branch changes, agents and tags.
The ahead count and added (`+`) or deleted (`−`) line totals appear only when non-zero.
Tags appear as named chips by default. Cards show the primary checkout and a `+N` count
for other checkouts; hover the card to see every checkout. **Condensed** cards keep the
grid name, status and unread indicators, with optional tags, pull request, checkout and
agent count; hover for the details.

Agent rows show **Waiting** when input is needed and context use as a percentage when it
reaches 80% or higher. Selecting an agent row selects its grid and focuses its pane.
With collapsed agent activity, a grid with more than three agents shows its first two
and an **N more agents** action; expand it to see the rest. Expanded activity shows the
full list. Prompt and latest-message previews stay local unless you enable generated titles or choose
**Generate title** for a pane.
The unread marker reflects inbox messages and waiting child panes, and marks a
top-level pane that finished while it was not on screen; focusing that pane clears
its finished mark. Use the marker to set a grid read or unread. **Agent activity** sort
places unread cards after cards that need input or are working.

Open the Workspaces options menu to group cards by workspace, status, pull-request state
or not at all, and sort by **Manual**, **Agent activity**, **Recent** or **Name**. Its other
options are:

- **Cards show**: choose tags, pull request and checks, branch and changes, agents or
  latest messages. Status and unread indicators are always shown.
- **Hide**: hide idle grids, grids on the default branch (`main` or `master`), or empty grids.
- **Filter by tag**: keep grids carrying a selected tag themselves or on any of their
  panes. The active filter line names the selected tags; **Clear** removes the tag filter.
  If tags are hidden, Houston offers to show them before applying the filter.
- **Manage tags…**: create, rename, recolour or delete tags.
- **Card display**: choose Detailed or Condensed cards, Expanded or Collapsed agent
  activity, and how tags appear.

Selecting a workspace row also expands it; only its chevron (or the Left and Right arrow
keys on the focused row) collapses it. `Alt+1` to `Alt+9` select the first nine cards in
the order the rail shows them (Pinned first, cards of collapsed workspaces and groups
skipped); the numbers appear on the cards while `Alt` is held. Closing the selected grid
selects the card next to it in that order. A card's menu offers **Reset to automatic name**
for a grid whose name you chose; a blank rename keeps the current name. The workspace list
scrolls without a scrollbar, and the selected grid stays listed under every filter.

Pin a grid from its card menu to place it in the Pinned section. Drag cards to reorder
them, or use `Mod+Shift+↑` and `Mod+Shift+↓` for the selected card. Manual reordering is
available only with Manual sort and within one workspace. Smart sorting waits for status
changes to settle before moving cards. Resize the rail between 220 and 500 pixels by
dragging its divider; dragging below 160 pixels collapses it, and expanding restores its
saved width.

The work destinations in the rail are **Tasks**, **Pull requests**, **Routines** and
**Usage**. Settings, theme switching and update status are separate application actions.
Hide an unneeded work destination with **Hide from sidebar**; restore it in Settings ▸ Appearance ▸ Sidebar. Hidden destinations remain available from the command palette.

Pinning or unpinning a grid or workspace, setting a grid read or unread, and hiding a work
destination show a notice with **Undo** for five seconds. Repeating the same action within
that time updates the notice with a count, such as "Unpinned 3 grids", and **Undo**
reverses all of them. A grid or workspace removed in the meantime is skipped, and a
second notice names how many could not be restored. `Ctrl+Z` is not used for this, because
it belongs to the focused terminal.

Open Settings ▸ Agents for Skills, MCP servers and Review. **Back to workspaces** returns
to the workspace view; **Esc** clears an active settings search first, then returns.

## Closing a grid

Choose **Close grid and its N agents…** from the grid menu and confirm to close a populated
grid. Closing any grid ends all its agents and shell sessions, even when other grids
remain in the workspace. Cancelling keeps the grid and its sessions. An empty grid uses
**Close grid** without an agent confirmation; closing the last grid leaves the workspace
empty.

## The branch and shared checkouts

A pane whose directory is inside a git work tree shows its checkout beside the pane title;
hover or focus the chip for its full identity. The chip updates when the checkout's HEAD
changes, including after `git switch`, without requiring a focus change. Detached HEADs
show the commit instead of a branch; directories outside a repository have no checkout
chip, and SSH sessions identify the remote host instead of a local checkout.

When other live panes share the same checkout or sit in another checkout of the same
repository, the chip's tooltip names them. This is information to consult, not a warning:
Houston never switches branches, stashes changes or moves worktrees.

## Click-to-type

Only one pane at a time receives keystrokes — the one you have clicked into. Every key
you send there reaches the agent, including Esc and Ctrl+C: Houston does not intercept
them for its own purposes. This is why Houston keeps its own keyboard shortcuts to a
minimum, and why Settings ▸ Shortcuts has a "Pass through to terminal" option — an
escape hatch for a shortcut you'd rather the agent receive than Houston. To reach a
shortcut without leaving the keyboard, press the prefix key (`Ctrl+Space`) and then the
shortcut; see `docs/user/keybindings.md`.

## Scrollback

Each pane keeps a scrollback buffer of the terminal's own output. Its size is
configurable in Settings ▸ Terminal ▸ Scrollback; raising it keeps more history at the
cost of memory. Settings ▸ Terminal ▸ Shell integration is a separate toggle for shell
prompt/command tracking in plain-shell panes.

Claude panes start in Claude Code's fullscreen renderer. Claude Code keeps the
conversation on the alternate screen and scrolls it itself with the mouse wheel, so
resizing the window redraws the pane instead of leaving repeated or rewrapped output in
the terminal's scrollback. To use Claude Code's inline renderer, turn off
Settings ▸ Workspaces ▸ Start Claude in fullscreen; Claude Code's `/tui` command then
decides. The setting applies to Claude panes started or restarted after the change.

If terminal output falls behind, Houston requests a fresh screen from the daemon. If
that screen is unavailable, it rebuilds from retained output and reports that earlier
history may be unavailable. Input resumes after either form of attach completes.

## Closing the window

Closing the window leaves the daemon and its sessions running. Settings ▸ Daemon ▸
Background controls whether Houston stays in the tray or quits its client when the
window closes. Reopen Houston to reconnect to the sessions. Tray counts include live
sessions only; ended sessions do not appear in the tray menu. **Quit and keep sessions**
in the tray exits the client directly, including when the interface is unresponsive.
When Houston detects that the interface has failed, closing the window exits the client
instead of hiding it in the tray.

To stop the running processes and exit, use **Quit and stop daemon** in the command palette,
or **Quit and stop daemons…** in the tray. Both stop the local daemon and connected WSL
daemons after confirmation. Shutdown runs independently of the interface; if a daemon
cannot be confirmed stopped, a native dialog names the failure and offers to keep Houston
open or close it while those sessions may continue. **Stop daemon** in Settings ▸ Daemon
stops the local daemon; its confirmation names the affected sessions and routines.
Stopping a daemon preserves recoverable panes and their conversation handles for the next
launch. Use Kill or Close on an individual pane to discard its continuation.

## Disk space

Settings ▸ Daemon ▸ Storage shows the size of the session database, its write-ahead log,
the free space inside the database, and the scrollback and log folders of the current
channel, measured at most once a minute. Closing panes and pruning history leaves free
space inside the database rather than returning it to the disk. **Reclaim space** compacts the database and reports its
size before and after. It runs only when you click it, only while every pane is closed or
asleep, and only when the disk has at least twice as much free space as the database and
its write-ahead log occupy; otherwise it names the condition that blocked it.

## Diagnostics for a bug report

**Settings ▸ Daemon ▸ Logs ▸ Save diagnostics file** writes a text file for a bug report
under the current channel's state directory, in `diagnostics/`, and **Show folder** opens
that folder. The file lists the app and daemon versions, the channel and platform, each
session's id, agent, state and status, the hook health of each agent CLI, and the most
recent daemon log lines. It never contains terminal output, pane titles or working
directories. Recognised secret shapes, such as tokens, keys, passwords in URLs and
`NAME_TOKEN=` assignments, are redacted, and your home directory is shown as `~`. The file
is at most 1 MiB; older log lines are left out first. Houston keeps the five newest files
and sends none of them anywhere: read the file before you attach it to an issue.

## Killing a pane

Closing a pane ends its session — the underlying PTY is torn down, not just hidden.
There is no undo for a killed session; the pane is gone from the grid along with it.
The pane leaves the grid as soon as you close it. If the daemon refuses the close, the
pane returns with the refusal shown inside it; a close the daemon does not confirm within
15 seconds is handed back the same way.

## Sleeping a pane

Sleep is a reversible way to release an idle Claude or Codex CLI while keeping the pane,
its slot, scrollback and exact conversation handle. Choose Sleep from the pane actions;
the pane remains visible and does not wake when focused. Choose Wake to resume its exact
conversation. If the provider no longer has that transcript, Wake explains why and leaves
the pane resumable; Start fresh remains a separate action.

Sleep is refused while the agent is working or waiting for input, while terminal input
is still being delivered, while orchestration or external child work is active, and for
child, routine, harness, shell and unsupported provider sessions. Non-Linux platforms
report Sleep as unavailable until graceful
process-tree shutdown is supported there.

Choose **Measure process memory** from an agent pane's actions to read its current process-tree
PSS on Linux. An unavailable reading is shown as unknown rather than a partial total.
The sleeping placeholder retains the last prompt, agent message and reported context size;
the provider owns transcript retention, so the expiration time is shown as unknown.
Sleeping panes remain asleep after a daemon restart or reboot.

## Idle and restore behavior

Settings ▸ Workspaces ▸ Close idle background sessions can end sessions that have sat
idle in the background, after the "Idle for" duration you set. Settings ▸ Workspaces ▸
Restore budget caps how many top-level sessions Houston brings back automatically after a
shutdown or crash. Their eligible children recover with them; safe mode disables automatic
restoration.

A restored or restarted session comes back in the same cell: the same grid, split and
stack, including repeated restarts while the application is closed and All workspaces.
While a WSL environment reconnects, Houston keeps its saved grid positions and workspace
selection until that environment reports its sessions. Terminal input to an unavailable
environment is refused; it is not queued for later delivery.
It runs on the same agent profile. If that profile has been deleted, it runs on the
default account and no longer shows the profile's name. Explicit model, reasoning effort
and approval choices made in Houston survive recovery. Choices changed inside a CLI or
commands typed manually into a shell are controlled by that CLI.

Claude, Codex and ZCode panes reopen their exact conversation after a shutdown or crash, whether
working or waiting for input, once that conversation has had a prompt. The CLI restores
its history and waits for your next input; Houston does not resend a prompt or repeat an
interrupted tool. Settings ▸ Workspaces ▸ Resume conversations when restoring panes turns
this off. Codex requires native hooks that report the session ID and transcript path;
older CLIs without those fields start fresh. ZCode records its conversation only while
its hook toggle is on (see [Install](install.md#zcode)); a ZCode pane that ran without it
has no conversation to reopen, and a child pane in that state says so in its restore
notice to its parent.

Restart offers Resume conversation and Start fresh when a pane holds a conversation.
Start fresh, Kill and Close each forget it. If its transcript is gone, its folder changes,
its agent profile was deleted, another pane already has it open, or the resumed CLI exits
with an error within 10 seconds, a top-level pane starts fresh and says why. An orchestration
child whose conversation fails to resume remains ended and reports the failure to its parent;
it never substitutes an empty conversation for its mission. Changing the folder
or changing its profile's configuration directory discards the old conversation handle.
Losing the profile also discards it. A shell pane with a validated Claude, Codex or ZCode
conversation can relaunch that conversation inside its shell; orchestration children stay
deferred when the parent's conversation cannot resume. The relaunch needs a POSIX shell
(sh, bash, zsh, dash or ksh), so Windows shell panes cannot relaunch a conversation: there
Resume conversation is refused naming the shell, Start fresh starts the shell without the
conversation, and at startup the pane waits for a manual restart. Other agents, shells
without a validated conversation and routine runs start fresh. Sessions beyond the restore
budget remain available for manual restart.

A pane that was not restored shows its saved output dimmed with one line at the bottom:
**This conversation could not be resumed.**, with **Try again** (resume) and **New
conversation** (start fresh). Hover or focus the sentence for the reason. Both buttons
are disabled while Try again is running, and a refusal replaces the sentence in place. An
SSH pane offers **Reconnect** instead. A pane that fell back to a fresh conversation shows
**Started a new conversation; the previous one could not be resumed.** once, until
dismissed.

Panes that had already exited remain ended after reopening Houston, with their saved
output available. They do not launch an agent automatically. Killed and closed panes do
not return through recovery.

A conversation belongs to its recorded provider and folder. Switching agents inside a
shell cannot reuse the previous agent's conversation. If a pending conversation update was
damaged when Houston stopped, the pane resumes the last conversation Houston had stored. If
an update cannot be saved to Houston's database, only that pane stays visible with a reason;
fix the reported problem and retry, or explicitly choose Start fresh or Close. A provider launched with a custom command
also waits after a daemon restart: Houston does not save arbitrary command arguments.
Start fresh launches that provider's standard command.

After a crash, an update or an unexpected close, panes resume automatically. Processes
that a previous Houston daemon left running in a pane can no longer receive input, so
Houston stops them before it restores, restarts or closes that pane. On Linux with a
systemd user session this covers every process the pane started, including background
servers and detached jobs; elsewhere, including Windows, Houston stops the pane's own
process and its foreground jobs, and detached background processes may keep running. A
pane that cannot be restored shows its reason without holding back the other panes.
Pending missions still require explicit resume.

Saved terminal output follows an automatically restored pane. Output since the last
checkpoint can be lost after an abrupt daemon exit, and provider conversation history
depends on the provider's own storage. A power failure can also lose recent writes that
had not reached storage; recovery does not promise to repeat or complete interrupted tools.
