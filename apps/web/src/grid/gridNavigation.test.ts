import { EnvironmentId, ProjectId, ThreadId } from "@houston-app/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ensureThreadInGrid } from "./ensureThreadInGrid";
import { resolveGridThreadTarget } from "./gridNavigation";
import { gridContainingThread, useGridStore, workspaceKeyOf } from "./gridStore";
import { preorderThreads } from "./tree";

const parentByThreadId = new Map<string, string>();

vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: ((ref: { threadId: string }) =>
    parentByThreadId.has(ref.threadId)
      ? {
          id: ref.threadId,
          settledOverride: null,
          snoozedUntil: null,
          lineage: {
            parentThreadId: parentByThreadId.get(ref.threadId),
            relationshipToParent: "subagent",
          },
        }
      : null) as never,
}));

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const workspaceKey = workspaceKeyOf(environmentId, projectId);

afterEach(() => {
  parentByThreadId.clear();
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

  it("opens a subagent in its parent's cell instead of adding a cell", () => {
    const parentId = ThreadId.make("thread-parent");
    const childId = ThreadId.make("thread-child");
    parentByThreadId.set(childId, parentId);
    const gridId = useGridStore.getState().createGrid({ environmentId, projectId, workspaceKey });
    useGridStore.getState().addThread(gridId, parentId);

    expect(resolveGridThreadTarget({ environmentId, projectId, threadId: childId })).toEqual({
      gridId,
      threadId: childId,
    });
    const tree = useGridStore.getState().grids.find((grid) => grid.id === gridId)?.tree ?? null;
    expect(tree === null ? [] : preorderThreads(tree).map((leaf) => leaf.threadId)).toEqual([
      childId,
    ]);
  });

  it("leaves a subagent whose parent no grid shows on its own page", () => {
    const childId = ThreadId.make("thread-child");
    parentByThreadId.set(childId, "thread-parent");

    expect(resolveGridThreadTarget({ environmentId, projectId, threadId: childId })).toBeNull();
    expect(useGridStore.getState().grids).toEqual([]);
  });

  it("gives the parent its cell back when a subagent took it, instead of a second cell", () => {
    const parentId = ThreadId.make("thread-parent");
    const childId = ThreadId.make("thread-child");
    parentByThreadId.set(childId, parentId);
    const gridId = useGridStore.getState().createGrid({ environmentId, projectId, workspaceKey });
    useGridStore.getState().addThread(gridId, parentId);
    resolveGridThreadTarget({ environmentId, projectId, threadId: childId });

    expect(resolveGridThreadTarget({ environmentId, projectId, threadId: parentId })).toEqual({
      gridId,
      threadId: parentId,
    });
    const grids = useGridStore.getState().grids;
    expect(grids).toHaveLength(1);
    const tree = grids[0]?.tree ?? null;
    expect(tree === null ? [] : preorderThreads(tree).map((leaf) => leaf.threadId)).toEqual([
      parentId,
    ]);
  });

  it("never auto-places a subagent in a grid of its own", () => {
    const childId = ThreadId.make("thread-child");
    parentByThreadId.set(childId, "thread-parent");
    const gridId = useGridStore.getState().createGrid({ environmentId, projectId, workspaceKey });

    expect(ensureThreadInGrid({ environmentId, projectId, threadId: childId })).toBeNull();
    expect(gridContainingThread(useGridStore.getState().grids, environmentId, childId)).toBeNull();
    expect(useGridStore.getState().grids.map((grid) => grid.id)).toEqual([gridId]);
  });
});
