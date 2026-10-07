# Panes and grids

## The model

A **session** is one PTY running an agent CLI — Claude Code, Codex, Antigravity,
OpenCode, Cursor or Grok — or a plain shell, in a project directory. A
**pane** is its cell in the grid: the place you see and type into that session. A
**workspace** is a project directory Houston knows about; every session belongs to one.
A **grid** is a named layout of panes under a workspace, so a workspace can hold several
grids for different arrangements of the same project.

## Making a workspace and opening a pane

Add a project directory as a workspace, then open a pane and pick which CLI runs in it.
Your home directory can also be a workspace. The disk root (`/`), credential directories
such as `.ssh`, `.gnupg` and `.aws`, and paths containing secrets cannot be workspaces.
A grid can also hold Files or editor panes. Browser, Diff, Pull request and Linked pull
requests are side-panel surfaces; see [Files, editor and browser](files-editor-browser.md)
and [Changes](changes.md).

## Launching sessions

Open the launch composer from a grid action. It docks beside the current grid so you can
preview the resulting panes before starting them. Choose **This grid** to add sessions to
the current layout or **New grid** to start a separate layout. Hover a preset to preview
its slots, choose an agent for each slot, and optionally enter one task shared by every
agent. Press Ctrl+Enter in the task field or choose **Launch** to start the sessions.

Each slot shows its model, effort and checkout, with the source of each value. Workspace
routing applies to matching roles; a route that a selected provider cannot use is shown
as skipped with its reason. A launch with an invalid slot is blocked until you correct it.

New terminal sessions support 256-colour and true-colour output even when the
launcher disables its own colours. Existing sessions retain their original
environment; restart an affected session after updating Houston.

### Workspace actions

From an empty grid or the new pane menu, choose **Add action** and enter a name, command
and optional shortcut. Houston saves actions per workspace. Run one from either list or
from the command palette's **Run** group; Houston opens a real shell pane and submits the
command there. Edit or delete an action from its More actions menu. Deleting asks for
confirmation.

## Splitting and stacking

Split a cell to place two panes side by side, or stack several panes into one cell as a
tab strip, one visible at a time. A stack has a capacity: reaching it blocks adding
another pane to that stack until you raise the limit in Settings ▸ Terminal ▸ Panes per
stack, or open a new cell instead.

## Renaming a pane

A pane's session can be renamed; the name is what you and the sidebar chips use to
identify it, independent of which agent CLI is running underneath.

Agent panes involved in orchestration also have a stable codename. Houston shows the
codename beside the task name in the pane header and uses it in the orchestration
roster and details card. Roster entries put the codename first, followed by the
delegated role or task, so messages can be matched to a pane without translating a
numeric session ID.

When an inbox row offers a jump to a pane, Houston opens the workspace that contains
that target pane. This also works when the message was recorded in a different
workspace from the pane it names.

## Tags

A tag is a named colour you attach to mark work, such as `code review`. Choose a preset or
enter a custom `#rrggbb` colour when creating or editing a tag. Tag controls open the same
anchored popover next to the control that invoked it. Grids and panes carry tags
independently: a grid's tags are set from its card, and a pane's tags are set from the
pane's actions or context menu.
Adding a tag to a grid does not add it to the grid's panes, and a pane's tag does not
appear on its grid card. Each grid and each pane carries at most five tags.

The rail's tag filter keeps a grid when the grid itself or any of its panes carries an
active tag. Create, rename, recolour and delete tags from the tag popover; deleting a tag
removes it from every grid and pane that carries it.

Grids saved by a version in which a grid's tags were its panes' combined tags keep those
tags as the grid's own the first time they open; their panes' copies are removed.

## Grid cards

The navigation rail shows one card for each grid. **Detailed** cards can show the primary
pane's checkout, pull request, CI, diff totals, task, inline agents, context use and tags.
Detailed cards show the primary checkout and a `+N` count for other checkouts; hover the
card to see every checkout. The
compact layout keeps the grid name with compact status and unread indicators, plus optional
tags, pull request, checkout branch and agent count; hover it for the details card. Agent
activity can show a compact summary or the full list of agents, their prompt and latest
message. Prompt and message previews stay local to Houston.
The unread marker reflects inbox messages and waiting child panes; use it to mark a grid
read or unread. Smart sort places unread cards after cards that need input or are working.

Open **Sidebar options** to group cards by workspace, status, pull-request state or not at
all; sort manually, smartly, by recent activity or by name; choose a card layout and agent
activity display; and choose which card properties to show. Status and unread indicators
are always shown. Filters can hide idle grids, grids on `main` or `master`, empty grids or
grids without selected tags. When tags are hidden from cards, the tag filter offers to show
them before applying a tag filter.

Pin a grid from its card menu to place it in the Pinned section. Drag cards to reorder
them, or use `Mod+Shift+↑` and `Mod+Shift+↓` for the selected card. Manual reordering is
available only with Manual sort and within one workspace. Smart sorting waits for status
changes to settle before moving cards. Resize the rail between 220 and 500 pixels by
dragging its divider; dragging below 160 pixels collapses it, and expanding restores its
saved width.

The rail footer opens Settings, Pull requests and Usage, switches the chrome theme, and
has an update button for checking update status or opening its install details. Right-click
a navigation row and choose **Hide from sidebar** to remove it from the rail. Restore hidden
rows in Settings ▸ Appearance ▸ Sidebar; hidden destinations remain available from the
command palette.

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

## Closing the window

Closing the window leaves the daemon and its sessions running. Settings ▸ Daemon ▸
Background controls whether Houston stays in the tray or quits its client when the
window closes. Reopen Houston to reconnect to the sessions.

To end the sessions and exit, use **Quit and stop daemon** in the command palette,
or **Stop daemon** in Settings ▸ Daemon. Confirming names the affected sessions and
routines before stopping them.

## Killing a pane

Closing a pane ends its session — the underlying PTY is torn down, not just hidden.
There is no undo for a killed session; the pane is gone from the grid along with it.

## Idle and restore behavior

Settings ▸ Workspaces ▸ Close idle background sessions can end sessions that have sat
idle in the background, after the "Idle for" duration you set. Settings ▸ Workspaces ▸
Restore budget caps how many sessions Houston brings back automatically after a shutdown
or crash. Settings ▸ Workspaces ▸ Restore budget controls this limit; safe mode disables
automatic restoration.

A restored or restarted session comes back in the same cell: the same grid, split and
stack, including repeated restarts while the application is closed and All workspaces.
It runs on the same agent profile. If that profile has been deleted, it runs on the
default account and no longer shows the profile's name.

Claude and Codex panes reopen their exact conversation after a shutdown or crash, whether
working or waiting for input, once that conversation has had a prompt. The CLI restores
its history and waits for your next input; Houston does not resend a prompt or repeat an
interrupted tool. Settings ▸ Workspaces ▸ Resume conversations when restoring panes turns
this off. Codex requires native hooks that report the session ID and transcript path;
older CLIs without those fields start fresh.

Restart offers Resume conversation and Start fresh when a pane holds a conversation.
Start fresh, Kill and Close each forget it. If its transcript is gone, its folder changes,
its agent profile was deleted, another pane already has it open, or the resumed CLI exits
with an error within 10 seconds, the pane starts fresh and says why. Changing the folder
or changing its profile's configuration directory discards the old conversation handle.
Losing the profile also discards it. Other agents, shells and
routine runs start fresh. Sessions beyond the restore budget remain available for manual
restart.
