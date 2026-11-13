/**
 * Workspace operations the switcher needs on top of the layout model: naming with the server's
 * bound, reordering any workspace, and deleting one. A refusal comes back as text that names the
 * offending value and the rule, so the surface can show it as is.
 */
import { HOUSTON_LAYOUT_WORKSPACE_LIMITS } from "@houston-app/contracts/houston/layoutWorkspaces";

import {
  findLayoutPane,
  findLayoutTabByContent,
  focusLayoutPane,
  focusLayoutWorkspace,
  moveLayoutTab,
  normalizeLayout,
  placeLayoutContent,
  renameLayoutWorkspace,
  selectFocusedPane,
  type LayoutState,
  type LayoutTabContent,
  type LayoutTab,
  type LayoutWorkspace,
} from "./layoutModel";

/** The longest name the server stores; a longer one is refused here before it is saved. */
export const WORKSPACE_NAME_MAX_CHARS = HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars;

export interface WorkspaceResult {
  readonly state: LayoutState;
  /** Why nothing changed, or null when the operation applied. */
  readonly refusal: string | null;
}

/**
 * Workspaces as a person counts them: every one with something in it, plus the empty one only
 * while it has focus. The unfocused trailing empty workspace is plumbing, not a workspace.
 */
export function listLayoutWorkspaces(state: LayoutState): LayoutWorkspace[] {
  return state.workspaces.filter(
    (workspace) => workspace.columns.length > 0 || workspace.id === state.focusedWorkspaceId,
  );
}

/** What a workspace is called where it is listed: its name, else `resolveTitle`'s, else its place. */
export function workspaceDisplayName(
  workspace: LayoutWorkspace,
  position: number,
  resolveTitle?: (workspace: LayoutWorkspace) => string | null,
): string {
  const named = workspace.name?.trim();
  if (named) return named;
  const title = resolveTitle?.(workspace)?.trim();
  if (title) return title;
  return workspace.columns.length === 0 ? "Empty workspace" : `Workspace ${position + 1}`;
}

function describe(workspace: LayoutWorkspace, state: LayoutState): string {
  return workspace.name ?? `Workspace ${state.workspaces.indexOf(workspace) + 1}`;
}

function nameRefusal(name: string): string | null {
  const length = name.trim().length;
  return length > WORKSPACE_NAME_MAX_CHARS
    ? `A workspace name is at most ${WORKSPACE_NAME_MAX_CHARS} characters; got ${length}.`
    : null;
}

/** Go to the empty workspace at the bottom of the stack and name it. It is stored once it holds a tab. */
export function createLayoutWorkspaceNamed(state: LayoutState, name: string): WorkspaceResult {
  const refusal = nameRefusal(name);
  if (refusal) return { state, refusal };
  const trailing = state.workspaces.at(-1)!;
  const focused = focusLayoutWorkspace(state, trailing.id);
  return { state: renameLayoutWorkspace(focused, trailing.id, name), refusal: null };
}

export function renameLayoutWorkspaceChecked(
  state: LayoutState,
  workspaceId: string,
  name: string,
): WorkspaceResult {
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return {
      state,
      refusal: `Workspace '${workspaceId}' does not exist, so it cannot be renamed.`,
    };
  }
  const refusal = nameRefusal(name);
  if (refusal) return { state, refusal };
  return { state: renameLayoutWorkspace(state, workspaceId, name), refusal: null };
}

/**
 * Swap a workspace with the one below (1) or above (-1) without moving focus. The empty workspace
 * at the bottom stays there.
 */
export function moveLayoutWorkspaceById(
  state: LayoutState,
  workspaceId: string,
  delta: 1 | -1,
): LayoutState {
  const index = state.workspaces.findIndex((workspace) => workspace.id === workspaceId);
  const workspace = state.workspaces[index];
  const other = state.workspaces[index + delta];
  if (!workspace || !other || workspace.columns.length === 0 || other.columns.length === 0) {
    return state;
  }
  const workspaces = [...state.workspaces];
  workspaces[index] = other;
  workspaces[index + delta] = workspace;
  return { ...state, workspaces };
}

function chatTabsOf(workspace: LayoutWorkspace): LayoutTab[] {
  return workspace.columns
    .flatMap((column) => column.panes)
    .flatMap((pane) => pane.tabs)
    .filter((tab) => tab.content.kind === "chat");
}

/**
 * Remove a workspace. Its chats move to the end of the last pane of the first remaining
 * workspace, as the server does when it deletes one; its surfaces, launchers and pages go with it.
 * The last workspace is refused: one must always remain.
 */
export function deleteLayoutWorkspace(state: LayoutState, workspaceId: string): WorkspaceResult {
  const target = state.workspaces.find((workspace) => workspace.id === workspaceId);
  if (!target) {
    const known = state.workspaces.map((workspace) => workspace.id).join(", ");
    return {
      state,
      refusal: `Workspace '${workspaceId}' does not exist, so it cannot be deleted. Known workspaces: ${known}.`,
    };
  }
  const counted = listLayoutWorkspaces(state);
  if (!counted.includes(target)) {
    return { state, refusal: "An empty workspace that is not open has nothing to delete." };
  }
  if (counted.length <= 1) {
    return {
      state,
      refusal: `'${describe(target, state)}' is the last workspace (${counted.length} of ${counted.length}); at least 1 must remain.`,
    };
  }
  const home = state.workspaces.find((workspace) => workspace !== target)!;
  let moved = state;
  for (const tab of chatTabsOf(target)) {
    const homeNow = moved.workspaces.find((workspace) => workspace.id === home.id)!;
    const lastColumn = homeNow.columns.at(-1);
    const lastPane = lastColumn?.panes.at(-1);
    moved = moveLayoutTab(
      moved,
      tab.id,
      lastPane
        ? { kind: "pane", paneId: lastPane.id }
        : { kind: "column", workspaceId: home.id, index: 0 },
    );
  }
  const remaining = moved.workspaces.filter((workspace) => workspace.id !== target.id);
  const focusedWorkspaceId =
    state.focusedWorkspaceId === target.id ? home.id : state.focusedWorkspaceId;
  const next = normalizeLayout({ workspaces: remaining, focusedWorkspaceId });
  return { state: next, refusal: null };
}

function mapWorkspace(
  state: LayoutState,
  workspaceId: string,
  change: (workspace: LayoutWorkspace) => LayoutWorkspace,
): LayoutState {
  let changed = false;
  const workspaces = state.workspaces.map((workspace) => {
    if (workspace.id !== workspaceId) return workspace;
    const next = change(workspace);
    changed = next !== workspace;
    return next;
  });
  return changed ? { ...state, workspaces } : state;
}

/** Pin a workspace (`now` is when) or unpin it. The sidebar lists pinned workspaces first. */
export function setLayoutWorkspacePinned(
  state: LayoutState,
  workspaceId: string,
  pinned: boolean,
  now: string,
): LayoutState {
  return mapWorkspace(state, workspaceId, (workspace) => {
    const isPinned = (workspace.pinnedAt ?? null) !== null;
    if (isPinned === pinned) return workspace;
    return { ...workspace, pinnedAt: pinned ? now : null };
  });
}

/** Hide a workspace from the sidebar's list, or show it again. The strip still holds it. */
export function setLayoutWorkspaceHidden(
  state: LayoutState,
  workspaceId: string,
  hidden: boolean,
): LayoutState {
  return mapWorkspace(state, workspaceId, (workspace) =>
    (workspace.hidden ?? false) === hidden ? workspace : { ...workspace, hidden },
  );
}

/**
 * Put a workspace just before or after another (a drag in the sidebar). The empty workspace at
 * the bottom of the stack stays last, so a drop beside it lands above it.
 */
export function reorderLayoutWorkspace(
  state: LayoutState,
  workspaceId: string,
  targetId: string,
  side: "before" | "after",
): LayoutState {
  if (workspaceId === targetId) return state;
  const moving = state.workspaces.find((workspace) => workspace.id === workspaceId);
  const target = state.workspaces.find((workspace) => workspace.id === targetId);
  if (!moving || !target || moving.columns.length === 0) return state;
  const rest = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
  let index = rest.indexOf(target) + (side === "after" ? 1 : 0);
  if (rest.at(-1)?.columns.length === 0) index = Math.min(index, rest.length - 1);
  const workspaces = [...rest.slice(0, index), moving, ...rest.slice(index)];
  return workspaces.every((workspace, i) => workspace === state.workspaces[i])
    ? state
    : { ...state, workspaces };
}

/**
 * Put a thread's chat at the end of a workspace: move the tab that shows it, or open one there.
 * The user stays where they were unless the moved tab was the one they were on.
 */
export function moveLayoutChatToWorkspace(
  state: LayoutState,
  content: Extract<LayoutTabContent, { kind: "chat" }>,
  workspaceId: string,
): WorkspaceResult {
  const target = state.workspaces.find((workspace) => workspace.id === workspaceId);
  if (!target) {
    const known = state.workspaces.map((workspace) => workspace.id).join(", ");
    return {
      state,
      refusal: `Workspace '${workspaceId}' does not exist, so the thread cannot move there. Known workspaces: ${known}.`,
    };
  }
  const existing = findLayoutTabByContent(state, content);
  if (existing?.workspace.id === workspaceId) return { state, refusal: null };
  const focusedPaneId = selectFocusedPane(state)?.id ?? null;
  const placed = placeLayoutContent(state, content, {
    kind: "column",
    workspaceId,
    index: target.columns.length,
  });
  const stays =
    focusedPaneId !== null &&
    existing?.pane.id !== focusedPaneId &&
    findLayoutPane(placed, focusedPaneId) !== null;
  return { state: stays ? focusLayoutPane(placed, focusedPaneId) : placed, refusal: null };
}
