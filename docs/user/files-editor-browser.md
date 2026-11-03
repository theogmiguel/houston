# Files, editor and browser panes

Besides terminal sessions, a grid can hold Files and editor panes. Browser, Files, Changes,
Pull request and Linked pull requests are also available as side-panel surfaces.

## Side panel

Open the side panel and choose **Browser**, **Files**, **Changes**, **Pull request** or
**Linked pull requests** from the surface launcher. It can also hold closable orchestration
overviews. Use the launcher keys `B`, `F`, `D`, `P` and `L` while the empty launcher is
focused, or press the prefix key followed by the matching letter from a terminal. Tabs
remain available per workspace. Drag the panel divider to resize it; double-click resets
its width. Maximize the panel for more room; restore it to return to its previous width. Escape
returns focus to the grid.

Ctrl-click a file path in a terminal to open it in Files at the linked line and column.
Files uses that session's workspace, including when the session belongs to a different
checkout. Choose **Open in editor pane** to move the file into the grid.
Use `Ctrl+P` (`Mod+P`) outside a terminal to open Quick Open. In a focused terminal, press
the prefix key and then `F` to open the Files surface; Quick Open is available there as well.
Type to search, use Up/Down or hover to highlight a result, and press Enter to open it.
Focus stays in the search field while moving through results. Escape closes Quick Open.

Use `Ctrl+Shift+F` (`Mod+Shift+F`, rebindable in Settings ▸ Shortcuts) outside a terminal to
search file contents in the selected workspace. It searches the same files as Quick Open:
in a Git repository, tracked and untracked files that `.gitignore` does not exclude. Results
are grouped by file with the matching line text. Toggle **Match case** (`Alt+C`), **Match
whole word** (`Alt+W`) or **Use regular expression** (`Alt+R`). Up/Down moves through
matches and Enter opens the file in an editor pane at the matching line. The search skips
binary files, symbolic links and files over 1 MB. It stops at 1,000 matching lines,
20,000 searched files or 5 seconds, and names the limit it reached; refine the query to
see the rest. A newer query replaces a running one.

When the Files area is at least 720 pixels wide, the tree and editor sit side by side.
Drag their divider to resize the tree, or double-click it to reset. Tree width and
collapse state are remembered per workspace. Collapse the tree for more editing room;
**Show tree** restores it. `Ctrl+Alt+T` toggles the tree while Files is focused.
Narrower panels keep the tree above a single viewer.

Filter files by name without case sensitivity; matching rows retain their visible
ancestors. Escape clears the filter. Breadcrumb folders reveal their location in the tree.
Click a file to preview it; another click replaces that preview. Double-click or edit to
keep the file in its own tab. Tabs show unsaved changes. Close with the tab button or middle-click;
unsaved changes require confirmation. Files keeps up to
12 tabs, replacing the oldest clean preview at the limit. If every tab is pinned or
unsaved, close a tab before opening another. Terminal file links open pinned tabs.
Closing the last view releases its document; reopening reads the file from disk.
Discard and Close abandons edits when that was the last view. If another tab or
editor pane shares the file, its edits remain available there. Moving a tab to an
editor pane preserves the shared document.

## Files pane

A Files pane is a directory tree next to a tabbed editor, in one grid cell. Opening a
file from the tree adds a tab and shows it in the editor half of the pane. The file's
contents are shared with any plain editor pane open on the same path — editing it in one
place shows the change in the other, live.

The tree marks changed entries with their Git status: M modified, A added, U untracked,
D deleted, R renamed and ! conflicted. A folder carries the most severe status among its
descendants, and Git-ignored entries are dimmed. Status reflects the same working-tree
changes the Changes surface reads.

The context menu creates a file or folder inside the selected folder (or beside a
selected file), renames the entry, or deletes it. Rename works in place; F2 starts it
from the keyboard. Delete asks for confirmation and permanently removes the entry,
because the server has no trash location to restore from across every platform. Escape
cancels an inline name. Drag an entry onto a terminal to paste an `@path` reference;
directories keep a trailing slash and paths with spaces are quoted. The same context menu
also opens an entry, reveals it in the file manager, opens it in an editor, or adds its
path to the chat.

Saves check the file's content revision atomically. When another process changes an
unsaved file, Houston keeps your edits and offers Reload or Overwrite. Returning focus
to the window also checks for external changes. If you edit or save while Reload is
reading the file, Houston keeps the current document and asks you to review and retry.

The tree continues refreshing during sustained filesystem activity. Large change bursts
trigger a rescan; open files are checked against disk without replacing unsaved edits.
Search returns a completed scan even if more changes arrive while it runs. It reports
an error when indexing exceeds its file, traversal, path-storage or Git time limits.
Overlapping searches share the same index scan. Houston allows two index scans and
two searches at a time; when these limits are reached, Quick Open shows the error.
Choose **Retry** after the current work finishes, or refine the query.

## Editor pane

An editor pane holds a single file. It shares the same underlying buffer as a Files
pane's editor half, so a file open in both places never drifts out of sync.

An image opens fitted to the pane and zooms from that fit up to 800%. Scroll over it to
zoom around the pointer, drag to pan a zoomed image, and double-click to switch between
fit and 100%. When the image has keyboard focus, `+` and `-` zoom, `0` fits and `1` shows
it at 100%; these keys are not captured anywhere else. The control in the corner shows
the current zoom and returns to fit.

## Browser surface

A browser tab is a real browser surface in the side panel, and an agent can drive it:
click, type, hover, press a key, or select an option, the same way it can type into a
terminal pane. Browser panes saved in a grid move into the side panel when the layout is
loaded.

The Browser surface starts with a new tab and lists recently used pages and, on Linux,
loopback servers started by live sessions in that workspace. Select a server to open its
root page. Detection reads local process and socket state; it does not send this information
over the network. Other platforms do not show the local-server list. Switching tabs or
closing the side panel hides browser surfaces without closing them; closing a browser tab
releases its webview. Up to eight native webviews can be open at once. A refusal names the
limit, current count and requested browser; close a browser tab before retrying.

Opening a URL from a terminal link, source control, the launcher or an agent creates a
new browser tab and loads the requested page. Add Browser again, or press the prefix
key followed by `B`, to open another tab.

The first browser tab on a machine downloads Houston's headless Chromium build (about
127 MB) from `storage.googleapis.com` and unpacks it under Houston's channel directory.
The browser area shows the download percentage, or that it is unpacking, while this runs.
If the download, its size or SHA-256 check, or the unpack fails, the area names the step
that failed instead of leaving an empty page. Nothing is downloaded while no browser tab
is open.
Browser tabs and their URLs are remembered separately for each workspace. Page popups
open another side-panel tab. Agents reveal the exact tab when opening or selecting a tab,
capturing it or requesting confirmation for an element action. Reading, navigating,
reloading and scrolling existing tabs keep your selected workspace and panel in place.
Closing a tab also removes its saved state.

Use Shift-click on Reload to bypass the page cache, or open the current page in the
system browser. Full screen expands the current browser; Escape returns to the panel.

If a page cannot be reached, the browser shows the failed host and a retry action in the
page area. For a refused loopback connection, it names the port and suggests starting the
server. Show details to view the raw error, attempted URL and failure count.

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
hover, key-press, option-select or drag actually lands, before it runs script in the page,
uploads a file or answers a page dialog, Houston stops and asks you to confirm it. Reads
(like taking a snapshot of the page), navigation and viewport changes do not ask.

### What the confirmation shows

The prompt names the page's origin, so you see where the action happens without relying
on the agent's word for it, and exactly what will be touched: the specific element, and
for a type action, the full text about to be inserted, never truncated. If no browser
pane is open, the action is denied at once. If a pane is open but nobody answers within
two minutes, the action is denied on its own — an unattended prompt never becomes an
approval by waiting it out. Navigation and reload dismiss pending confirmations, including
a navigation the page starts itself, and an approval only applies to the page address the
prompt showed.

### Trusting a conversation

Approving a prompt can also mark the conversation trusted on that site for the rest of the
session, which skips the gate for further actions in that conversation on the same origin.
Trust never carries over to another site, conversation or workspace you haven't approved, lives only in memory, and is
gone the next time Houston starts — it is not a permanent grant. A denial never grants
trust, even if the trust box was checked. Settings ▸ Privacy & data ▸ Browser pane data
shows how much cookie/login/cache data browser panes have kept on this channel, and lets
you clear it.
