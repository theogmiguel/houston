# Files, editor and browser panes

Besides terminal sessions, a workspace can hold three other kinds of pane: Files,
editor, and browser.

## Files pane

A Files pane is a directory tree next to a tabbed editor, in one grid cell. Opening a
file from the tree adds a tab and shows it in the editor half of the pane. The file's
contents are shared with any plain editor pane open on the same path — editing it in one
place shows the change in the other, live.

## Editor pane

An editor pane holds a single file. It shares the same underlying buffer as a Files
pane's editor half, so a file open in both places never drifts out of sync.

## Browser pane

A browser pane is a real browser surface embedded in the grid, and an agent can drive
it: click, type, hover, press a key, or select an option, the same way it can type into
a terminal pane.

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
