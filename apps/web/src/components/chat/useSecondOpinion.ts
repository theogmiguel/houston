import type { ProviderInstanceId, RunId, ScopedThreadRef } from "@houston-app/contracts";
import { createModelSelection } from "@houston-app/shared/model";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@houston-app/client-runtime/state/runtime";
import { newThreadId } from "~/lib/utils";
import { useStableCallback } from "../../hooks/useStableCallback";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

/**
 * Requests a read-only second opinion from another provider on one turn. The review runs in
 * its own side thread and enters the source thread only through Send to thread.
 */
export function useSecondOpinion(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly onError: (message: string) => void;
}) {
  const request = useAtomCommand(threadEnvironment.requestSecondOpinion, { reportFailure: false });
  const requestReview = async ({
    runId,
    instanceId,
    model,
  }: {
    readonly runId: RunId;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }) => {
    const { threadRef } = input;
    if (threadRef === null) return;
    const result = await request({
      environmentId: threadRef.environmentId,
      input: {
        sourceThreadId: threadRef.threadId,
        runId,
        reviewThreadId: newThreadId(),
        modelSelection: createModelSelection(instanceId, model),
      },
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "info",
        title: "Second opinion requested",
        description: "The review appears under the turn when it finishes.",
      });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    input.onError(error instanceof Error ? error.message : "Could not request a second opinion.");
  };
  return { requestReview: useStableCallback(requestReview) };
}
