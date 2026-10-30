// The transition rules alone: provider events in, the next delivery out.
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import type { MessageDelivery } from "@t3tools/contracts/houston/messageDelivery";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { acceptedDelivery, deliverySignalOf, nextDelivery } from "./messageDelivery.ts";

const driver = ProviderDriverKind.make("codex");
const threadId = ThreadId.make("thread:1");
const providerThreadId = ProviderThreadId.make("provider-thread:1");
const turnId = ProviderTurnId.make("provider-turn:1");
const messageId = MessageId.make("message:steer");
const t0 = DateTime.makeUnsafe("2026-10-29T12:00:00.000Z");
const later = (seconds: number) => DateTime.add(t0, { seconds });

const providerTurn = (status: OrchestrationV2ProviderTurn["status"]): OrchestrationV2ProviderTurn => ({
  id: turnId,
  providerThreadId,
  nodeId: NodeId.make("node:1"),
  runAttemptId: RunAttemptId.make("attempt:1"),
  nativeTurnRef: null,
  ordinal: 1,
  status,
  startedAt: t0,
  completedAt: status === "running" ? null : t0,
});

const turnUpdated = (status: OrchestrationV2ProviderTurn["status"]): ProviderAdapterV2Event => ({
  type: "provider_turn.updated",
  driver,
  threadId,
  providerTurn: providerTurn(status),
});

const itemUpdated = (type: "assistant_message" | "command_execution"): ProviderAdapterV2Event =>
  ({
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(`turn-item:${type}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId,
      providerTurnId: turnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "running",
      title: null,
      startedAt: t0,
      completedAt: null,
      updatedAt: t0,
      ...(type === "assistant_message"
        ? { type, messageId: MessageId.make("message:assistant"), text: "on it", streaming: true }
        : { type, input: "ls", output: "", exitCode: null }),
    },
  }) as ProviderAdapterV2Event;

const report = (
  state: "adopted" | "dropped",
  evidence: "codex.userMessage" | null = state === "adopted" ? "codex.userMessage" : null,
): ProviderAdapterV2Event => ({
  type: "message.delivery",
  driver,
  threadId,
  providerThreadId,
  providerTurnId: turnId,
  messageId,
  state,
  evidence,
  ...(state === "dropped" ? { reason: "providerCancelled" as const } : {}),
});

const steer = acceptedDelivery({ intent: "steer", route: "activeTurn", at: t0 });
const deliveredSteer = nextDelivery(steer, {
  type: "delivered",
  providerTurnId: turnId,
  adoption: "reported",
  at: later(1),
});
const ownTurn = nextDelivery(acceptedDelivery({ intent: "queue", route: "ownTurn", at: t0 }), {
  type: "delivered",
  providerTurnId: null,
  adoption: "reported",
  at: later(1),
});

const fold = (
  start: MessageDelivery,
  events: ReadonlyArray<readonly [ProviderAdapterV2Event, number]>,
): MessageDelivery =>
  events.reduce((current, [event, seconds]) => {
    const signal = deliverySignalOf(event, later(seconds));
    return signal === null ? current : nextDelivery(current, signal);
  }, start);

describe("message delivery transitions", () => {
  it("only provider evidence adopts", () => {
    expect(deliveredSteer).toMatchObject({
      state: "delivered",
      adoption: "reported",
      providerTurnId: turnId,
    });
    const rows: ReadonlyArray<
      readonly [
        string,
        MessageDelivery,
        ReadonlyArray<readonly [ProviderAdapterV2Event, number]>,
        Partial<MessageDelivery>,
      ]
    > = [
      [
        "assistant text",
        deliveredSteer,
        [[itemUpdated("assistant_message"), 2]],
        { state: "delivered" },
      ],
      [
        "tool activity",
        deliveredSteer,
        [[itemUpdated("command_execution"), 2]],
        { state: "delivered" },
      ],
      [
        "turn completion",
        deliveredSteer,
        [
          [itemUpdated("assistant_message"), 2],
          [turnUpdated("completed"), 3],
        ],
        { state: "unconfirmed", evidence: null },
      ],
      [
        "elapsed time",
        deliveredSteer,
        [
          [itemUpdated("assistant_message"), 60],
          [itemUpdated("command_execution"), 600],
          [itemUpdated("assistant_message"), 3_600],
        ],
        { state: "delivered", evidence: null },
      ],
      [
        "message.delivery adopted",
        deliveredSteer,
        [[report("adopted"), 2]],
        { state: "adopted", evidence: "codex.userMessage", providerTurnId: turnId },
      ],
      [
        "own turn running",
        ownTurn,
        [[turnUpdated("running"), 2]],
        { state: "adopted", evidence: "turnStarted", adoption: "reported", providerTurnId: turnId },
      ],
    ];
    for (const [label, start, events, expected] of rows) {
      expect(fold(start, events), label).toMatchObject(expected);
    }
    // A steer's target turn running is not evidence that the steer was read.
    expect(fold(deliveredSteer, [[turnUpdated("running"), 2]]).state).toBe("delivered");
  });

  it("a delivered steer is unconfirmed when its turn ends", () => {
    for (const status of ["completed", "interrupted", "cancelled", "failed"] as const) {
      expect(fold(deliveredSteer, [[turnUpdated(status), 5]]), status).toMatchObject({
        state: "unconfirmed",
        providerTurnId: turnId,
      });
    }
    expect(
      nextDelivery(deliveredSteer, { type: "turnEnded", providerTurnId: turnId, at: later(5) })
        .state,
    ).toBe("unconfirmed");
    // A turn the steer was not delivered to ends without touching it.
    expect(
      nextDelivery(deliveredSteer, {
        type: "turnEnded",
        providerTurnId: ProviderTurnId.make("provider-turn:other"),
        at: later(5),
      }).state,
    ).toBe("delivered");
  });

  it("transitions follow the state diagram", () => {
    const adopted = fold(deliveredSteer, [[report("adopted"), 2]]);
    expect(adopted.state).toBe("adopted");
    // delivered after adopted is ignored
    expect(
      nextDelivery(adopted, {
        type: "delivered",
        providerTurnId: turnId,
        adoption: "notReported",
        at: later(3),
      }),
    ).toEqual(adopted);
    // a second adopted is ignored
    expect(fold(adopted, [[report("adopted"), 4]])).toEqual(adopted);
    // adopted after unconfirmed is applied
    const unconfirmed = fold(deliveredSteer, [[turnUpdated("completed"), 2]]);
    expect(unconfirmed.state).toBe("unconfirmed");
    expect(fold(unconfirmed, [[report("adopted"), 9]])).toMatchObject({
      state: "adopted",
      evidence: "codex.userMessage",
    });
    // dropped after adopted is ignored
    expect(fold(adopted, [[report("dropped"), 5]])).toEqual(adopted);
    expect(nextDelivery(adopted, { type: "failed", message: "boom", at: later(5) })).toEqual(
      adopted,
    );
    // unconfirmed accepts nothing but adopted
    expect(
      nextDelivery(unconfirmed, { type: "failed", message: "boom", at: later(5) }),
    ).toEqual(unconfirmed);
    expect(fold(unconfirmed, [[report("dropped"), 5]])).toEqual(unconfirmed);
    // dropped accepts nothing further
    const dropped = nextDelivery(steer, { type: "cancelled", at: later(1) });
    expect(fold(dropped, [[report("adopted"), 2]])).toEqual(dropped);
  });

  it("a provider that takes a message back drops it", () => {
    expect(fold(deliveredSteer, [[report("dropped"), 2]])).toMatchObject({
      state: "dropped",
      reason: "providerCancelled",
      evidence: null,
    });
  });

  it("records a reroute without leaving accepted", () => {
    const rerouted = nextDelivery(steer, { type: "rerouted", reason: "turnEnded", at: later(1) });
    expect(rerouted).toMatchObject({
      intent: "steer",
      route: "ownTurn",
      rerouted: "turnEnded",
      state: "accepted",
    });
  });

  it("names the error of a failed effect", () => {
    expect(
      nextDelivery(steer, { type: "failed", message: "Codex rejected the steer.", at: later(1) }),
    ).toMatchObject({ state: "dropped", reason: "failed", message: "Codex rejected the steer." });
  });
});
