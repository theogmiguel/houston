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
Panes are not only terminals: a workspace can also hold a Files pane, an editor, a
browser pane, or a Skills pane (see `docs/user/files-editor-browser.md`). Git changes
and pull requests open in Source control beside the grid (see `docs/user/changes.md`).

## Splitting and stacking

Split a cell to place two panes side by side, or stack several panes into one cell as a
tab strip, one visible at a time. A stack has a capacity: reaching it blocks adding
another pane to that stack until you raise the limit in Settings ▸ Terminal ▸ Panes per
stack, or open a new cell instead.

## Renaming a pane

A pane's session can be renamed; the name is what you and the sidebar chips use to
identify it, independent of which agent CLI is running underneath.

## Click-to-type

Only one pane at a time receives keystrokes — the one you have clicked into. Every key
you send there reaches the agent, including Esc and Ctrl+C: Houston does not intercept
them for its own purposes. This is why Houston keeps its own keyboard shortcuts to a
minimum, and why Settings ▸ Shortcuts has a "Pass through to terminal" option — an
escape hatch for a shortcut you'd rather the agent receive than Houston.

## Scrollback

Each pane keeps a scrollback buffer of the terminal's own output. Its size is
configurable in Settings ▸ Terminal ▸ Scrollback; raising it keeps more history at the
cost of memory. Settings ▸ Terminal ▸ Shell integration is a separate toggle for shell
prompt/command tracking in plain-shell panes.

## Closing the window

Closing the window does not stop anything: the daemon and every session it owns keep
running in the background, and Houston's tray icon is what stays visible while the
window is gone. The only action that stops sessions is Quit Houston, which asks you to
confirm and names how many sessions that ends. Reopen the window and your panes are
still there, doing whatever they were doing.

## Killing a pane

Closing a pane ends its session — the underlying PTY is torn down, not just hidden.
There is no undo for a killed session; the pane is gone from the grid along with it.

## Idle and restore behavior

Settings ▸ Workspaces ▸ Close idle background sessions can end sessions that have sat
idle in the background, after the "Idle for" duration you set. Settings ▸ Workspaces ▸
Restore budget caps how many sessions Houston brings back automatically when you reopen
a workspace, rather than restoring every session that was ever open in it.
