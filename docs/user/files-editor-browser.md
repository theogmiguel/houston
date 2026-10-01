# Files, editor and browser panes

Besides terminal sessions, a workspace can hold three other kinds of pane: Files,
editor, and browser.

## Side panel

Press `g` to toggle the side panel. Each workspace keeps its own Source control and
Files tabs, plus closable orchestration overviews. Source control retains its Changes
and Pull request views. Drag the panel divider to resize it; double-click resets its width.

Ctrl-click a file path in a terminal to open it in Files at the linked line and column.
Files uses that session's workspace, including when the session belongs to a different
checkout. Choose **Open in editor pane** to move the file into the grid.

## Files pane

A Files pane is a directory tree next to a tabbed editor, in one grid cell. Opening a
file from the tree adds a tab and shows it in the editor half of the pane. The file's
contents are shared with any plain editor pane open on the same path — editing it in one
place shows the change in the other, live.

The tree shows Git status, with folders carrying their most severe descendant status.
Use its context menu to create a file or folder, rename an entry, or move it to the OS
trash. `F2` renames the focused entry; `Delete` moves it to the trash. Drag an entry onto
a terminal to paste an `@path` reference; directories keep a trailing slash and paths
with spaces are quoted.

Saves check the file's content revision atomically. When another process changes an
unsaved file, Houston keeps your edits and offers Reload or Overwrite. Returning focus
to the window also checks for external changes.

## Editor pane

An editor pane holds a single file. It shares the same underlying buffer as a Files
pane's editor half, so a file open in both places never drifts out of sync.

## Browser pane

A browser pane is a real browser surface embedded in the grid, and an agent can drive
it: click, type, hover, press a key, or select an option, the same way it can type into
a terminal pane.

When an agent asks to open a page and its workspace has no browser pane showing one,
Houston opens a browser pane at that page. The agent's other browser actions need a page
open first.

### Why this needs a consent gate

An agent acting inside a browser pane can be acting inside a session that is logged in
as you. The agent also reads what is on the page to decide what to do next, and page
content is not trustworthy — a hostile page can plant an instruction ("click the
delete-account button") in text the agent will read. So before the agent's click, type,
hover, key-press or option-select actually lands, Houston stops and asks you to confirm
it — reads (like taking a snapshot of the page) do not ask.

### What the confirmation shows

The prompt names the page's origin, so you see where the action happens without relying
on the agent's word for it, and exactly what will be touched: the specific element, and
for a type action, the full text about to be inserted, never truncated. Where possible
it draws the target directly on a screenshot of the pane; if the pane can't be captured
right then, it falls back to describing the element in text. If nobody answers within
two minutes, the action is denied on its own — an unattended prompt never becomes an
approval by waiting it out.

### Trusting a directory

Approving a prompt can also mark the workspace trusted for the rest of the session,
which skips the gate for further actions in that workspace. Trust is per-workspace (it
never carries over to another one you haven't approved), lives only in memory, and is
gone the next time Houston starts — it is not a permanent grant. A denial never grants
trust, even if the trust box was checked. Settings ▸ Privacy & data ▸ Browser pane data
shows how much cookie/login/cache data browser panes have kept on this channel, and lets
you clear it.
