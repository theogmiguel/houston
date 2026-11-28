import type {
  MessageDelivery,
  MessageDeliveryQueueHoldReason,
} from "@houston-app/contracts/houston/messageDelivery";

export interface MessageDeliveryPresentation {
  readonly label: string;
  readonly detail: string;
  readonly tone: "muted" | "warning";
}

/** The quiet label a follow-up message wears while it is queued, steered or interrupted. */
export function messageDeliveryPresentation(
  delivery: MessageDelivery,
): MessageDeliveryPresentation {
  switch (delivery.state) {
    case "accepted":
      if (delivery.queueHeldReason !== undefined && delivery.queueHeldReason !== null) {
        return { label: "Held", detail: delivery.queueHeldReason.message, tone: "warning" };
      }
      return {
        label: "Accepted",
        detail: "The server accepted this message and will deliver it to the agent.",
        tone: "muted",
      };
    case "delivered":
      return {
        label: "Delivered",
        detail: "The message reached the provider.",
        tone: "muted",
      };
    case "adopted":
      return {
        label: "Read by the agent",
        detail: "The provider confirmed the agent read this message.",
        tone: "muted",
      };
    case "unconfirmed":
      return {
        label: "Delivery unconfirmed",
        detail: "The provider did not confirm reading this message.",
        tone: "warning",
      };
    case "dropped":
      return {
        label: "Dropped",
        detail:
          delivery.reason === "providerCancelled"
            ? "The provider stopped the turn before reading this message."
            : delivery.reason === "failed"
              ? delivery.message
                ? `The message was not delivered: ${delivery.message}`
                : "The message was not delivered."
              : "The message was cancelled before delivery.",
        tone: "warning",
      };
  }
}

/**
 * The one-line reason a held queued message shows where its delivery label would be, so a
 * message the server cannot start never reads as accepted for delivery.
 */
export function queueHeldPresentation(
  reason: MessageDeliveryQueueHoldReason,
  providerName: (instanceId: string) => string,
): MessageDeliveryPresentation {
  const provider =
    reason.providerInstanceId === undefined ? null : providerName(reason.providerInstanceId);
  const subject = provider ?? "This provider";
  const text =
    reason.kind === "disabled_instance"
      ? `${subject} is disabled`
      : reason.kind === "usage_limit"
        ? `${subject} reached its usage limit`
        : reason.kind === "runtime_mode_ceiling"
          ? "The thread is above the server's runtime mode limit"
          : reason.kind === "provider_switch_failed"
            ? `${subject} failed its last run`
            : reason.kind === "workspace_preparation"
              ? "The workspace could not be prepared"
              : reason.kind === "stopped_thread"
                ? "You stopped this thread"
                : reason.kind === "context_compaction"
                  ? "Waiting for compaction"
                  : reason.kind === "load"
                    ? "Waiting for memory"
                    : "Waiting for background work to finish";
  return { label: `Held: ${text}`, detail: reason.message, tone: "warning" };
}
