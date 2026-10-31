import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OrchestrationV2TurnItem, OrchestrationV2TurnItemJson } from "../orchestrationV2.ts";
import { MessageDeliveryJson } from "./messageDelivery.ts";

const decodeJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeItem = Schema.encodeSync(OrchestrationV2TurnItem);
const decodeDelivery = Schema.decodeUnknownSync(MessageDeliveryJson);

// A user_message payload as payload_json stored it before deliveries existed.
const storedUserMessage = {
  id: "turn-item:message:m1",
  threadId: "thread:1",
  runId: "run:1",
  nodeId: "node:1",
  providerThreadId: "provider-thread:1",
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 100,
  status: "completed",
  title: null,
  startedAt: "2026-10-29T12:00:00.000Z",
  completedAt: "2026-10-29T12:00:00.000Z",
  updatedAt: "2026-10-29T12:00:00.000Z",
  createdBy: "user",
  creationSource: "web",
  type: "user_message",
  messageId: "message:m1",
  inputIntent: "steer",
  text: "Actually, do this instead",
  attachments: [],
};

const at = "2026-10-29T12:00:01.000Z";
const deliveries = [
  {
    intent: "queue",
    route: "ownTurn",
    state: "accepted",
    adoption: null,
    evidence: null,
    providerTurnId: null,
    at,
  },
  {
    intent: "steer",
    route: "activeTurn",
    state: "delivered",
    adoption: "notReported",
    evidence: null,
    providerTurnId: "provider-turn:1",
    at,
  },
  {
    intent: "steer",
    route: "activeTurn",
    promotedFrom: "queue",
    state: "adopted",
    adoption: "reported",
    evidence: "codex.userMessage",
    providerTurnId: "provider-turn:1",
    at,
  },
  {
    intent: "steer",
    route: "activeTurn",
    state: "unconfirmed",
    adoption: "notReported",
    evidence: null,
    providerTurnId: "provider-turn:1",
    at,
  },
  {
    intent: "interrupt",
    route: "ownTurn",
    state: "dropped",
    adoption: null,
    evidence: null,
    reason: "failed",
    message: "Codex rejected the turn.",
    providerTurnId: null,
    at,
  },
  {
    intent: "steer",
    route: "ownTurn",
    rerouted: "turnEnded",
    state: "accepted",
    adoption: null,
    evidence: null,
    providerTurnId: null,
    at,
  },
];

describe("message delivery decoding", () => {
  it("items stored before deliveries decode unchanged", () => {
    const fromJson = decodeJson(storedUserMessage);
    expect("delivery" in fromJson).toBe(false);
    const reencoded = encodeJson(fromJson);
    expect("delivery" in reencoded).toBe(false);
    expect(reencoded).toEqual(storedUserMessage);

    // The domain form holds DateTime values; validate the decoded item against it.
    const item = decodeItem(fromJson);
    expect("delivery" in item).toBe(false);
    expect("delivery" in encodeItem(item)).toBe(false);
  });

  it("every delivery state decodes", () => {
    const states = new Set<string>();
    for (const delivery of deliveries) {
      const decoded = decodeJson({ ...storedUserMessage, delivery });
      expect(decoded.type).toBe("user_message");
      if (decoded.type !== "user_message") continue;
      expect(decoded.delivery?.state).toBe(delivery.state);
      expect(encodeJson(decoded)).toEqual({ ...storedUserMessage, delivery });
      expect(encodeItem(decodeItem(decoded))).toEqual(encodeItem(decoded));
      states.add(delivery.state);
    }
    expect([...states].toSorted()).toEqual([
      "accepted",
      "adopted",
      "delivered",
      "dropped",
      "unconfirmed",
    ]);
  });

  it("refuses values outside the literal shape", () => {
    const valid = deliveries[1]!;
    expect(() => decodeDelivery({ ...valid, state: "read" })).toThrow();
    expect(() => decodeDelivery({ ...valid, evidence: "assistantText" })).toThrow();
    expect(() => decodeDelivery({ ...valid, reason: "timeout" })).toThrow();
    expect(() => decodeDelivery({ ...valid, message: "x".repeat(4_097) })).toThrow();
  });
});
