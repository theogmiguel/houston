# Layout port: decisions

Supersedes the slice plan in `port-map.md` sections 7 and 8. `port-map.md` remains the reference for
file classes, consumers of the grid contract (section 6.2) and upstream layout files (section 6.3).

## Scope

Port upstream's complete layout system (workspaces, columns, panes, tabs) and replace Houston's grid
with it. Slices 1 to 5 of the upstream stack and the non-layout features carried by PR 28845 (Classic
theme, context-window meter, subagent rows, wake-ups rail, composer and settings changes) are out of
scope.

- Upstream source: `pingdotgg/t3code` PR 28845 at `1f9675e2a13223172195bcb02256fd5251c5c81c`. A
  read-only clone is at `/home/theo/ProjetosPessoais/.t3-upstream-redesign/t3code`; fetch
  `refs/pull/28845/head` there and stop if that SHA is not reachable. Never run anything from it.
- **Behaviour follows upstream; look follows Houston.** Every layout behaviour, state and shortcut in
  upstream's `apps/web/src/layout/` is ported: drag to reorder, move and split, closed-tab restore,
  the overview, the sideways-scrolling strip, per-project layout templates, the tour and hints,
  keyboard shortcuts, tab overflow, narrow windows, and the macOS-only parts (three-finger swipe,
  window chrome). Where a mock in `mocks/` shows a behaviour upstream implements differently,
  upstream's behaviour wins and the difference is logged under Deviations.
- Styling uses Houston's tokens, recipes, primitives and motion roles (`apps/web/src/index.css`,
  `apps/web/src/components/ui/`, `apps/web/src/motion/`). Upstream's token layer, surface styles and
  type scale are not imported. Houston's `motion/` files keep their names.
- Multiple workspaces and the scrolling strip are on by default; upstream's Labs gate is not ported.

## Where Houston differs from upstream

1. **The server owns the layout.** Upstream persists it in the client's `localStorage`. Houston stores
   it on the server so MCP tools can read and change it. Focus, camera width and ghost tabs stay with
   the client, as focus and open panels do today.
2. **The sidebar is grouped by workspace** (mock `mocks/sidebar-and-top-tabs.html`, variant A). There
   is no project tree. Creating a thread asks for its project through upstream's launcher.
   A thread row has three lines, as upstream's does, and this overrides the two-line row drawn in the
   mocks: (1) the project's icon and name, with the thread's status at the right (Houston's existing
   status vocabulary and marks, including the elapsed time of a running thread); (2) the title alone,
   on the full width; (3) the branch, then the pull request, diff counts and provider at the right.
3. **A workspace has no project.** Threads of any project and environment share a workspace. The
   `cross_project` refusal and the six-thread cap are removed.

## Rules kept from upstream

- One tab per content across the whole layout: opening content that is already in a tab focuses that
  tab (`findLayoutTabByContent`). A thread's chat is therefore in at most one workspace. The server
  enforces this.
- A surface tab is linked to its thread and outlives the thread's chat tab.

## Record

One row per workspace in a new table on the Houston migration track (next free id; ids never change
once merged).

- Names: UI and tools say **workspace**. Code that would collide with the server's existing
  `workspace/` (a project's folder) uses `LayoutWorkspace`: contract
  `packages/contracts/src/houston/layoutWorkspaces.ts`, RPC `houston.layoutWorkspaces.*`, service
  `HoustonLayoutWorkspaceService`, table `houston_layout_workspaces`. Add the term to the glossary.
- Shape: `id`, `name`, `position`, `columns[] { id, width, panes[] { id, size, activeTabId,
  tabs[] { id, content } } }`, `pinnedAt`, `hidden`, `createdAt`, `revision`, `updatedAt`.
  Tab content mirrors upstream's `LayoutTabContent` kinds that are durable: chat, surface, launcher,
  page.
- Every bound (name length, workspaces, columns, panes, tabs, id length) is in one limits object;
  a refusal names the limit, the actual value and the operation.
- At least one workspace always exists. A thread that is placed nowhere, or whose workspace is
  deleted, goes to the first workspace.
- Migration: every `houston_grids` row becomes a workspace with the same id, name, pin and hidden
  state. A root row becomes columns; a column split inside it becomes that column's panes; deeper
  nesting flattens to panes in preorder with equal sizes, which is lossy and recorded per workspace
  in the migration's log line. `houston_grids` is copied, not dropped, until the final commit.

## Tools

`houston_workspace_*` replace `houston_grid_*`. The old names stay as aliases for one release and say
so in their description. Launch placement (`placeLaunched`, the orchestrator and project toolkits)
targets a workspace.

## Delivery

One branch (`v2-redesign`), one PR into `v2`, one commit per agent, in this order. Each commit keeps
the workspace typecheck and the suites it touches green.

1. Contract, table, migration and service for layout workspaces.
2. Workspace tools, aliases and launch placement.
3. Renderer layout model, panes and tabs, with the top pane's tabs in the window bar.
4. Sidebar grouped by workspace.
5. Removal of the grid contract, service, table and renderer code.

Agents append to `implementation-notes.md` under Deviations, stage explicit paths, do not push, and
never use `pkill`, `pgrep` or any process match by name.
