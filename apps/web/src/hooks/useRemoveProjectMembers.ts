import { AuthOrchestrationOperateScope } from "@houston-app/contracts";
import { scopeProjectRef, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { planProjectRemoval } from "@houston-app/client-runtime/state/projects";
import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@houston-app/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useComposerDraftStore } from "../composerDraftStore";
import { releaseProjectDraftUploads } from "../lib/composerDraftUploads";
import { readLocalApi } from "../localApi";
import type { SidebarProjectGroupMember, SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { useThreadShells, waitForProjectRemoval } from "../state/entities";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { projectEnvironment } from "../state/projects";
import { readEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export function reportProjectCommandFailure(
  title: string,
  result: AtomCommandResult<void, unknown>,
): void {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Reports and returns a failure when this connection may not change one of the members. */
export function checkProjectAccess(
  members: ReadonlyArray<SidebarProjectGroupMember>,
  failureTitle: string,
): AtomCommandResult<void, Error> | null {
  const denied = members.find(
    (member) => !readEnvironmentScope(member.environmentId, AuthOrchestrationOperateScope),
  );
  if (!denied) return null;
  const result = AsyncResult.failure<void, Error>(
    Cause.fail(
      new Error(
        `This connection cannot change projects in ${denied.environmentLabel ?? "this environment"}.`,
      ),
    ),
  );
  reportProjectCommandFailure(failureTitle, result);
  return result;
}

export interface RemoveProjectMembersInput {
  readonly group: SidebarProjectSnapshot;
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
  /** True when the group has checkouts outside `members` that stay. */
  readonly hasOtherMembers: boolean;
}

export interface RemoveProjectMembersOutcome {
  readonly removed: boolean;
  readonly isWholeGroup: boolean;
}

/** Removes project entries and their threads after a confirmation; files on disk stay. */
export function useRemoveProjectMembers(): (
  input: RemoveProjectMembersInput,
) => Promise<RemoveProjectMembersOutcome> {
  const threads = useThreadShells();
  const deleteProject = useOrchestrationCommand(projectEnvironment.delete, {
    reportFailure: false,
  });

  return async ({ group, members, hasOtherMembers }) => {
    const notRemoved = { removed: false, isWholeGroup: false };
    if (checkProjectAccess(members, "Failed to remove project")) return notRemoved;
    const api = readLocalApi();
    if (!api) return notRemoved;

    const { projectThreads, isWholeGroup, confirmationMessage } = planProjectRemoval({
      members,
      groupMemberCount: group.memberProjects.length,
      hasOtherMembers,
      displayName: group.displayName,
      threads,
      unloadedThreadCount: readUnloadedThreadCount(members, threads),
    });
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(confirmationMessage, { variant: "destructive" }),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return notRemoved;
    if (checkProjectAccess(members, "Failed to remove project")) return notRemoved;

    const draftStore = useComposerDraftStore.getState();
    for (const member of members) {
      if (checkProjectAccess([member], "Failed to remove project")) return notRemoved;
      const memberThreads = projectThreads.filter(
        (thread) => thread.environmentId === member.environmentId && thread.projectId === member.id,
      );
      const result = mapAtomCommandResult(
        await deleteProject({
          environmentId: member.environmentId,
          input: {
            projectId: member.id,
            force: true,
          },
        }),
        () => undefined,
      );
      if (result._tag === "Failure") {
        reportProjectCommandFailure(`Failed to remove "${member.title}"`, result);
        return notRemoved;
      }
      const projectRef = scopeProjectRef(member.environmentId, member.id);
      await waitForProjectRemoval(projectRef);
      releaseProjectDraftUploads(
        projectRef,
        memberThreads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
      );
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(projectRef);
    }
    return { removed: true, isWholeGroup };
  };
}
