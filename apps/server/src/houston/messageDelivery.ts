// Delivery states for queued, steered and interrupting messages. The transition rules are one
// pure function; the writer applies them to the stored user_message turn item.
import {
  type MessageId,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderSessionId,
  type ProviderTurnId,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type {
  MessageDelivery,
  MessageDeliveryEvidence,
  MessageDeliveryReportEvidence,
} from "@t3tools/contracts/houston/messageDelivery";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export type DeliverySignal =
  | {
      readonly type: "delivered";
      readonly providerTurnId: ProviderTurnId | null;
      readonly adoption: "reported" | "notReported";
      readonly at: DateTime.Utc;
    }
  | {
      readonly type: "report";
      readonly state: "adopted" | "dropped";
      readonly evidence: MessageDeliveryReportEvidence | null;
      readonly providerTurnId: ProviderTurnId;
      readonly at: DateTime.Utc;
    }
  | {
      readonly type: "turnRunning";
      readonly providerTurnId: ProviderTurnId;
      readonly at: DateTime.Utc;
    }
  | {
      readonly type: "turnEnded";
      readonly providerTurnId: ProviderTurnId;
      readonly at: DateTime.Utc;
    }
  | { readonly type: "cancelled"; readonly at: DateTime.Utc }
  | { readonly type: "failed"; readonly message: string; readonly at: DateTime.Utc }
  | {
      readonly type: "rerouted";
      readonly reason: "turnEnded" | "turnBusy";
      readonly at: DateTime.Utc;
    };

export const acceptedDelivery = (input: {
  readonly intent: MessageDelivery["intent"];
  readonly route: MessageDelivery["route"];
  readonly rerouted?: "turnEnded" | "turnBusy";
  readonly promotedFrom?: "queue";
  readonly at: DateTime.Utc;
}): MessageDelivery => ({
  intent: input.intent,
  route: input.route,
  ...(input.rerouted === undefined ? {} : { rerouted: input.rerouted }),
  ...(input.promotedFrom === undefined ? {} : { promotedFrom: input.promotedFrom }),
  state: "accepted",
  adoption: null,
  evidence: null,
  providerTurnId: null,
  at: input.at,
});

const MAX_MESSAGE_LENGTH = 4_096;

const ENDED_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "cancelled",
  "failed",
]);

const adopt = (
  current: MessageDelivery,
  evidence: MessageDeliveryEvidence | null,
  providerTurnId: ProviderTurnId,
  at: DateTime.Utc,
): MessageDelivery => ({
  ...current,
  state: "adopted",
  adoption: current.adoption ?? "reported",
  evidence,
  providerTurnId,
  at,
});

// The next delivery, or `current` when the state diagram ignores `signal`. Only provider
// evidence adopts: a report, or the message's own turn running.
export function nextDelivery(current: MessageDelivery, signal: DeliverySignal): MessageDelivery {
  if (current.state === "adopted" || current.state === "dropped") return current;
  const ownTurnRunning = signal.type === "turnRunning" && current.route === "ownTurn";
  if (current.state === "unconfirmed") {
    if (signal.type === "report" && signal.state === "adopted") {
      return adopt(current, signal.evidence, signal.providerTurnId, signal.at);
    }
    return ownTurnRunning
      ? adopt(current, "turnStarted", signal.providerTurnId, signal.at)
      : current;
  }
  switch (signal.type) {
    case "delivered":
      return current.state === "accepted"
        ? {
            ...current,
            state: "delivered",
            adoption: signal.adoption,
            providerTurnId: signal.providerTurnId ?? current.providerTurnId,
            at: signal.at,
          }
        : current;
    case "report":
      return signal.state === "adopted"
        ? adopt(current, signal.evidence, signal.providerTurnId, signal.at)
        : { ...current, state: "dropped", reason: "providerCancelled", at: signal.at };
    case "turnRunning":
      return ownTurnRunning
        ? adopt(current, "turnStarted", signal.providerTurnId, signal.at)
        : current;
    case "turnEnded":
      return current.state === "delivered" && current.providerTurnId === signal.providerTurnId
        ? { ...current, state: "unconfirmed", at: signal.at }
        : current;
    case "cancelled":
      return current.state === "accepted"
        ? { ...current, state: "dropped", reason: "cancelled", at: signal.at }
        : current;
    case "failed": {
      const message = signal.message.trim().slice(0, MAX_MESSAGE_LENGTH);
      return {
        ...current,
        state: "dropped",
        reason: "failed",
        ...(message.length === 0 ? {} : { message }),
        at: signal.at,
      };
    }
    case "rerouted":
      return current.state === "accepted"
        ? { ...current, route: "ownTurn", rerouted: signal.reason, at: signal.at }
        : current;
  }
}

/** The delivery signal a provider event carries; assistant output and tool activity carry none. */
export function deliverySignalOf(
  event: ProviderAdapterV2Event,
  at: DateTime.Utc,
): DeliverySignal | null {
  switch (event.type) {
    case "message.delivery":
      return {
        type: "report",
        state: event.state,
        evidence: event.evidence,
        providerTurnId: event.providerTurnId,
        at,
      };
    case "provider_turn.updated":
      switch (event.providerTurn.status) {
        case "running":
          return { type: "turnRunning", providerTurnId: event.providerTurn.id, at };
        case "completed":
        case "interrupted":
        case "cancelled":
        case "failed":
          return { type: "turnEnded", providerTurnId: event.providerTurn.id, at };
        case "pending":
          return null;
      }
      return null;
    case "turn.terminal":
      return { type: "turnEnded", providerTurnId: event.providerTurnId, at };
    default:
      return null;
  }
}

type UserMessageItem = Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>;

export interface MessageDeliveryWriterShape {
  /** Applies `signal` to the delivery of `messageId`, if its item carries one. */
  readonly apply: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly signal: DeliverySignal;
  }) => Effect.Effect<void>;
  /** Applies `signal` to the delivery of the message that starts `runId`. */
  readonly applyToRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly signal: DeliverySignal;
  }) => Effect.Effect<void>;
  /** Records what a stored provider event says about deliveries on its thread. */
  readonly observe: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly event: ProviderAdapterV2Event;
  }) => Effect.Effect<void>;
  /** After a turn start returned: delivered, or dropped with the failure the run recorded. */
  readonly settleTurnStart: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void>;
}

/** Optional, like the readiness ledger: without it, deliveries stay as dispatch stored them. */
export class MessageDeliveryWriter extends Context.Service<
  MessageDeliveryWriter,
  MessageDeliveryWriterShape
>()("houston/houston/messageDelivery/MessageDeliveryWriter") {}

// Provider turns repeat `running` with each usage update; remember the ones already applied.
const SEEN_TURN_LIMIT = 4_096;

const remember = (seen: Set<string>, key: string): boolean => {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_TURN_LIMIT) {
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
};

export const layer: Layer.Layer<
  MessageDeliveryWriter,
  never,
  EventSink.EventSinkV2 | ProjectionStore.ProjectionStoreV2 | IdAllocator.IdAllocatorV2
> = Layer.effect(
  MessageDeliveryWriter,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    // Read, decide and write one delivery at a time: the worker and the ingestor both write.
    const permit = yield* Semaphore.make(1);
    const seen = new Set<string>();

    const writeItem = Effect.fn("MessageDeliveryWriter.writeItem")(function* (
      item: UserMessageItem,
      delivery: MessageDelivery,
    ) {
      const occurredAt = delivery.at;
      yield* eventSink.write({
        events: [
          {
            id: yield* idAllocator.allocate.event({ threadId: item.threadId }),
            type: "turn-item.updated",
            threadId: item.threadId,
            ...(item.runId === null ? {} : { runId: item.runId }),
            ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
            occurredAt,
            payload: { ...item, delivery, updatedAt: occurredAt },
          },
        ],
      });
    });

    const applyToItem = Effect.fn("MessageDeliveryWriter.applyToItem")(function* (
      item: UserMessageItem,
      signal: DeliverySignal,
    ) {
      const current = item.delivery;
      if (current === undefined) return;
      // A running own turn proves the start reached the provider: record both steps.
      if (
        signal.type === "turnRunning" &&
        current.state === "accepted" &&
        current.route === "ownTurn"
      ) {
        const delivered = nextDelivery(current, {
          type: "delivered",
          providerTurnId: signal.providerTurnId,
          adoption: "reported",
          at: signal.at,
        });
        yield* writeItem(item, delivered);
        yield* writeItem(item, nextDelivery(delivered, signal));
        return;
      }
      const next = nextDelivery(current, signal);
      if (next === current) return;
      yield* writeItem(item, next);
      // The turn may have ended while the steer was in flight; its end was observed before the
      // steer carried a provider turn, so apply it now.
      if (next.state === "delivered" && next.providerTurnId !== null) {
        const providerTurnId = next.providerTurnId;
        const records = yield* projections.getThreadRecords(item.threadId, ["providerTurns"]);
        const turn = records.providerTurns.find((candidate) => candidate.id === providerTurnId);
        if (turn !== undefined && ENDED_TURN_STATUSES.has(turn.status)) {
          yield* writeItem(
            item,
            nextDelivery(next, { type: "turnEnded", providerTurnId, at: next.at }),
          );
        }
      }
    });

    const readItem = (threadId: ThreadId, messageId: MessageId) =>
      projections
        .getTurnItem({ threadId, itemId: idAllocator.derive.userTurnItem({ messageId }) })
        .pipe(Effect.map((item) => (item?.type === "user_message" ? item : null)));

    const guarded = <E>(label: string, effect: Effect.Effect<void, E>) =>
      permit
        .withPermits(1)(effect)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(`houston.message-delivery.${label}-failed`, { cause }),
          ),
        );

    const apply: MessageDeliveryWriterShape["apply"] = (input) =>
      guarded(
        "apply",
        Effect.gen(function* () {
          const item = yield* readItem(input.threadId, input.messageId);
          if (item !== null) yield* applyToItem(item, input.signal);
        }),
      );

    const runMessageId = (threadId: ThreadId, runId: RunId) =>
      projections
        .getThreadRecords(threadId, ["runs"], { runIds: [runId] })
        .pipe(Effect.map((records) => records.runs.find((run) => run.id === runId)));

    const applyToRun: MessageDeliveryWriterShape["applyToRun"] = (input) =>
      guarded(
        "apply-to-run",
        Effect.gen(function* () {
          const run = yield* runMessageId(input.threadId, input.runId);
          if (run === undefined) return;
          const item = yield* readItem(input.threadId, run.userMessageId);
          if (item !== null) yield* applyToItem(item, input.signal);
        }),
      );

    const observe: MessageDeliveryWriterShape["observe"] = Effect.fn(
      "MessageDeliveryWriter.observe",
    )(function* (input) {
      const signal = deliverySignalOf(input.event, yield* DateTime.now);
      if (signal === null) return;
      const threadId =
        input.event.type === "message.delivery" || input.event.type === "provider_turn.updated"
          ? (input.event.threadId ?? input.threadId)
          : input.threadId;
      if (signal.type === "report" && input.event.type === "message.delivery") {
        return yield* apply({ threadId, messageId: input.event.messageId, signal });
      }
      if (signal.type !== "turnRunning" && signal.type !== "turnEnded") return;
      if (!remember(seen, `${signal.type}:${signal.providerTurnId}`)) return;
      const runAttemptId =
        input.event.type === "provider_turn.updated" ? input.event.providerTurn.runAttemptId : null;
      yield* guarded(
        "observe",
        Effect.gen(function* () {
          const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
            turnItemTypes: ["user_message"],
          });
          for (const item of records.turnItems) {
            if (item.type !== "user_message" || item.delivery === undefined) continue;
            const delivery = item.delivery;
            if (delivery.state === "adopted" || delivery.state === "dropped") continue;
            if (signal.type === "turnEnded") {
              if (delivery.providerTurnId === signal.providerTurnId) {
                yield* applyToItem(item, signal);
              }
              continue;
            }
            // A turn running is evidence only for the message that started it.
            const run = records.runs.find((candidate) => candidate.id === item.runId);
            if (
              delivery.route === "ownTurn" &&
              run !== undefined &&
              runAttemptId !== null &&
              run.activeAttemptId === runAttemptId &&
              run.userMessageId === item.messageId
            ) {
              yield* applyToItem(item, signal);
            }
          }
        }),
      );
    });

    const settleTurnStart: MessageDeliveryWriterShape["settleTurnStart"] = (input) =>
      guarded(
        "settle-turn-start",
        Effect.gen(function* () {
          const records = yield* projections.getThreadRecords(
            input.threadId,
            ["runs", "turnItems"],
            { runIds: [input.runId], turnItemRunId: input.runId, turnItemTypes: ["error"] },
          );
          const run = records.runs.find((candidate) => candidate.id === input.runId);
          if (run === undefined) return;
          const item = yield* readItem(input.threadId, run.userMessageId);
          if (item === null || item.delivery?.route !== "ownTurn") return;
          const at = yield* DateTime.now;
          if (run.status === "failed") {
            const failure = records.turnItems.findLast((candidate) => candidate.type === "error");
            return yield* applyToItem(item, {
              type: "failed",
              message:
                failure?.type === "error" ? failure.failure.message : "The turn failed to start.",
              at,
            });
          }
          if (
            run.status === "starting" ||
            run.status === "running" ||
            run.status === "waiting" ||
            run.status === "completed"
          ) {
            yield* applyToItem(item, {
              type: "delivered",
              providerTurnId: null,
              adoption: "reported",
              at,
            });
          }
        }),
      );

    return MessageDeliveryWriter.of({ apply, applyToRun, observe, settleTurnStart });
  }),
);
