import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@houston-app/contracts";

import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readThreadShell,
} from "../state/entities";
import { readLocalApi } from "../localApi";
import { threadRuntimeCanArchive } from "@houston-app/client-runtime/state/models";
import { useClientSettings } from "./useSettings";
import { canTurnThreadIntoProject, useThreadActions } from "./useThreadActions";
import type { NewThreadHandler } from "./useHandleNewThread";

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly onStartRename: () => void;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The caller owns thread creation, so this hook stays out of its draft store. */
  readonly handleNewThread: NewThreadHandler;
}) {
  const { threadRef, onStartRename, onFind, handleNewThread } = input;
  const {
    unsettleThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    turnThreadIntoProject,
    regenerateThreadTitle,
    copyThreadPath,
    copyThreadBranch,
    copyThreadRef,
    copyThreadId,
    findThread,
    openThreadProjectSettings,
    holdThread,
    closeThread,
  } = useThreadActions();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const openMenu = (position: { x: number; y: number }) => {
    if (threadRef === null) return;
    void (async () => {
      const api = readLocalApi();
      if (!api) return;
      const thread = readThreadShell(threadRef);
      if (!thread) return;
      const now = new Date();
      const configLoaded = readEnvironmentServerConfigLoaded(threadRef.environmentId);
      const supports = {
        settlement: configLoaded,
        autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
        snooze: configLoaded,
        pinning: configLoaded,
        titleRegeneration: configLoaded,
      };
      const isRegeneratingTitle = thread.titleRegeneration != null;
      const snoozePresets = resolveSnoozePresets(now, timestampFormat, threadRef.environmentId);
      const items = buildThreadActionMenuItems({
        canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
        canFind: onFind !== undefined,
        branch: thread.branch ?? null,
        projectFilter: null,
        isPinned: thread.pinnedAt != null,
        isSettled: supports.settlement && thread.settledOverride === "settled",
        autoSettleEnabled: thread.autoSettleDisabledAt == null,
        isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
        canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
        isRegeneratingTitle,
        isRunning: !threadRuntimeCanArchive(thread.runtime),
        supports,
        snoozePresets,
        canTurnIntoProject: canTurnThreadIntoProject(threadRef),
      });
      const clicked = await settlePromise(() => api.contextMenu.show(items, position));
      if (clicked._tag === "Failure" || clicked.value === null) return;
      const action: ThreadActionMenuId = clicked.value;
      if (
        threadActionRequiresOperate(action) &&
        !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
      ) {
        failureToast(
          "Thread action unavailable",
          new Error("This connection cannot change threads."),
        );
        return;
      }
      if (action.startsWith("snooze:")) {
        const preset =
          action === "snooze:custom"
            ? await requestCustomSnooze()
            : pickSnoozePreset(
                snoozePresets,
                action.slice("snooze:".length),
                timestampFormat,
                threadRef.environmentId,
              );
        if (!preset) return;
        await holdThread(threadRef, preset.snoozedUntil);
        return;
      }
      const reportFailure = async (
        title: string,
        run: () => Promise<AtomCommandResult<unknown, unknown>>,
      ) => {
        const result = await run();
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(title, squashAtomCommandFailure(result));
        }
      };
      switch (action) {
        case "find":
          if (onFind === undefined) findThread(threadRef);
          else onFind(threadRef);
          return;
        case "project-settings":
          await openThreadProjectSettings(threadRef);
          return;
        case "new-thread-on-branch": {
          const result = await settlePromise(() =>
            handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
              branch: thread.branch,
              worktreePath: thread.worktreePath,
              envMode: thread.worktreePath ? "worktree" : "local",
              startFromOrigin: false,
            }),
          );
          if (result._tag === "Failure") {
            failureToast("Could not create thread", squashAtomCommandFailure(result));
          }
          return;
        }
        case "settle":
          await closeThread(threadRef);
          return;
        case "unsettle":
          await reportFailure("Failed to reopen thread", () => unsettleThread(threadRef));
          return;
        case "unsnooze":
          await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
          return;
        case "pin":
          await reportFailure("Failed to pin thread", () => pinThread(threadRef));
          return;
        case "unpin": {
          await reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(threadRef));
          return;
        }
        case "auto-settle:enabled":
        case "auto-settle:disabled":
          await reportFailure("Failed to update auto-close", () =>
            setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
          );
          return;
        case "rename":
          onStartRename();
          return;
        case "regenerate-title":
          if (isRegeneratingTitle) return;
          await reportFailure("Failed to regenerate thread title", () =>
            regenerateThreadTitle(threadRef),
          );
          return;
        case "mark-unread":
          markThreadUnread(threadRef);
          return;
        case "turn-into-project": {
          const result = await turnThreadIntoProject(threadRef);
          if (result._tag === "Success") {
            toastManager.add({
              type: "success",
              title: "Project created",
              description: thread.title,
            });
          } else if (!isAtomCommandInterrupted(result)) {
            failureToast("Could not turn thread into a project", squashAtomCommandFailure(result));
          }
          return;
        }
        case "copy-path":
          await copyThreadPath(threadRef);
          return;
        case "copy-branch":
          await copyThreadBranch(threadRef);
          return;
        case "copy-thread":
          await copyThreadRef(threadRef);
          return;
        case "copy-thread-id":
          await copyThreadId(threadRef);
          return;
        case "archive": {
          if (confirmThreadArchive) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(`Archive thread "${thread.title}"?`),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          let didArchive = false;
          const result = await archiveThread(threadRef, {
            onArchived: () => {
              didArchive = true;
            },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(
              didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
              squashAtomCommandFailure(result),
            );
          }
          return;
        }
        case "delete": {
          if (confirmThreadDelete) {
            const confirmed = await settlePromise(() =>
              api.dialogs.confirm(
                [
                  `Delete thread "${thread.title}"?`,
                  "This permanently clears conversation history for this thread.",
                ].join("\n"),
                { variant: "destructive" },
              ),
            );
            if (confirmed._tag === "Failure" || !confirmed.value) return;
          }
          const deleted = await deleteThread(threadRef);
          if (
            deleted._tag === "Failure" &&
            !isAtomCommandInterrupted(deleted) &&
            // A missing thread means cleanup failed after deletion; deleteThread already toasted that failure.
            readThreadShell(threadRef) !== null
          ) {
            failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
          }
          return;
        }
        default:
          return;
      }
    })();
  };

  const closeMenu = () => {
    void readLocalApi()?.contextMenu.close();
  };

  return { openMenu, closeMenu };
}
