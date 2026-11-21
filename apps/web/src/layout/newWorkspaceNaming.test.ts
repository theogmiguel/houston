import { scopeThreadRef } from "@houston-app/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@houston-app/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createLayoutState, normalizeLayout, openLayoutTab } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import { listLayoutWorkspaces } from "./layoutWorkspaces";
import {
  finishNewWorkspaceNaming,
  startNewWorkspaceAction,
  undoNewWorkspace,
  useNewWorkspaceNamingStore,
} from "./newWorkspaceNaming";

const chat = (name: string) =>
  ({
    kind: "chat",
    target: {
      kind: "server",
      threadRef: scopeThreadRef(EnvironmentId.make("local"), ThreadId.make(name)),
    },
  }) as const;

afterEach(() => finishNewWorkspaceNaming());

describe("startNewWorkspaceAction", () => {
  it("creates a focused workspace under the next default name and asks the rail to name it", () => {
    useLayoutStore.setState({
      layout: normalizeLayout(openLayoutTab(createLayoutState(), chat("a"))),
    });

    expect(startNewWorkspaceAction()).toBeNull();

    const layout = useLayoutStore.getState().layout;
    const created = listLayoutWorkspaces(layout).at(-1)!;
    expect(created.name).toBe("Workspace 2");
    expect(layout.focusedWorkspaceId).toBe(created.id);
    expect(useNewWorkspaceNamingStore.getState().workspaceId).toBe(created.id);
  });

  it("takes the creation back on undo and stops asking for a name", () => {
    useLayoutStore.setState({
      layout: normalizeLayout(openLayoutTab(createLayoutState(), chat("a"))),
    });
    startNewWorkspaceAction();
    const createdId = useNewWorkspaceNamingStore.getState().workspaceId!;

    undoNewWorkspace(createdId);

    const listed = listLayoutWorkspaces(useLayoutStore.getState().layout);
    expect(listed.map((workspace) => workspace.id)).not.toContain(createdId);
    expect(useNewWorkspaceNamingStore.getState().workspaceId).toBeNull();
  });
});
