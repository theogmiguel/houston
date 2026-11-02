import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DraftId,
  subscribeDraftThreadPromotion,
  useComposerDraftStore,
} from "../composerDraftStore";
import { ensureThreadInGrid } from "./ensureThreadInGrid";
import { gridContainingThread, useGridStore, workspaceKeyOf } from "./gridStore";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const workspaceKey = workspaceKeyOf(environmentId, projectId);

function freshStore(): void {
  useGridStore.setState({ grids: [], closedCells: {}, threadOrigins: {} });
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    backgroundSubmissionThreadKeys: {},
    promotedDraftRedirects: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

describe("ensureThreadInGrid", () => {
  beforeEach(freshStore);

  it("creates the workspace's first grid for a thread started outside one", () => {
    const gridId = ensureThreadInGrid({ environmentId, projectId, threadId });
    expect(gridId).not.toBeNull();
    expect(
      gridContainingThread(useGridStore.getState().grids, environmentId, threadId),
    ).not.toBeNull();
    expect(useGridStore.getState().grids).toHaveLength(1);
  });

  it("adds the thread to an existing grid instead of creating another", () => {
    const gridId = useGridStore.getState().createGrid({
      environmentId,
      projectId,
      workspaceKey,
    });
    expect(ensureThreadInGrid({ environmentId, projectId, threadId })).toBe(gridId);
    expect(useGridStore.getState().grids).toHaveLength(1);
    expect(gridContainingThread(useGridStore.getState().grids, environmentId, threadId)?.id).toBe(
      gridId,
    );
  });

  it("leaves a thread that already has a pane untouched", () => {
    const gridId = ensureThreadInGrid({ environmentId, projectId, threadId });
    expect(ensureThreadInGrid({ environmentId, projectId, threadId })).toBeNull();
    expect(useGridStore.getState().grids).toHaveLength(1);
    expect(gridId).not.toBeNull();
  });

  it("keeps a thread that left a grid for the shelf out of a new one", () => {
    const gridId = useGridStore.getState().createGrid({
      environmentId,
      projectId,
      workspaceKey,
    });
    useGridStore.setState({
      threadOrigins: { [threadId]: { gridId, slot: 0 } },
    });
    expect(ensureThreadInGrid({ environmentId, projectId, threadId })).toBeNull();
    expect(useGridStore.getState().grids).toHaveLength(1);
    expect(gridContainingThread(useGridStore.getState().grids, environmentId, threadId)).toBeNull();
  });

  it("places an empty grid's draft thread in that grid, not in a newer one", () => {
    const emptyGridId = useGridStore.getState().createGrid({
      environmentId,
      projectId,
      workspaceKey,
      now: "2026-01-01T00:00:00.000Z",
    });
    useGridStore.getState().setGridPendingDraft(emptyGridId, {
      draftId: "draft-1",
      threadId,
    });
    useGridStore.getState().createGrid({
      environmentId,
      projectId,
      workspaceKey,
      now: "2026-02-01T00:00:00.000Z",
    });

    expect(ensureThreadInGrid({ environmentId, projectId, threadId, draftId: "draft-1" })).toBe(
      emptyGridId,
    );
    expect(gridContainingThread(useGridStore.getState().grids, environmentId, threadId)?.id).toBe(
      emptyGridId,
    );
    expect(useGridStore.getState().grids).toHaveLength(2);
  });
});

describe("draft promotion placement", () => {
  let registry: AtomRegistry.AtomRegistry | null = null;
  let unsubscribe: (() => void) | null = null;

  beforeEach(freshStore);

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    registry?.dispose();
    registry = null;
  });

  it("gives a promoted root-composer draft a grid", () => {
    const tasks: Array<() => void> = [];
    registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    const flush = () => {
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
    };
    const threadRefsAtom = Atom.make<ReadonlyArray<ReturnType<typeof scopeThreadRef>>>([]);
    const emptyShellAtom = Atom.make<{
      latestRun: null;
      latestUserMessageAt: null;
    } | null>(null);
    unsubscribe = subscribeDraftThreadPromotion({
      registry,
      threadRefsAtom,
      threadShellAtom: () => emptyShellAtom,
      onThreadArrived: ensureThreadInGrid,
    });
    flush();

    const draftId = DraftId.make("draft-promotion");
    useComposerDraftStore
      .getState()
      .setProjectDraftThreadId(scopeProjectRef(environmentId, projectId), draftId, { threadId });
    flush();
    registry.set(threadRefsAtom, [scopeThreadRef(environmentId, threadId)]);
    flush();

    expect(
      gridContainingThread(useGridStore.getState().grids, environmentId, threadId),
    ).not.toBeNull();
  });
});
