import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createLayoutState,
  normalizeLayout,
  openLayoutTab,
  selectFocusedWorkspace,
  type LayoutState,
  type LayoutTabContent,
} from "./layoutModel";
import {
  createLayoutWorkspaceNamed,
  deleteLayoutWorkspace,
  listLayoutWorkspaces,
  moveLayoutWorkspaceById,
  renameLayoutWorkspaceChecked,
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
