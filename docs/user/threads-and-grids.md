# Threads and grids

A **project** is a folder Houston runs work in. A **thread** is a structured conversation
with one agent: a **turn** is one request and its answer, and a **run** is the provider
session that serves a thread. A **grid** is a named layout of threads in one project.

Closing the window detaches the app from the local server. Threads, runs and grids continue
on the server, and the next launch reconnects to them.

## Adding a project

Houston starts with **Add a project to start**. Choose **Add folder** for an existing
folder, or **Clone a repository** to clone a Git URL to a chosen machine and location.
`Start without a project` opens a thread with no project; a thread without a folder can be
turned into a project from its thread actions later.

The add-project palette, opened from **Add project** at the top of the sidebar or from the
command palette, lists **Open folder…**, **Clone repository…** and **New project…**,
followed by the provider repositories Houston can clone from. **New project…** appears when
the server configures a projects folder. Adding a project creates its **Grid 1** and opens
it with the composer ready.

Projects appear as sections in the sidebar. **Project settings** in a thread's action menu
or the command palette renames a project, pins it, archives it and changes its checkouts.
Pinned projects lead the list.

Project actions are commands a project can run from a thread, such as a dev server, tests
or lint. Add them under **Settings ▸ Projects ▸ Actions** or from the thread's action menu.

## Creating a thread

Choose **New thread** from a grid's **+**, from the command palette, or press `Ctrl+N`.
Pick the provider and model in the composer, choose permissions, and send the first
message. A new thread starts in a local checkout or in a new worktree, according to
**Settings ▸ Threads ▸ New threads**; the composer's workspace control changes it for one
thread.

The default model, fallback model and default permissions for new threads are set in
**Settings ▸ Threads**. The model picker is also bound to `Ctrl+Shift+M`.

## Grids

Each project label offers **New grid** (`+`), and each grid row offers **New thread**
(`+`). A grid holds up to six threads. The seventh is refused and names the limit; start
another grid for it.

- **Split** a cell right or down to show another thread beside it. The picker offers only
  threads that are not shown in another grid.
- **Move to…** swaps a cell with another thread in the same grid.
- **Maximize cell** gives one thread the whole grid; **Restore cell** returns the layout.
- **Close cell** removes the thread from the grid; the last closed cell can be put back
  with **Reopen closed tab** (`Ctrl+Shift+T`), and a thread not in any grid appears under
  its project with the note **not in a grid**.
- **Tidy** rearranges the cells: **Balanced grid**, **One row** or **One column**.
  **Equalize** resets every split to an even share. These are also rebindable commands.

The focused cell receives the thread shortcuts; other cells bind none. Click a cell before
using a thread shortcut.

## The sidebar

The sidebar lists **Pull requests**, **Tasks** and **Usage**, then one section per project.
Each section label collapses with **Enter** or **Space** and keeps its state. Under the
label are the project's grids, then its threads that no grid shows, marked **not in a
grid**. Grid rows name only the grid. Threads started without a project sit at the foot of
the list under **No project**. Search filters projects, grids and threads.

A grid's menu offers **New thread**, **Rename grid** (`F2`), **Pin grid** / **Unpin grid**,
**Move grid up** / **Move grid down**, **Hide grid**, **Delete grid**, **Close all ready**,
and a submenu to create or show grids in the same project. Hidden grids are restored from
the **Hidden grids** menu in the sidebar header.

The foot of the rail carries two shelves:

- **On hold** lists threads with a hold that has not expired. **Wake thread now** returns
  one early. Hold presets are set in **Settings ▸ Threads ▸ Hold options**.
- **Closed** lists closed threads. **Reopen thread** returns one to its grid. A thread can
  also be dragged onto **Closed**.

Pinned grids and pinned threads come first. **Settings ▸ General ▸ Sidebar** sets project
grouping and order.

## Thread actions

A thread's menu offers:

- **New thread on `<branch>`**, **Find in thread**, **Pin thread** / **Unpin thread**
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

While a turn is running, the send menu offers **Queue message**, **Steer message** and
**Interrupt and send**. Steering is disabled for providers that cannot accept it. Queued
and steered messages show their delivery state, and a dropped message names the reason.
**Follow-up behavior** in **Settings ▸ Chat** sets what a plain send does while a turn
runs.

`Ctrl+S` stashes the current prompt. The stash menu restores or deletes a stashed prompt.

**Plan mode** asks the agent to propose a plan before acting; the proposed plan card can
implement it in a new thread. **Side chat** opens a read-only aside beside the thread: it
can read the conversation and the project, but cannot edit files, run commands or interrupt
the run. **Second opinion** on an assistant reply asks another provider or model; its card
stays out of the thread until you choose **Send to thread**.

## Terminals and the right panel

Each thread has a terminal drawer for shell commands (`Ctrl+J`). The right panel is a
separate set of surfaces; see [The right panel](right-panel.md). A thread's **details**
control (`Ctrl+Shift+B`) shows its environment, branch, pull requests, scripts, local
servers, context and usage limits.

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
**Open parent thread** returns from a child. A child's question or approval request appears
in the parent's pending approvals and needs your answer there. Agents reach threads,
tasks and pulls through the server's MCP toolkits, not through the terminal.

## Closing

Closing the window hides Houston in the tray when **Settings ▸ General ▸ Background ▸ Keep
in tray** is on; otherwise it quits the app. Either way the server and its runs continue.
**Quit** from the menu, the tray or `Ctrl+Q` follows **Settings ▸ General ▸ Confirmations ▸
Quit shortcut**: direct, or a hold/press-twice confirmation. The tray's **Quit and keep
sessions** quits the client without touching the server's runs.
