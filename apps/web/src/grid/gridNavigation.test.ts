import { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveGridThreadTarget } from "./gridNavigation";
import { gridContainingThread, useGridStore, workspaceKeyOf } from "./gridStore";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const workspaceKey = workspaceKeyOf(environmentId, projectId);

afterEach(() => {
  useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
});

describe("resolveGridThreadTarget", () => {
  it("keeps a thread that already has a grid pane", () => {
    const gridId = useGridStore.getState().createGrid({ environmentId, projectId, workspaceKey });
    useGridStore.getState().addThread(gridId, threadId);
    expect(resolveGridThreadTarget({ environmentId, projectId, threadId })).toEqual({
      gridId,
      threadId,
    });
  });

  it("places a thread that lives outside every grid", () => {
    const target = resolveGridThreadTarget({ environmentId, projectId, threadId });
    expect(target).not.toBeNull();
    expect(gridContainingThread(useGridStore.getState().grids, environmentId, threadId)?.id).toBe(
      target?.gridId,
    );
  });

  it("returns a shelf thread to its origin only when the shelf asked", () => {
    const gridId = useGridStore.getState().createGrid({ environmentId, projectId, workspaceKey });
    useGridStore.setState({ threadOrigins: { [threadId]: { gridId, slot: 0 } } });
    expect(
      resolveGridThreadTarget({ environmentId, projectId, threadId, fromShelf: true }),
    ).toEqual({
      gridId,
      threadId,
    });
  });
});
