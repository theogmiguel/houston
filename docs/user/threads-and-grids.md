# Threads and grids

A **project** is a folder Houston runs work in. A **thread** is a structured conversation
with one agent: a **turn** is one request and its answer, and a **run** is the provider
session that serves a thread. A **grid** is a named layout of threads in one project.

Closing the window detaches the app from the local server. Threads, runs and grids continue
on the server, and the next launch reconnects to them.

The server keeps each grid's name, layout, pin and hidden state, so a change an agent makes to a
grid appears in the open window. The window keeps a local copy for the first paint and for
grids whose server is not connected; their edits are sent when it connects.

## Adding a project

Houston starts with **Add a project to start**. Choose **Add folder** for an existing
folder, or **Clone a repository** to clone a Git URL to a chosen machine and location.
`Start without a project` opens a thread with no project; a thread without a folder can be
turned into a project from its thread actions later.

To clone into `<host>/<owner>/<repo>` folders, turn on **Clone into host folders** under
**Settings ▸ Threads**. Clones then default to that path under the add-project base directory,
and you can still change the destination before cloning.

The add-project palette, opened from **Add project** at the top of the sidebar or from the
command palette, lists **Open folder…**, **Clone repository…** and **New project…**,
followed by the provider repositories Houston can clone from. **New project…** appears when
the server configures a projects folder. Adding a project creates its **Grid 1** and opens
it with the composer ready.

**Project settings** in a thread's action menu
or the command palette renames a project, pins it, archives it and changes its checkouts.
Pinned projects lead the list.

Project actions are commands a project can run from a thread, such as a dev server, tests
or lint. Add them under **Settings ▸ Projects ▸ Actions** or from the thread's action menu.
An action with **Stop when the thread settles** turned on stops its terminal and child
processes when the thread settles; an agent's own shell command is never attached to it.

## Creating a thread

Choose **New thread** from a grid's **+**, from the command palette, or press `Ctrl+N`.
Pick the provider and model in the composer, choose permissions, and send the first
message. A new thread starts in a local checkout or in a new worktree, according to
**Settings ▸ Threads ▸ New threads**; the composer's workspace control changes it for one
thread.

The default model, fallback model and default permissions for new threads are set in
**Settings ▸ Threads**. The model picker is also bound to `Ctrl+Shift+M`.
Opening the model picker checks for newly released models and for the CLI update that supports
them, at most every five minutes. The check is skipped when provider update checks are turned
off in **Settings**.

## Grids

Each project label offers **New grid** (`+`), and each grid row offers **New thread**
(`+`). A grid holds up to six threads. The seventh is refused and names the limit; start
another grid for it.

- **Split** a cell right or down to show another thread beside it. The picker offers only
  threads that are not shown in another grid.
- **Move to…** swaps a cell with another thread in the same grid.
- **Maximize cell** gives one thread the whole grid; **Restore cell** returns the layout.
- **Close thread** (the cell's ×) closes the thread: it moves to **Closed** and keeps its
  slot, so reopening it from **Closed** (or **Undo** on the toast) puts it back in the same
  cell. On a draft cell the × just removes the cell.
- **Tidy** rearranges the cells: **Balanced grid**, **One row** or **One column**.
  **Equalize** resets every split to an even share. These are also rebindable commands.

The focused cell receives the thread shortcuts; other cells bind none. Click a cell before
using a thread shortcut.

## The sidebar

The sidebar opens with search and one row of icon buttons for **Pull requests**, **Tasks** and
**Usage** (hover for the name; the open page is highlighted), then one group per layout
workspace, in the order of the workspace switcher. A group lists the threads whose chat is
open in that workspace, whichever project they belong to. A thread whose chat is not placed in
any workspace is listed under the first one. Each group label collapses with **Enter** or
**Space** and keeps its state; a search opens every group it matches in. The **…** button
beside the label, or a right-click, opens the workspace's actions. With no projects at all, the
rail offers **Add project**.

The **Workspaces** header carries **Filter by project**, the **Hidden workspaces** menu,
**View options**, **New workspace** (**+**) and **Add project**. A workspace's menu offers
**New thread**, **Rename workspace** (`F2`), **Pin workspace** / **Unpin workspace**,
**Move workspace up** / **Move workspace down**, **Hide workspace** and **Delete workspace**.
Pinned workspaces come first. Hiding removes a workspace from the sidebar only; the workspace
switcher still lists it, and **Hidden workspaces** restores it. The last workspace cannot be
deleted: the sidebar says so in a message. Names are limited in length; a longer name is
refused with a message naming the limit.

In a phone-width browser the sidebar is the home page: the same workspace groups without the
rail's header and footer, a top bar with search and new thread, and a bottom tab bar for
**Threads**, **Pull requests**, **Usage** and **Settings**. A thread opens alone with a back
control that returns to the list.

Each group hangs its threads from a thin guide line. A collapsed group shows how many threads
it holds on its right, with an amber dot when any of them waits for you or failed; an open one
shows nothing there. Hovering or focusing a heading shows its actions, including **New
thread** (the **+** button), in place of the count. A collapsed group still lists the thread
that is open. On a narrow sidebar a thread's branch name shortens first, and the running
sub-agent count is the first item to drop from the line.

**Show Needs you** in the rail's **View options** pins one section above the groups with the
threads waiting on you from every workspace: input and approval requests first, then failures
and threads that came back. Those threads leave their groups, which instead end with a
muted **+N in Needs you** line; the amber dot on a collapsed heading still counts them. The setting is off by default
on desktop and on by default in a phone-width browser; a saved choice wins on either. The
section is hidden when nothing is waiting.

**Filter by project** in the rail header limits the groups, the shelves, search and the
older Closed threads Houston loads to the projects you pick. Click a project to choose only
that one, `Shift`-click to add or remove others, and choose it again to clear the filter.
The filter persists across restarts.

### Search

Search filters workspaces and threads by title, branch and pull request number, and
also lists threads whose messages match under **In messages**, with the matching snippet.
It covers **On hold** and **Closed** threads, which expand while a search runs. `Down` and
`Up` move the highlighted result, `Enter` opens it, and `Escape` clears the search. A
message match opens its thread with Find on the matched text. With no match the rail says
**No threads found**.

### Rows

Every thread row is three lines tall:

1. The project's icon and name on the left; the status at the right: **Approval**, **Input**,
   **Request**, **Needs you**, **Failed**, **Limited**, **Goal**, **Waiting**, **Running**,
   **Ready**, **Idle** or **Back** (which has a dismiss control). A running or waiting thread
   says for how long. On hover or focus the status gives way to the row's actions.
2. The title, alone, across the full width.
3. A muted line: the branch (whether the thread uses a worktree or the project's local
   checkout, and a machine icon when it runs on another machine), then an unsent draft with
   **Discard**, the linked pull request (its glyph carries the state colour and the number
   stays neutral), a running terminal that opens that terminal, running subagents, tags (as
   `#tag` text) and a regenerating title. At the right: the checkout's uncommitted line
   counts and the provider mark; a provider without a logo shows its initials on a neutral
   square.

When the items on the third line do not fit, whole items drop from the end behind a **+N**
counter; hovering it lists what is hidden. Closed rows show how long ago the thread closed.

Hovering a row opens a card with the project, the machine when there are several, the
checkout and branch (with a warning when the checkout is on a different branch than the
thread's), the provider and model, the providers the thread was handed off between, running
terminal processes, the last error or usage limit, and linked pull requests.

The first nine rows show their `Ctrl+1` … `Ctrl+9` jump label while the modifier is held.
**Hold** is hidden for a thread that cannot be held.

### Selecting and navigating

`Up`, `Down`, `Home` and `End` move between rows, and `Left` and `Right` collapse or expand
a group, or move to its parent or first child. `Enter` or `Space` opens the focused row; `Shift`- or `Ctrl`-click selects
several. Opening a thread clears the selection and scrolls its row into view.
Double-click a thread's title, or press `F2`, to rename it; `Enter` or leaving the field
saves, `Escape` cancels, and an empty title is refused with a message. If the server
refuses the name, its message is shown.

Right-click a selected row to act on the whole selection: **Close**, **Hold**,
**Regenerate titles**, **Mark unread** or **Delete**, each with the count. **Delete**
asks for confirmation.

### Dragging

- Drag a row onto a chat composer to attach that thread as context.
- Drag a thread row onto another workspace group to move its chat tab to that workspace.
  Drag a workspace heading to reorder workspaces.
- Drag a **Closed** or **On hold** row into the rail to reopen or wake it in its workspace.
- Drop files from a file manager onto a row to add them to that thread's draft; they go
  out with its next message. Files over an environment's limit, or beyond the attachment
  cap, are refused with a message naming the limit.
- Press **Close**, **Reopen thread** or **Wake thread now** on one row and sweep across the
  same button on other rows to apply it to every row swept. `Escape` cancels the sweep.

The foot of the rail carries two shelves:

- **On hold** lists threads with a hold that has not expired. **Wake thread now** returns
  one early. Hold presets are set in **Settings ▸ Threads ▸ Hold options**.
- **Closed** lists closed threads. **Reopen thread** returns one to its workspace. A thread can
  also be dragged onto **Closed**. Houston loads older closed threads from the server as
  you choose **Show more**; the button reads **Loading** while it works and offers **Retry**
  if the read fails.

**Settings ▸ General ▸ Sidebar** sets the thread order inside a group.

## Thread actions

A thread's menu offers:

- **New thread on `<branch>`**, **Find in thread**
- **Close thread** (`Ctrl+Shift+S`) or **Reopen thread**
- **Hold** with a preset, or **Bring thread back**
- **Rename thread** (`F2`), **Regenerate title**, **Mark unread**
- **Copy** path, branch, thread or thread ID
- **Project settings**, **Auto-close behavior**
- **Archive thread**, **Delete**

Closing a thread leaves its history intact and moves it to **Closed**. **Archive** removes
it from the rail into **Settings ▸ Archive**, and is refused while a run is active.
**Delete** removes the thread and its history after confirmation. Confirmation prompts are
configurable in **Settings ▸ General ▸ Confirmations**.

**Settings ▸ Threads ▸ Auto-close** can close a thread when its pull request merges, and
close threads with no activity after a chosen number of days. A thread with a pull request
can be exempted from inactivity closing. New activity brings a closed thread back.

## The composer

The composer sends a message to the thread's provider. It accepts pasted images and files,
`@` file references, slash commands and provider skills. **Rich text composer**, the send
shortcut and skill visibility are in **Settings ▸ Chat**.

A message can be sent while its attachments are still uploading: it appears as sending and the
turn starts when the uploads finish. Answering a question or redirecting a pending approval
waits for the uploads first. A failed upload blocks the send until it is retried or removed.

Typing `@` also lists the models of your enabled providers. Choosing one inserts a model chip
that names that model for the agent, for example to have a subagent use it. The chip is sent as
the text `model:<provider>/<model>`. The `@` list and the chips are in the web and desktop apps.

While a turn is running, the send button reads **Steer** or **Queue** and its chevron opens
the send menu, which offers **Queue message**, **Steer message** and
**Interrupt and send**. Steering is disabled for providers that cannot accept it. Queued
and steered messages show their delivery state, and a dropped message names the reason.
**Follow-up behavior** in **Settings ▸ Chat** sets what a plain send does while a turn
runs.

`Ctrl+S` stashes the current prompt. The stash menu restores or deletes a stashed prompt.

**Plan mode** is optional and off by default (**Settings ▸ Labs**). Enter it with `/plan` or
`Shift+Tab`; a **Plan** chip then shows in the composer and returns to the default mode when
clicked. It asks the agent to propose a plan before acting; the proposed plan card can implement it in a new thread.
**Side chat** opens a read-only aside beside the thread: it can read the conversation and
the project, but cannot edit files, run commands or interrupt the run. **Second opinion** on
an assistant reply asks another provider or model; its card
stays out of the thread until you choose **Send to thread**.

## Terminals and the right panel

Each thread has a terminal drawer for shell commands (`Ctrl+J`). The right panel is a
separate set of surfaces; see [The right panel](right-panel.md). A thread's **details**
control (`Ctrl+Shift+B`) shows its environment, branch, pull requests, scripts, local
servers, context and usage limits. The card starts closed and stays as you leave it.

In a grid, the right panel follows the focused pane: focusing another pane shows that
thread's panel. The pin in the panel header (**Pin to** the thread's title) keeps the panel
on its thread while you work in other panes, and the header then names the thread. Unpin it,
or close the panel, to return to following focus.

A cheap command that needs a real terminal, such as `sudo apt install` or
`git push --force-with-lease`, can start with `!`: `!sudo apt install foo` opens the
thread's drawer and runs there instead of going to the agent. Leading the draft with a space
or `\!` sends it as an ordinary message. Select the command's output and choose **Add to
chat** to attach it to the next message.

## Worktrees

A thread that starts in a new worktree gets its own checkout and branch, so several threads
in one project can work at once. Worktree location, branch naming, submodule handling and
cleanup are in **Settings ▸ Worktrees**. Worktrees Houston created can be removed after
their work is merged or closed, depending on those settings.

## Agent-to-agent work

An agent can delegate work to other threads through the server's orchestration tools. The
parent thread shows its children in the timeline and in the thread relationships card;
**Open parent thread** returns from a child; a subagent's **Open parent** strip stays pinned under
the thread header however far the timeline is scrolled. A child's question or approval request appears
in the parent's pending approvals and needs your answer there. Agents reach threads,
tasks and pulls through the server's MCP toolkits, not through the terminal.

Agents also manage grids through the `houston_grid_*` tools, with the app closed: list, create,
rename, hide, pin and delete a grid, and place a thread in it or take it out. A grid holds at most
six threads and only threads of its own project; a refusal names the limit. `houston_thread_launch`
and `create_threads` take a `grid` to put the new threads in an existing grid or a new one, and
`houston_thread_read` and `houston_thread_list` report each thread's `gridId`. Placing a thread in
a grid moves it out of its other grid.

## Closing

Closing the window hides Houston in the tray when **Settings ▸ General ▸ Background ▸ Keep
in tray** is on; otherwise it quits the app. Either way the server and its runs continue.
**Quit** from the menu, the tray or `Ctrl+Q` follows **Settings ▸ General ▸ Confirmations ▸
Quit shortcut**: direct, or a hold/press-twice confirmation. The tray's **Quit and keep
sessions** quits the client without touching the server's runs.
