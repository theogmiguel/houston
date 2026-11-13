// The window's calls to the server about which workspace a thread belongs to. The server writes
// the membership and any tab moves in one transaction; the window learns the result from the
// layout stream, so none of these touch the layout store.
import { squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import type {
  HoustonLayoutThreadMembership,
  HoustonLayoutThreadMoveResult,
} from "@houston-app/contracts/houston/layoutWorkspaces";
import { HOUSTON_LAYOUT_WORKSPACE_LIMITS } from "@houston-app/contracts/houston/layoutWorkspaces";

import { useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { findLayoutTabByContent } from "./layoutModel";
import { useLayoutStore } from "./layoutStore";
import {
  flushLayoutSync,
  layoutEnvironmentId,
  layoutWorkspacesEnvironment,
} from "./layoutSyncRuntime";
import { randomUUID } from "../lib/utils";

export interface ThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

function environmentOrThrow(
  operation: string,
): NonNullable<ReturnType<typeof layoutEnvironmentId>> {
  const environmentId = layoutEnvironmentId();
  if (environmentId === null) {
    throw new Error(
      `Cannot ${operation}: no primary environment is connected, so no server stores the layout.`,
    );
  }
  return environmentId;
}

function failureMessage(cause: unknown): Error {
  const error = squashAtomCommandFailure({ cause } as never);
  return error instanceof Error ? error : new Error(String(error));
}

/** Records the workspace a new thread starts in; a thread that already has one keeps it. */
export async function assignThreadWorkspace(
  thread: ThreadRef,
  workspaceId: string,
): Promise<HoustonLayoutThreadMembership> {
  const environmentId = environmentOrThrow("assign a thread to a workspace");
  const result = await layoutWorkspacesEnvironment.assignThread.run(appAtomRegistry, {
    environmentId,
    input: { environmentId: thread.environmentId, threadId: thread.threadId, workspaceId },
  });
  if (result._tag === "Success") return result.value;
  throw failureMessage(result.cause);
}

/**
 * Before a draft's first message creates its thread, records the workspace the draft's tab sits
 * in as the thread's own. A draft with no tab, or a server that cannot be reached, leaves the
 * server to choose: it uses the workspace last reported as focused.
 */
export async function claimWorkspaceForNewThread(thread: ThreadRef): Promise<void> {
  const draftId = useComposerDraftStore.getState().getDraftIdByRef({
    environmentId: thread.environmentId as never,
    threadId: thread.threadId as never,
  });
  if (draftId === null || draftId === undefined) return;
  const holder = findLayoutTabByContent(useLayoutStore.getState().layout, {
    kind: "chat",
    target: { kind: "draft", draftId },
  });
  if (holder === null || holder === undefined) return;
  try {
    await assignThreadWorkspace(thread, holder.workspace.id);
  } catch (error) {
    console.warn(
      `The server did not record workspace '${holder.workspace.id}' for new thread '${thread.threadId}'; it will choose one: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Moves a thread, its children and their chat tabs to a workspace. The tabs land in the target's
 * focused pane. Rejects with the server's refusal, which names the workspace.
 */
export async function moveThreadToWorkspaceOnServer(input: {
  readonly thread: ThreadRef;
  readonly workspaceId: string;
  readonly paneId?: string | null;
  readonly index?: number | null;
}): Promise<HoustonLayoutThreadMoveResult> {
  const environmentId = environmentOrThrow("move a thread to a workspace");
  // Edits still waiting in this window go first, so the server moves tabs from the layout it shows.
  await flushLayoutSync();
  const target = useLayoutStore
    .getState()
    .layout.workspaces.find((workspace) => workspace.id === input.workspaceId);
  const paneId = input.paneId ?? target?.focusedPaneId ?? null;
  const result = await layoutWorkspacesEnvironment.moveThread.run(appAtomRegistry, {
    environmentId,
    input: {
      environmentId: input.thread.environmentId,
      threadId: input.thread.threadId,
      workspaceId: input.workspaceId,
      ...(paneId === null ? {} : { paneId }),
      ...(input.index === null || input.index === undefined ? {} : { index: input.index }),
    },
  });
  if (result._tag === "Success") return result.value;
  throw failureMessage(result.cause);
}

/** Creates an empty workspace after the others and returns its id and name. */
export async function createEmptyWorkspaceOnServer(): Promise<{ id: string; name: string }> {
  const environmentId = environmentOrThrow("create a workspace");
  const layout = useLayoutStore.getState().layout;
  const name =
    `Workspace ${layout.workspaces.filter((workspace) => workspace.columns.length > 0).length + 1}`.slice(
      0,
      HOUSTON_LAYOUT_WORKSPACE_LIMITS.nameChars,
    );
  const id = randomUUID();
  const now = new Date().toISOString();
  const result = await layoutWorkspacesEnvironment.put.run(appAtomRegistry, {
    environmentId,
    input: {
      expectedRevision: 0,
      workspace: {
        id,
        name,
        position: 0,
        columns: [],
        pinnedAt: null,
        hidden: false,
        createdAt: now,
        revision: 0,
        updatedAt: now,
      },
    },
  });
  if (result._tag === "Failure") throw failureMessage(result.cause);
  if (result.value.status === "conflict") {
    throw new Error(
      `Cannot create workspace '${id}': the server already holds a workspace with that id.`,
    );
  }
  return { id, name };
}
