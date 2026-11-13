// Deleting a workspace deletes the threads that belong to it, through the same path that deletes
// one thread. The plan is computed from the membership the server reported, so a thread with no
// open tab, or one archived, is deleted too.
import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import type { ThreadMembershipState } from "../../layout/threadMembership";
import { resolveThreadRowState } from "../../threads/sidebarModel";

export interface WorkspaceDeletionPlan {
  /** Children before the parents they follow, so a parent's deletion never meets a missing child. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly running: number;
}

export function planWorkspaceDeletion(input: {
  readonly workspaceId: string;
  readonly memberships: ThreadMembershipState;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly nowIso: string;
}): WorkspaceDeletionPlan {
  const members: EnvironmentThreadShell[] = [];
  for (const thread of input.threads) {
    if (thread.deletedAt !== null) continue;
    const entry = input.memberships.byThread.get(
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    );
    if (entry?.workspaceId === input.workspaceId) members.push(thread);
  }
  const isChild = (thread: EnvironmentThreadShell) =>
    input.memberships.byThread.get(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))
      ?.parentThreadId != null;
  return {
    threads: [...members.filter(isChild), ...members.filter((thread) => !isChild(thread))],
    running: members.filter((thread) => resolveThreadRowState(thread, input.nowIso) === "running")
      .length,
  };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The confirmation text: the workspace, how many threads go and how many are running. */
export function workspaceDeletionMessage(name: string, plan: WorkspaceDeletionPlan): string {
  const running =
    plan.running === 0
      ? ""
      : ` ${plural(plan.running, "thread")} ${plan.running === 1 ? "is" : "are"} running and will be stopped.`;
  return `Delete the workspace “${name}” and its ${plural(plan.threads.length, "thread")}?${running} This permanently clears their conversation history.`;
}

export interface WorkspaceDeletionFailure {
  readonly threadTitle: string;
  readonly message: string;
}

/**
 * Deletes the planned threads in order. Stops at the first failure, which names the thread and the
 * workspace, so the workspace stays with the threads that remain.
 */
export async function deleteWorkspaceThreads(input: {
  readonly workspaceName: string;
  readonly plan: WorkspaceDeletionPlan;
  /** Resolves to an error message, or null when the thread is gone. */
  readonly deleteThread: (
    thread: EnvironmentThreadShell,
    deletedThreadKeys: ReadonlySet<string>,
  ) => Promise<string | null>;
}): Promise<string | null> {
  const deleted = new Set<string>();
  for (const thread of input.plan.threads) {
    const failure = await input.deleteThread(thread, deleted);
    if (failure !== null) {
      return `Could not delete thread “${thread.title}” (${thread.id}) of workspace “${input.workspaceName}”: ${failure}. The workspace was kept with ${input.plan.threads.length - deleted.size} thread(s) left.`;
    }
    deleted.add(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)));
  }
  return null;
}
