import type {
  MessageDelivery,
  MessageDeliveryQueueHoldReason,
} from "@houston-app/contracts/houston/messageDelivery";
import { describe, expect, it } from "vite-plus/test";

import { messageDeliveryPresentation, queueHeldPresentation } from "./messageDelivery";

const delivery = (overrides: Partial<MessageDelivery>): MessageDelivery => ({
  intent: "steer",
  route: "activeTurn",
  state: "accepted",
  adoption: null,
  evidence: null,
  providerTurnId: null,
  at: "2026-01-01T00:00:00.000Z" as unknown as MessageDelivery["at"],
  ...overrides,
});

describe("messageDeliveryPresentation", () => {
  it("names every state in a label the composer can show quietly", () => {
    expect(messageDeliveryPresentation(delivery({ state: "accepted" })).label).toBe("Accepted");
    expect(messageDeliveryPresentation(delivery({ state: "delivered" })).label).toBe("Delivered");
    expect(messageDeliveryPresentation(delivery({ state: "adopted" })).label).toBe(
      "Read by the agent",
    );
    expect(messageDeliveryPresentation(delivery({ state: "unconfirmed" })).label).toBe(
      "Delivery unconfirmed",
    );
    expect(messageDeliveryPresentation(delivery({ state: "dropped" })).label).toBe("Dropped");
  });

  it("keeps a dropped message's provider reason", () => {
    expect(
      messageDeliveryPresentation(
        delivery({
          state: "dropped",
          reason: "providerCancelled",
        }),
      ).detail,
    ).toBe("The provider stopped the turn before reading this message.");
    expect(
      messageDeliveryPresentation(
        delivery({ state: "dropped", reason: "failed", message: "Rate limited" }),
      ).detail,
    ).toBe("The message was not delivered: Rate limited");
    expect(
      messageDeliveryPresentation(delivery({ state: "dropped", reason: "cancelled" })).detail,
    ).toBe("The message was cancelled before delivery.");
  });

  it("marks the states a user has to act on", () => {
    expect(messageDeliveryPresentation(delivery({ state: "unconfirmed" })).tone).toBe("warning");
    expect(messageDeliveryPresentation(delivery({ state: "dropped" })).tone).toBe("warning");
    expect(messageDeliveryPresentation(delivery({ state: "adopted" })).tone).toBe("muted");
  });
});

describe("a held queued message", () => {
  const reason = (
    overrides: Partial<Pick<MessageDeliveryQueueHoldReason, "kind" | "message">> = {},
  ): MessageDeliveryQueueHoldReason => ({
    kind: overrides.kind ?? "disabled_instance",
    message: overrides.message ?? "Provider instance claude_2 is disabled for this project.",
    providerInstanceId: "claude_2" as NonNullable<
      MessageDeliveryQueueHoldReason["providerInstanceId"]
    >,
  });

  it("never reads as accepted for delivery", () => {
    const presentation = messageDeliveryPresentation(
      delivery({ state: "accepted", queueHeldReason: reason({}) }),
    );
    expect(presentation.label).toBe("Held");
    expect(presentation.tone).toBe("warning");
    expect(presentation.detail).toBe("Provider instance claude_2 is disabled for this project.");
  });

  it("names the provider and the reason in one line", () => {
    const providerName = (instanceId: string) =>
      instanceId === "claude_2" ? "Claude 2" : instanceId;
    expect(queueHeldPresentation(reason({}), providerName).label).toBe(
      "Held: Claude 2 is disabled",
    );
    expect(queueHeldPresentation(reason({ kind: "usage_limit" }), providerName).label).toBe(
      "Held: Claude 2 reached its usage limit",
    );
    expect(
      queueHeldPresentation(reason({ kind: "runtime_mode_ceiling" }), providerName).label,
    ).toBe("Held: The thread is above the server's runtime mode limit");
    expect(
      queueHeldPresentation(reason({ kind: "provider_switch_failed" }), providerName).label,
    ).toBe("Held: Claude 2 failed its last run");
    expect(
      queueHeldPresentation(reason({ kind: "workspace_preparation" }), providerName).label,
    ).toBe("Held: The workspace could not be prepared");
    expect(queueHeldPresentation(reason({ kind: "background_work" }), providerName).label).toBe(
      "Held: Waiting for background work to finish",
    );
  });

  it("does not invent a provider name when the reason names none", () => {
    expect(
      queueHeldPresentation(
        { kind: "disabled_instance", message: "This provider is disabled." },
        (id) => id,
      ).label,
    ).toBe("Held: This provider is disabled");
  });
});
