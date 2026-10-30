import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { requestConfirmDialog } from "../confirmDialog";
import type { NewThreadHandler } from "../hooks/useHandleNewThread";
import { readThreadShell } from "../state/entities";
import {
  gridById,
  gridContainingDraft,
  MAX_GRID_THREADS,
  useGridStore,
  type GridRecord,
} from "./gridStore";
import { findThread, insertBeside, preorderThreads, threadLeaf, type SplitSide } from "./tree";

export interface GridDraftOptions {
  gridId: string;
  focusedThreadId: string | null;
  side?: SplitSide;
}

export interface OpenedGridDraft {
  gridId: string;
  draftId: DraftId;
  threadId: ThreadId;
}

interface DraftDefaults {
  projectRef: ReturnType<typeof scopeProjectRef>;
  options: {
    branch?: string | null;
    worktreePath?: string | null;
    envMode?: "local" | "worktree";
    startFromOrigin?: boolean;
  };
}

function readDraftDefaults(grid: GridRecord, focusedThreadId: string | null): DraftDefaults {
  const gridProjectRef = scopeProjectRef(
    grid.environmentId as EnvironmentId,
    grid.projectId as ProjectId,
  );
  const node = focusedThreadId === null ? null : findThread(grid.tree, focusedThreadId);
  if (node === null) {
    return { projectRef: gridProjectRef, options: {} };
  }
  if (node.draftId !== undefined) {
    const session = useComposerDraftStore.getState().getDraftSession(node.draftId as DraftId);
    if (session !== null) {
      return {
        projectRef: scopeProjectRef(session.environmentId, session.projectId as ProjectId),
        options: {
          branch: session.branch,
          worktreePath: session.worktreePath,
          envMode: session.envMode,
          startFromOrigin: session.startFromOrigin,
        },
      };
    }
  }
  const shell = readThreadShell(
    scopeThreadRef(grid.environmentId as EnvironmentId, node.threadId as ThreadId),
  );
  if (shell === null) {
    return { projectRef: gridProjectRef, options: {} };
  }
  return {
    projectRef: scopeProjectRef(shell.environmentId, shell.projectId),
    options: {
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      envMode: "local",
    },
  };
}

/**
 * Opens a draft thread in a grid. An empty grid keeps its centred composer, so
 * only a grid that already has panes gains a leaf beside the focused pane.
 */
export async function openGridDraft(
  input: GridDraftOptions,
  handleNewThread: NewThreadHandler,
): Promise<OpenedGridDraft | null> {
  const initial = gridById(useGridStore.getState().grids, input.gridId);
  if (initial === null) return null;

  let targetGrid = initial;
  const threadCount = initial.tree === null ? 0 : preorderThreads(initial.tree).length;
  if (threadCount >= MAX_GRID_THREADS) {
    const confirmed =
      (await requestConfirmDialog(
        `This grid holds ${MAX_GRID_THREADS} threads.\nStart a new grid for this thread?`,
      )) ?? false;
    if (!confirmed) return null;
    const createdId = useGridStore.getState().createGrid({
      environmentId: initial.environmentId,
      projectId: initial.projectId,
      workspaceKey: initial.workspaceKey,
    });
    const created = gridById(useGridStore.getState().grids, createdId);
    if (created === null) return null;
    targetGrid = created;
  }

  const defaults = readDraftDefaults(targetGrid, input.focusedThreadId);
  const opened = await handleNewThread(defaults.projectRef, {
    ...defaults.options,
    navigate: false,
  });
  if (opened === null) return null;

  const store = useGridStore.getState();
  const current = gridById(store.grids, targetGrid.id);
  if (current === null) return null;

  const draftOwner = gridContainingDraft(store.grids, opened.draftId);
  if (draftOwner !== null && draftOwner.id !== current.id) {
    store.focusThread(draftOwner.id, opened.threadId);
    return { gridId: draftOwner.id, ...opened };
  }

  if (current.tree !== null) {
    const leaves = preorderThreads(current.tree);
    const alreadyShown = leaves.some(
      (leaf) => leaf.threadId === opened.threadId || leaf.draftId === opened.draftId,
    );
    if (alreadyShown) {
      store.focusThread(current.id, opened.threadId);
    } else {
      const anchor =
        input.focusedThreadId !== null && findThread(current.tree, input.focusedThreadId) !== null
          ? input.focusedThreadId
          : current.focusedThreadId !== null &&
              findThread(current.tree, current.focusedThreadId) !== null
            ? current.focusedThreadId
            : null;
      if (anchor === null) {
        store.addThread(current.id, opened.threadId, opened.draftId);
      } else {
        store.setTree(
          current.id,
          insertBeside(
            current.tree,
            anchor,
            threadLeaf(opened.threadId, undefined, opened.draftId),
            input.side ?? "right",
          ),
        );
        store.focusThread(current.id, opened.threadId);
      }
    }
  }

  return { gridId: current.id, ...opened };
}
