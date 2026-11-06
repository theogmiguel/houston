import { useEffect, useRef } from "react";
import { scopeProjectRef } from "@houston-app/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { requestThreadTags } from "../components/ThreadTagsDialog";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@houston-app/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ScopedThreadRef,
  type ThreadTag,
} from "@houston-app/contracts";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";

import { pickSnoozePreset, resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuCellState,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentServerConfigLoaded,
  readEnvironmentSupportsAutoSettleOptOut,
  readThreadShell,
  readThreadShells,
} from "../state/entities";
import { readLocalApi } from "../localApi";
import { threadRuntimeCanArchive } from "@houston-app/client-runtime/state/models";
import { moveThreadToGridOrExplain, moveToGridTargets } from "../grid/moveToGrid";
import { useGridStore, workspaceKeyOf } from "../grid/gridStore";
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

export type ThreadActionMenuSplitSide = "right" | "bottom";

export interface ThreadActionMenuGridInput {
  /** The grid the surface shows the thread in, or null when no grid shows it. */
  readonly currentGridId: string | null;
  /** The thread is already the grid's focused cell, so there is nothing to open. */
  readonly isFocusedCell: boolean;
  /** Opens the thread where it already lives. */
  readonly onOpen: () => void;
  /** Opens the grid a menu move landed in; absent hides Move to grid. */
  readonly onOpenGrid?: ((gridId: string) => void) | undefined;
}

export interface ThreadActionMenuCellInput {
  readonly split?:
    | {
        readonly availableThreads: ReadonlyArray<{
          readonly threadId: string;
          readonly title: string;
        }>;
        readonly atCap: boolean;
        readonly onPick: (side: ThreadActionMenuSplitSide, threadId: string) => void;
        readonly onNewThread?: (side: ThreadActionMenuSplitSide) => void;
      }
    | null
    | undefined;
  readonly swapTargets?: ReadonlyArray<{ readonly threadId: string; readonly title: string }>;
  readonly onSwapWith?: (threadId: string) => void;
}

export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** The caller's own thread snapshot, for a surface the entity store does not carry. */
  readonly thread?: EnvironmentThreadShell | null;
  readonly onStartRename: () => void;
  readonly onFind?: ((threadRef: ScopedThreadRef) => void) | undefined;
  /** The caller owns thread creation, so this hook stays out of its draft store. */
  readonly handleNewThread?: NewThreadHandler | undefined;
  /** The grid surface this menu acts on; absent for the route header. */
  readonly grid?: ThreadActionMenuGridInput | undefined;
  /** The layout actions a grid cell offers on top of the thread actions. */
  readonly cell?: ThreadActionMenuCellInput | undefined;
  /** A surface whose close/hold/auto-close add local effects to the shared action. */
  readonly onCloseThread?: (() => void) | undefined;
  readonly onHoldThread?: ((snoozedUntil: string) => void) | undefined;
  readonly onSetAutoSettle?: ((enabled: boolean) => void) | undefined;
  /** A grid cell closes itself once its thread is archived. */
  readonly onThreadArchived?: (() => void) | undefined;
  /** The rail's project filter for this thread's project; absent hides Filter by project. */
  readonly projectFilter?:
    | { readonly label: string; readonly isActive: boolean; readonly onToggle: () => void }
    | null
    | undefined;
}) {
  const { threadRef, onStartRename, onFind, handleNewThread, grid, cell } = input;
  const {
    unsettleThread,
    unsnoozeThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
    setThreadTag,
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

  const cellState = (): ThreadActionMenuCellState | undefined => {
    if (cell === undefined) return undefined;
    return {
      split:
        cell.split === undefined || cell.split === null
          ? null
          : {
              availableThreads: cell.split.availableThreads,
              atCap: cell.split.atCap,
              canCreateThread: cell.split.onNewThread !== undefined,
            },
      swapTargets: cell.swapTargets ?? [],
    };
  };

  const menuOpen = useRef(false);
  const openMenu = async (position: { x: number; y: number }) => {
    if (threadRef === null) return;
    menuOpen.current = true;
    const api = readLocalApi();
    if (!api) return;
    const thread = input.thread === undefined ? readThreadShell(threadRef) : input.thread;
    if (thread === null && cell === undefined && grid === undefined) return;
    const now = new Date();
    const nowIso = now.toISOString();
    const environmentId = threadRef.environmentId;
    const configLoaded = thread !== null && readEnvironmentServerConfigLoaded(environmentId);
    const supports = {
      settlement: configLoaded,
      autoSettleOptOut: thread !== null && readEnvironmentSupportsAutoSettleOptOut(environmentId),
      snooze: configLoaded,
      titleRegeneration: configLoaded,
    };
    const canMoveToGrid =
      thread !== null &&
      grid !== undefined &&
      grid.onOpenGrid !== undefined &&
      thread.projectId.length > 0;
    const moveTargets = canMoveToGrid
      ? moveToGridTargets(useGridStore.getState().grids, {
          environmentId,
          projectId: thread.projectId,
          currentGridId: grid?.currentGridId ?? null,
        })
      : [];
    const threadTags = thread?.tags ?? [];
    const workspaceTags = [
      ...new Set([...threadTags, ...readThreadShells().flatMap((shell) => shell.tags ?? [])]),
    ].toSorted((left, right) => left.localeCompare(right));
    const items = buildThreadActionMenuItems({
      canOperate:
        thread !== null && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
      hasThread: thread !== null,
      canFind: thread !== null && onFind !== undefined,
      canStartBranchThread: handleNewThread !== undefined,
      branch: thread?.branch ?? null,
      projectFilter:
        input.projectFilter == null
          ? null
          : { label: input.projectFilter.label, isActive: input.projectFilter.isActive },
      isSettled: thread !== null && supports.settlement && thread.settledOverride === "settled",
      autoSettleEnabled: thread?.autoSettleDisabledAt == null,
      tags: threadTags,
      tagSuggestions: workspaceTags,
      isSnoozed: thread !== null && supports.snooze && effectiveSnoozed(thread, { now: nowIso }),
      canSnoozeNow: thread !== null && canSnooze(thread, { now: nowIso }),
      isRegeneratingTitle: thread !== null && thread.titleRegeneration != null,
      isRunning: thread !== null && !threadRuntimeCanArchive(thread.runtime),
      supports,
      snoozePresets:
        thread !== null ? resolveSnoozePresets(now, timestampFormat, environmentId) : [],
      canTurnIntoProject: thread !== null && canTurnThreadIntoProject(threadRef),
      grid:
        grid === undefined
          ? undefined
          : {
              canOpenInGrid: thread !== null && !grid.isFocusedCell,
              canMoveToGrid,
              moveTargets,
            },
      cell: cellState(),
    });
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    menuOpen.current = false;
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const action: ThreadActionMenuId = clicked.value;
    if (
      threadActionRequiresOperate(action) &&
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
    ) {
      failureToast(
        "Thread action unavailable",
        new Error("This connection cannot change threads."),
      );
      return;
    }
    if (action === "open-in-grid") {
      grid?.onOpen();
      return;
    }
    if (action.startsWith("move-to-grid:")) {
      if (thread === null || grid === undefined) return;
      const target = action.slice("move-to-grid:".length);
      const targetGridId =
        target === "new"
          ? useGridStore.getState().createGrid({
              environmentId: thread.environmentId,
              projectId: thread.projectId,
              workspaceKey: workspaceKeyOf(thread.environmentId, thread.projectId),
            })
          : target;
      const refusal = moveThreadToGridOrExplain({
        threadId: thread.id,
        threadEnvironmentId: thread.environmentId,
        threadProjectId: thread.projectId,
        targetGridId,
      });
      if (refusal !== null) {
        toastManager.add(stackedThreadToast({ type: "error", ...refusal }));
        return;
      }
      grid.onOpenGrid?.(targetGridId);
      return;
    }
    if (action.startsWith("split:")) {
      const rest = action.slice("split:".length);
      const separator = rest.indexOf(":");
      const side = rest.slice(0, separator);
      const target = rest.slice(separator + 1);
      if (side !== "right" && side !== "bottom") return;
      if (target === "new") cell?.split?.onNewThread?.(side);
      else if (target.length > 0 && target !== "none") cell?.split?.onPick(side, target);
      return;
    }
    if (action.startsWith("swap:")) {
      cell?.onSwapWith?.(action.slice("swap:".length));
      return;
    }
    if (thread === null) return;
    if (action.startsWith("snooze:")) {
      const preset =
        action === "snooze:custom"
          ? await requestCustomSnooze()
          : pickSnoozePreset(
              resolveSnoozePresets(now, timestampFormat, environmentId),
              action.slice("snooze:".length),
              timestampFormat,
              environmentId,
            );
      if (!preset) return;
      if (input.onHoldThread) input.onHoldThread(preset.snoozedUntil);
      else await holdThread(threadRef, preset.snoozedUntil);
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
    if (action.startsWith("tag-toggle:")) {
      const tag = action.slice("tag-toggle:".length);
      const tagged = !(thread.tags ?? []).includes(tag);
      await reportFailure(tagged ? "Failed to add tag" : "Failed to remove tag", () =>
        setThreadTag(threadRef, tag as ThreadTag, tagged),
      );
      return;
    }
    if (action === "tag-edit") {
      const current = thread.tags ?? [];
      const next = await requestThreadTags(current);
      if (next === null) return;
      for (const tag of next.filter((candidate) => !current.includes(candidate))) {
        await reportFailure("Failed to add tag", () =>
          setThreadTag(threadRef, tag as ThreadTag, true),
        );
      }
      for (const tag of current.filter((candidate) => !next.includes(candidate))) {
        await reportFailure("Failed to remove tag", () =>
          setThreadTag(threadRef, tag as ThreadTag, false),
        );
      }
      return;
    }
    switch (action) {
      case "find":
        if (onFind === undefined) findThread(threadRef);
        else onFind(threadRef);
        return;
      case "filter-by-project":
        input.projectFilter?.onToggle();
        return;
      case "project-settings":
        await openThreadProjectSettings(threadRef);
        return;
      case "new-thread-on-branch": {
        if (handleNewThread === undefined) return;
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(environmentId, thread.projectId), {
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
        if (input.onCloseThread) input.onCloseThread();
        else await closeThread(threadRef);
        return;
      case "unsettle":
        await reportFailure("Failed to reopen thread", () => unsettleThread(threadRef));
        return;
      case "unsnooze":
        await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
        return;
      case "auto-settle:enabled":
      case "auto-settle:disabled":
        if (input.onSetAutoSettle) {
          input.onSetAutoSettle(action === "auto-settle:enabled");
          return;
        }
        await reportFailure("Failed to update auto-close", () =>
          setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
        );
        return;
      case "rename":
        onStartRename();
        return;
      case "regenerate-title":
        if (thread.titleRegeneration != null) return;
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
            input.onThreadArchived?.();
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
  };

  const closeMenu = () => {
    void readLocalApi()?.contextMenu.close();
  };

  // A surface that goes away takes its menu with it; the DOM fallback outlives the view.
  // oxlint-disable-next-line houston/no-unreasoned-state-sync -- closes the DOM context-menu fallback this surface opened when it unmounts
  useEffect(
    () => () => {
      if (menuOpen.current) closeMenu();
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- closeMenu resolves the live local API, not a render value
    [],
  );

  return { openMenu, closeMenu };
}
