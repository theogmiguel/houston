import type { MessageDelivery } from "@houston-app/contracts/houston/messageDelivery";
import { describe, expect, it } from "vite-plus/test";

import { messageDeliveryPresentation } from "./messageDelivery";

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
