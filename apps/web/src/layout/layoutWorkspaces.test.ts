import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  normalizeLayout,
  findLayoutTabByContent,
  openLayoutTab,
  selectFocusedChatTab,
  selectFocusedWorkspace,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import {
  createLayoutWorkspaceNamed,
  deleteLayoutWorkspace,
  listLayoutWorkspaces,
  moveLayoutChatToWorkspace,
  moveLayoutWorkspaceById,
  renameLayoutWorkspaceChecked,
  reorderLayoutWorkspace,
  setLayoutWorkspaceHidden,
  setLayoutWorkspacePinned,
  WORKSPACE_NAME_MAX_CHARS,
} from "./layoutWorkspaces";

const environmentId = EnvironmentId.make("local");
const chat = (name: string): LayoutTabContent => ({
  kind: "chat",
  target: { kind: "server", threadRef: scopeThreadRef(environmentId, ThreadId.make(name)) },
});
const terminal = (name: string): LayoutTabContent => ({
  kind: "surface",
  threadRef: scopeThreadRef(environmentId, ThreadId.make(name)),
  surfaceId: "thread-terminal",
});

/** Two named workspaces, each holding one chat, plus the trailing empty one. */
function twoWorkspaces(): LayoutState {
  let state = openLayoutTab(createLayoutState(), chat("a"));
  state = createLayoutWorkspaceNamed(state, "Second").state;
  state = openLayoutTab(state, chat("b"));
  return normalizeLayout(state);
}

const names = (state: LayoutState) => listLayoutWorkspaces(state).map((w) => w.name);

describe("createLayoutWorkspaceNamed", () => {
  it("focuses the trailing empty workspace and names it", () => {
    const state = openLayoutTab(createLayoutState(), chat("a"));
    const { state: next, refusal } = createLayoutWorkspaceNamed(state, "Research");
    expect(refusal).toBeNull();
    expect(selectFocusedWorkspace(next).name).toBe("Research");
    expect(selectFocusedWorkspace(next).columns).toHaveLength(0);
  });

  it("refuses a name over the limit, naming the limit and the length", () => {
    const { state, refusal } = createLayoutWorkspaceNamed(
      createLayoutState(),
      "x".repeat(WORKSPACE_NAME_MAX_CHARS + 1),
    );
    expect(refusal).toContain(String(WORKSPACE_NAME_MAX_CHARS));
    expect(refusal).toContain(String(WORKSPACE_NAME_MAX_CHARS + 1));
    expect(selectFocusedWorkspace(state).name).toBeNull();
  });
});

describe("renameLayoutWorkspaceChecked", () => {
  it("renames and trims", () => {
    const state = twoWorkspaces();
    const id = state.workspaces[0]!.id;
    const { state: next, refusal } = renameLayoutWorkspaceChecked(state, id, "  Inbox  ");
    expect(refusal).toBeNull();
    expect(names(next)[0]).toBe("Inbox");
  });

  it("clears the name on an empty string so the title stands in", () => {
    const state = twoWorkspaces();
    const id = state.workspaces[1]!.id;
    expect(names(renameLayoutWorkspaceChecked(state, id, "   ").state)[1]).toBeNull();
  });

  it("refuses a long name naming the limit, the length and the workspace", () => {
    const state = twoWorkspaces();
    const id = state.workspaces[0]!.id;
    const { state: next, refusal } = renameLayoutWorkspaceChecked(
      state,
      id,
      "y".repeat(WORKSPACE_NAME_MAX_CHARS + 5),
    );
    expect(next).toBe(state);
    expect(refusal).toContain(String(WORKSPACE_NAME_MAX_CHARS));
    expect(refusal).toContain(String(WORKSPACE_NAME_MAX_CHARS + 5));
  });
});

describe("moveLayoutWorkspaceById", () => {
  it("swaps a workspace with its neighbor without moving focus", () => {
    const state = twoWorkspaces();
    const [first, second] = state.workspaces;
    const focused = state.focusedWorkspaceId;
    const next = moveLayoutWorkspaceById(state, first!.id, 1);
    expect(next.workspaces[0]!.id).toBe(second!.id);
    expect(next.workspaces[1]!.id).toBe(first!.id);
    expect(next.focusedWorkspaceId).toBe(focused);
  });

  it("does nothing at the ends or past the trailing empty workspace", () => {
    const state = twoWorkspaces();
    expect(moveLayoutWorkspaceById(state, state.workspaces[0]!.id, -1)).toBe(state);
    expect(moveLayoutWorkspaceById(state, state.workspaces[1]!.id, 1)).toBe(state);
  });
});

describe("deleteLayoutWorkspace", () => {
  it("moves the chats of the deleted workspace to the first remaining one", () => {
    const state = twoWorkspaces();
    const second = state.workspaces[1]!;
    const { state: next, refusal } = deleteLayoutWorkspace(state, second.id);
    expect(refusal).toBeNull();
    expect(listLayoutWorkspaces(next)).toHaveLength(1);
    const tabs = next.workspaces[0]!.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs));
    expect(tabs.map((tab) => tab.content.kind)).toEqual(["chat", "chat"]);
  });

  it("drops surface tabs with the workspace", () => {
    let state = twoWorkspaces();
    state = openLayoutTab(state, terminal("b"));
    const { state: next } = deleteLayoutWorkspace(state, state.focusedWorkspaceId);
    const tabs = next.workspaces.flatMap((w) =>
      w.columns.flatMap((c) => c.panes.flatMap((p) => p.tabs)),
    );
    expect(tabs.some((tab) => tab.content.kind === "surface")).toBe(false);
  });

  it("refuses the last workspace, naming it and the count", () => {
    const state = openLayoutTab(createLayoutState(), chat("a"));
    const { state: next, refusal } = deleteLayoutWorkspace(state, state.workspaces[0]!.id);
    expect(next).toBe(state);
    expect(refusal).toMatch(/last workspace/);
    expect(refusal).toMatch(/1 of 1/);
  });

  it("refuses an unknown workspace id, naming it", () => {
    const state = twoWorkspaces();
    const { state: next, refusal } = deleteLayoutWorkspace(state, "workspace:nope");
    expect(next).toBe(state);
    expect(refusal).toContain("workspace:nope");
  });

  it("keeps focus where it was when another workspace is deleted", () => {
    const state = twoWorkspaces();
    const first = state.workspaces[0]!;
    const focusedFirst = { ...state, focusedWorkspaceId: first.id };
    const { state: next } = deleteLayoutWorkspace(focusedFirst, state.workspaces[1]!.id);
    expect(next.focusedWorkspaceId).toBe(first.id);
  });
});

describe("setLayoutWorkspacePinned and setLayoutWorkspaceHidden", () => {
  it("pin stamps the time, unpin clears it, and repeating either changes nothing", () => {
    const state = twoWorkspaces();
    const id = state.workspaces[0]!.id;
    const pinned = setLayoutWorkspacePinned(state, id, true, "2026-01-01T00:00:00.000Z");
    expect(pinned.workspaces[0]!.pinnedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(setLayoutWorkspacePinned(pinned, id, true, "2027-01-01T00:00:00.000Z")).toBe(pinned);
    expect(setLayoutWorkspacePinned(pinned, id, false, "x").workspaces[0]!.pinnedAt).toBeNull();
    expect(setLayoutWorkspacePinned(state, id, false, "x")).toBe(state);
  });

  it("hide and show toggle the flag and leave the tabs alone", () => {
    const state = twoWorkspaces();
    const id = state.workspaces[1]!.id;
    const hidden = setLayoutWorkspaceHidden(state, id, true);
    expect(hidden.workspaces[1]!.hidden).toBe(true);
    expect(hidden.workspaces[1]!.columns).toBe(state.workspaces[1]!.columns);
    expect(setLayoutWorkspaceHidden(hidden, id, true)).toBe(hidden);
    expect(setLayoutWorkspaceHidden(hidden, id, false).workspaces[1]!.hidden).toBe(false);
  });
});

describe("reorderLayoutWorkspace", () => {
  function three(): LayoutState {
    let state = twoWorkspaces();
    state = createLayoutWorkspaceNamed(state, "Third").state;
    return normalizeLayout(openLayoutTab(state, chat("c")));
  }
  const order = (state: LayoutState) => listLayoutWorkspaces(state).map((w) => w.name);

  it("puts a workspace before or after another", () => {
    const state = three();
    const [first, , third] = listLayoutWorkspaces(state);
    expect(order(reorderLayoutWorkspace(state, third!.id, first!.id, "before"))).toEqual([
      "Third",
      null,
      "Second",
    ]);
    expect(order(reorderLayoutWorkspace(state, first!.id, third!.id, "after"))).toEqual([
      "Second",
      "Third",
      null,
    ]);
  });

  it("changes nothing for a drop on itself, a drop in place, or an unknown id", () => {
    const state = three();
    const [first, second] = listLayoutWorkspaces(state);
    expect(reorderLayoutWorkspace(state, first!.id, first!.id, "after")).toBe(state);
    expect(reorderLayoutWorkspace(state, first!.id, second!.id, "before")).toBe(state);
    expect(reorderLayoutWorkspace(state, "nope", first!.id, "after")).toBe(state);
  });

  it("keeps the empty workspace at the bottom", () => {
    const state = twoWorkspaces();
    const empty = state.workspaces.at(-1)!;
    expect(empty.columns).toHaveLength(0);
    const moved = reorderLayoutWorkspace(state, state.workspaces[0]!.id, empty.id, "after");
    expect(moved.workspaces.at(-1)).toBe(empty);
    expect(moved.workspaces[1]!.id).toBe(state.workspaces[0]!.id);
  });
});

describe("moveLayoutChatToWorkspace", () => {
  it("moves a chat's tab to the end of another workspace and keeps the user where they were", () => {
    const state = twoWorkspaces();
    const [first, second] = listLayoutWorkspaces(state);
    const focusedBefore = state.focusedWorkspaceId;
    expect(focusedBefore).toBe(second!.id);
    const { state: next, refusal } = moveLayoutChatToWorkspace(
      state,
      chat("a") as Extract<LayoutTabContent, { kind: "chat" }>,
      second!.id,
    );
    expect(refusal).toBeNull();
    expect(findLayoutTabByContent(next, chat("a"))!.workspace.id).toBe(second!.id);
    expect(next.focusedWorkspaceId).toBe(second!.id);
    expect(next.workspaces.find((w) => w.id === first!.id)?.columns ?? []).toHaveLength(0);
  });

  it("focus stays on another workspace when a chat is moved into a third", () => {
    let state = twoWorkspaces();
    state = createLayoutWorkspaceNamed(state, "Third").state;
    state = openLayoutTab(state, chat("c"));
    state = normalizeLayout(state);
    const [first, second, third] = listLayoutWorkspaces(state);
    const stateOnSecond = { ...state, focusedWorkspaceId: second!.id };
    const { state: next } = moveLayoutChatToWorkspace(
      stateOnSecond,
      chat("c") as Extract<LayoutTabContent, { kind: "chat" }>,
      first!.id,
    );
    expect(findLayoutTabByContent(next, chat("c"))!.workspace.id).toBe(first!.id);
    expect(next.focusedWorkspaceId).toBe(second!.id);
    expect(third).toBeDefined();
  });

  it("opens a tab for a chat that is shown nowhere", () => {
    const state = twoWorkspaces();
    const [first] = listLayoutWorkspaces(state);
    const { state: next } = moveLayoutChatToWorkspace(
      state,
      chat("loose") as Extract<LayoutTabContent, { kind: "chat" }>,
      first!.id,
    );
    expect(findLayoutTabByContent(next, chat("loose"))!.workspace.id).toBe(first!.id);
    expect(selectFocusedChatTab(next)).not.toBeNull();
  });

  it("refuses an unknown workspace, naming it and the known ones", () => {
    const state = twoWorkspaces();
    const { state: next, refusal } = moveLayoutChatToWorkspace(
      state,
      chat("a") as Extract<LayoutTabContent, { kind: "chat" }>,
      "nope",
    );
    expect(next).toBe(state);
    expect(refusal).toContain("'nope'");
    expect(refusal).toContain(state.workspaces[0]!.id);
  });
});
