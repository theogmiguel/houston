# Files, editor and browser panes

Besides terminal sessions, a workspace can hold three other kinds of pane: Files,
editor, and browser.

## Side panel

Press `g` to toggle the side panel. Each workspace keeps its own Source control and
Files tabs, plus closable orchestration overviews and browser tabs. Source control retains its Changes
and Pull request views. The pull request summary shows checks, reviews and the merge
gate. Open pull request details to browse files, leave a review, edit metadata or choose
additional actions. Drag the panel divider to resize it; double-click resets its width.
The panel can expand over the grid; Escape restores its previous width.

Ctrl-click a file path in a terminal to open it in Files at the linked line and column.
Files uses that session's workspace, including when the session belongs to a different
checkout. Choose **Open in editor pane** to move the file into the grid.

When the Files area is at least 720 pixels wide, the tree and editor sit side by side.
Drag their divider to resize the tree, or double-click it to reset. Tree width and
collapse state are remembered per workspace. Collapse the tree for more editing room;
**Show tree** restores it. `Ctrl+Alt+T` toggles the tree while Files is focused.
Narrower panels keep the tree above a single viewer.

Filter files by name without case sensitivity; matching rows retain their visible
ancestors. Escape clears the filter. Breadcrumb folders reveal their location in the tree.
Click a file to preview it; another click replaces that preview. Double-click or edit to
keep the file in its own tab. Tabs show Git status and unsaved changes. Close with the
tab button or middle-click; unsaved changes require confirmation. Files keeps up to
12 tabs, replacing the oldest clean preview at the limit. If every tab is pinned or
unsaved, close a tab before opening another. Terminal file links open pinned tabs.

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

A browser tab is a real browser surface in the side panel or the grid, and an agent can drive
it: click, type, hover, press a key, or select an option, the same way it can type into
a terminal pane.

Press `b` to open a browser tab in the side panel. Move to grid and Move to side panel
change its placement in either direction. Switching tabs or closing the side panel hides
its browser surfaces without closing them; closing a browser tab releases its webview.
Up to eight native webviews can be open at once. A refusal names the limit, current count
and requested browser; close a browser tab before retrying.

When an agent asks to open its first page, Houston opens a browser tab in the side panel.
Navigation to an existing hidden browser reveals that exact tab before loading the page.
Agent browser requests reveal a hidden browser automatically before operating on it.

Desktop fits the available browser area. Phone previews use a 393 × 852 viewport and
Tablet previews use 820 × 1180, scaled to fit with the current zoom shown. On hosts
without device zoom, including older binaries, Phone and Tablet are disabled and their
tooltips show the host refusal. Device zoom affects the page only.

The address bar labels HTTPS pages secure, loopback pages local, and other pages not
secure. This label describes the connection, not whether the page content is trustworthy.
Select element hands the page selection and your instruction to the focused live agent.
Without an agent target, selection is disabled and its tooltip explains how to enable it.

On Windows, browser panes use WebView2. Manual navigation, back, forward and
reload are available. The element picker and agent DOM actions currently return
an unsupported-platform error because isolated script worlds are unavailable in
the Windows implementation. Reloading without cache is also unsupported.

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
