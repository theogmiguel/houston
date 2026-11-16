import type { MessageDelivery } from "@houston-app/contracts/houston/messageDelivery";

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
