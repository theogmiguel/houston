import { scopedThreadKey } from "@houston-app/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
} from "@houston-app/client-runtime/state/runtime";
import type { RunId, ScopedThreadRef } from "@houston-app/contracts";

import { reportFailure } from "../components/sidebar/reportFailure";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import type { Translate } from "../i18n/useT";

interface QueuedCloseRefusal {
  readonly target: ScopedThreadRef;
  readonly title: string;
  /** The messages the server named, in the order they would be sent. Never empty. */
  readonly runIds: ReadonlyArray<RunId>;
  readonly translate: Translate;
  readonly send: (runId: RunId) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly remove: (runId: RunId) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly close: () => Promise<void>;
}

/** One notice per thread: a second refusal replaces the first. */
export function queuedCloseRefusalToastId(target: ScopedThreadRef): string {
  return `queued-close-refusal:${scopedThreadKey(target)}`;
}

/** Sends the next message and the queue behind it. The thread then runs, so it stays open. */
async function sendQueued(refusal: QueuedCloseRefusal): Promise<void> {
  const next = refusal.runIds[0];
  if (next === undefined) return;
  reportFailure(refusal.translate("Failed to send queued message"), await refusal.send(next));
}

/** An interrupted request may still have reached the server, so this claims only what did. */
function reportInterruptedRemoval(
  { runIds, translate }: QueuedCloseRefusal,
  removed: number,
): void {
  const count = runIds.length;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title:
        count === 1
          ? translate("Removing the queued message was interrupted")
          : translate("Removing queued message {position} of {count} was interrupted", {
              position: removed + 1,
              count,
            }),
      description: translate("Removed {removed} of {count}. Check the queue for the rest.", {
        removed,
        count,
      }),
    }),
  );
}

/**
 * Discards every message the refusal named, and only those, then closes the thread. The close
 * asks the server again, so a message queued since is refused and kept.
 */
async function removeQueuedThenClose(refusal: QueuedCloseRefusal): Promise<void> {
  const { runIds, translate } = refusal;
  for (const [index, runId] of runIds.entries()) {
    const result = await refusal.remove(runId);
    if (isAtomCommandInterrupted(result)) return reportInterruptedRemoval(refusal, index);
    if (result._tag === "Failure") {
      reportFailure(
        runIds.length === 1
          ? translate("Queued message was not removed")
          : translate("Queued message {position} of {count} was not removed", {
              position: index + 1,
              count: runIds.length,
            }),
        result,
      );
      return;
    }
  }
  await refusal.close();
}

/** Says a close was refused by queued messages and offers the two ways out. */
export function showQueuedCloseRefusal(refusal: QueuedCloseRefusal): void {
  const { runIds, title, translate } = refusal;
  const count = runIds.length;
  const id = queuedCloseRefusalToastId(refusal.target);
  let answered = false;
  const answer = (act: (refusal: QueuedCloseRefusal) => Promise<void>) => () => {
    if (answered) return;
    answered = true;
    toastManager.close(id);
    void act(refusal);
  };
  toastManager.add({
    ...stackedThreadToast({
      type: "warning",
      title: translate("Failed to close thread"),
      description:
        count === 1
          ? translate("“{title}” has a queued message.", { title })
          : translate("“{title}” has {count} queued messages.", { title, count }),
      timeout: 0,
      actionProps: { children: translate("Send now"), onClick: answer(sendQueued) },
      data: {
        secondaryActionProps: {
          children:
            count === 1
              ? translate("Remove and close")
              : translate("Remove {count} and close", { count }),
          onClick: answer(removeQueuedThenClose),
        },
        secondaryActionVariant: "destructive-outline",
      },
    }),
    id,
  });
}
