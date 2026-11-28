import type { OrchestrationV2AppThread, RunStartOrigin } from "@houston-app/contracts";
import type { MessageDeliveryQueueHoldReason } from "@houston-app/contracts/houston/messageDelivery";

import type { RunStartHold } from "./RunStartGate.ts";

export const STOPPED_THREAD_HOLD_MESSAGE =
  "Waiting because you stopped this thread. It starts when you press Resume or send a message.";

export function stoppedThreadHoldReason(): MessageDeliveryQueueHoldReason {
  return { kind: "stopped_thread", message: STOPPED_THREAD_HOLD_MESSAGE };
}

/**
 * The first admission step: after the user presses Stop, automatic runs wait on their own until
 * the user resumes or sends a message. A typed send and provider output never reach this step.
 */
export function stoppedThreadAdmission(input: {
  readonly origin: RunStartOrigin;
  readonly holdAgentMessagesAfterStop: boolean;
  readonly thread: Pick<OrchestrationV2AppThread, "heldAfterStop">;
}): RunStartHold | null {
  if (
    input.origin !== "automatic" ||
    !input.holdAgentMessagesAfterStop ||
    input.thread.heldAfterStop !== true
  ) {
    return null;
  }
  return { type: "hold", releaseAt: null, reason: stoppedThreadHoldReason() };
}
