import { createContext } from "react";

import { scopedThreadKey, scopeThreadRef } from "@houston-app/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@houston-app/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@houston-app/client-runtime/state/models";
import { canSnooze } from "@houston-app/client-runtime/state/thread-settled";

import { requestConfirmDialog } from "../../confirmDialog";
import {
  bulkDeleteConfirmation,
  buildBulkMenuItems,
  type BulkMenuAction,
} from "../../threads/sidebarBulkMenu";
import { useThreadActions } from "../../hooks/useThreadActions";
import { useClientSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Opens the multi-selection menu at a point; null while fewer than two rows are selected. */
export const ThreadBulkMenuContext = createContext<
  ((position: { x: number; y: number }) => void) | null
>(null);

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The right-click menu of a multi-selection. Close and Hold go through the
 * rail's own handlers so the open workspace advances as it does for one thread.
 */
export function useBulkThreadMenu(input: {
  selectedThreads: ReadonlyArray<EnvironmentThreadShell>;
  nowIso: string;
  onClose: (threads: ReadonlyArray<EnvironmentThreadShell>) => void;
  onHold: (threads: ReadonlyArray<EnvironmentThreadShell>, snoozedUntil: string) => void;
  /** Called once the chosen action has been dispatched. */
  onDone: () => void;
}): (position: { x: number; y: number }) => Promise<void> {
  const { markThreadUnread, deleteThread, regenerateThreadTitle } = useThreadActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  return async (position) => {
    const api = readLocalApi();
    const threads = input.selectedThreads;
    const first = threads[0];
    if (api === undefined || first === undefined) return;
    const closable = threads.filter((thread) => thread.settledOverride !== "settled");
    const regeneratable = threads.filter((thread) => thread.titleRegeneration == null);
    // Presets sync across environments, so the first selected thread's stand for all.
    const presets = resolveSnoozePresets(new Date(), timestampFormat, first.environmentId);
    const clicked = await settlePromise(() =>
      api.contextMenu.show(
        buildBulkMenuItems({
          count: threads.length,
          closableCount: closable.length,
          holdable: threads.every((thread) => canSnooze(thread, { now: input.nowIso })),
          presets,
          regeneratableCount: regeneratable.length,
        }),
        position,
      ),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    const action: BulkMenuAction = clicked.value;
    const refOf = (thread: EnvironmentThreadShell) =>
      scopeThreadRef(thread.environmentId, thread.id);

    if (action.startsWith("hold:")) {
      const preset =
        action === "hold:custom"
          ? await requestCustomSnooze()
          : pickSnoozePreset(
              presets,
              action.slice("hold:".length),
              timestampFormat,
              first.environmentId,
            );
      if (preset === null || preset === undefined) return;
      input.onHold(threads, preset.snoozedUntil);
      input.onDone();
      return;
    }
    switch (action) {
      case "close":
        input.onClose(closable);
        input.onDone();
        return;
      case "mark-unread":
        for (const thread of threads) markThreadUnread(refOf(thread));
        input.onDone();
        return;
      case "regenerate-title":
        for (const thread of regeneratable) {
          const result = await regenerateThreadTitle(refOf(thread));
          if (result._tag === "Failure") {
            failureToast("Failed to regenerate thread titles", squashAtomCommandFailure(result));
            return;
          }
        }
        input.onDone();
        return;
      case "delete": {
        const confirmed = await requestConfirmDialog(bulkDeleteConfirmation(threads.length), {
          variant: "destructive",
        });
        if (confirmed !== true) return;
        const deleted = new Set<string>();
        for (const thread of threads) {
          const result = await deleteThread(refOf(thread), { deletedThreadKeys: deleted });
          if (result !== null && result !== undefined && result._tag === "Failure") {
            failureToast("Failed to delete threads", squashAtomCommandFailure(result));
            break;
          }
          deleted.add(scopedThreadKey(refOf(thread)));
        }
        input.onDone();
        return;
      }
    }
  };
}
