# The right panel

The right panel holds surfaces beside a thread. Open or close it with the panel control in
the thread header or `Ctrl+Alt+B`. Its tab strip has a **+** menu with **Browser**,
**Terminal**, **Files**, **Diff**, **Pull request**, **Linked pull requests**, **Device** and
**Side chat**. A thread's details card (`Ctrl+Shift+B`) is separate.

Tabs can be dragged to reorder, closed, maximized and restored. A tab's menu also closes
the others, those to its right, or all of them.

## Files and editing

The **Files** surface shows a directory tree beside a tabbed viewer. The tree marks entries
with their Git status: `M` modified, `A` added, `U` untracked, `D` deleted, `R` renamed and
`!` conflicted. A folder shows the most severe status among its descendants, and ignored
entries are dimmed.

- Filter by name; matching rows keep their visible ancestors. `Esc` clears the filter.
- Select a file to open it in its own tab.
- Open a file from a terminal path at its line and column.
- The context menu creates a file or folder, renames (`F2`), deletes, reveals in the file
  manager, opens in an editor, or adds the path to the chat.
- Delete asks first and removes the entry permanently; there is no trash to restore from.
- Drag a tree entry onto a terminal to paste an `@path` reference.

Saves check the file's content revision. If another process changes an open file, Houston
keeps your edits and offers **Reload** or **Overwrite**. Returning focus to the window also
checks for external changes.

## Diff

The **Diff** surface shows the thread's working-tree changes. **Uncommitted** compares the
working tree; a base comparison shows the branch against its upstream base. Stage, unstage,
discard, commit and push act on the selected checkout. See [Changes](changes.md).

## Browser

A **Browser** tab is a preview browser driven by the thread's agent. The first tab on a
machine downloads Houston's headless Chromium build and shows its progress; a failed
download, size or checksum check names the step that failed.

- The address bar labels HTTPS pages **Secure**, loopback pages **Local**, and other pages
  **Not secure**. The label describes the connection, not the page's trustworthiness.
- On Linux the start page lists loopback servers started by threads in the project.
- **Full screen** expands the page; `Esc` returns to the panel.
- Browser tabs and their URLs are remembered per project. **Settings ▸ Browser** sets
  profiles, viewport, zoom, appearance, link target, search engine and whether agents may
  drive browsers.

### Agent actions need consent

Page content is untrusted, and the page may be signed in as you. Before an agent clicks,
types, hovers, presses a key, selects an option, runs page script, uploads a file or answers
a page dialog, Houston asks you to confirm. The prompt names the page's origin, the element
and, for typing, the full text. If no browser tab is open the action is refused at once; if
nobody answers within two minutes it is refused. Navigation and reload discard pending
confirmations, and an approval applies only to the page address it showed.

Approving can also trust the conversation on that site for the rest of the session. Trust
does not cross to another site, conversation or workspace, lives only in memory and is gone
after a restart. A refusal never grants trust.

## Pull request

The **Pull request** tab shows a request linked to or opened from the thread: status, author,
source and target branches, checks, activity, files and the merge box. **Linked pull requests**
lists every request linked to the thread. See [Pull requests](pull-requests.md).

## Side chat

**Side chat** opens a read-only aside beside the thread. It can read the conversation and
the project, but cannot edit files, run commands or interrupt the run. **Second opinion**
from a reply uses the same read-only side-thread mechanism.

## Terminal

The **Terminal** tab holds shell sessions in the thread's checkout. The thread's terminal
drawer (`Ctrl+J`) is the quicker way to run a command; both use the same project context.
