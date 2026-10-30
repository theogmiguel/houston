// What the server records for queue, steer and interrupt, driven through the orchestrator and
// its effect worker with the in-test provider double in messageDelivery.testkit.ts.
import { assert, describe, it } from "@effect/vitest";
import { CommandId, MessageId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { TestClock } from "effect/testing";

import { latest, makeHarness, runWith } from "./messageDelivery.testkit.ts";

describe("send intents at dispatch", () => {
  it.effect("each intent is recorded as accepted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const rows = [
          ["queue_after_active", { intent: "queue", route: "ownTurn" }],
          ["steer_active", { intent: "steer", route: "activeTurn" }],
          ["restart_active", { intent: "interrupt", route: "ownTurn" }],
        ] as const;
        for (const [mode, expected] of rows) {
          const harness = yield* makeHarness(`accepted-${mode}`);
          yield* runWith(harness, ({ send, startFirst, deliveries }) =>
            Effect.gen(function* () {
              const runId = yield* startFirst;
              const messageId = MessageId.make(`message:${mode}`);
              yield* send(
                messageId,
                `sent with ${mode}`,
                mode === "queue_after_active" ? { type: mode } : { type: mode, targetRunId: runId },
              );
              const first = deliveries(messageId)[0];
              assert.deepInclude(first, {
                ...expected,
                state: "accepted",
                adoption: null,
                evidence: null,
              });
              assert.isUndefined(first?.rerouted);
              assert.isUndefined(first?.promotedFrom);
            }),
          );
        }

        // The same intents asked through deliveryIntent, and a /goal (which never joins a running
        // turn): one that stops the run interrupts it, one that stops nothing waits in the queue.
        const intentRows = [
          ["restart", "plain", "restart now", { intent: "interrupt", route: "ownTurn" }],
          ["steer", "plain", "steer now", { intent: "steer", route: "activeTurn" }],
          ["restart", "goal-set", "/goal ship it", { intent: "interrupt", route: "ownTurn" }],
          ["restart", "goal-show", "/goal", { intent: "queue", route: "ownTurn" }],
          [
            "steer",
            "goal-set",
            "/goal ship it",
            { intent: "steer", route: "ownTurn", rerouted: "turnBusy" },
          ],
        ] as const;
        for (const [deliveryIntent, name, text, expected] of intentRows) {
          const harness = yield* makeHarness(`accepted-${deliveryIntent}-${name}`);
          yield* runWith(harness, ({ send, startFirst, deliveries }) =>
            Effect.gen(function* () {
              yield* startFirst;
              const messageId = MessageId.make(`message:${deliveryIntent}-${name}`);
              yield* send(messageId, text, { type: "start_immediately" }, deliveryIntent);
              const first = deliveries(messageId)[0];
              assert.deepInclude(
                first,
                { ...expected, state: "accepted", adoption: null, evidence: null },
                `${deliveryIntent}/${name}`,
              );
              if (!("rerouted" in expected)) {
                assert.isUndefined(first?.rerouted, `${deliveryIntent}/${name}`);
              }
            }),
          );
        }
      }),
    ),
  );

  it.effect("an automatic intent records the mode it resolved to", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("auto");
        yield* runWith(harness, ({ send, deliveries, orchestrator, threadId }) =>
          Effect.gen(function* () {
            // The first run is still starting: no provider turn runs, so "auto" queues.
            yield* send("message:first", "first", { type: "start_immediately" });
            const messageId = MessageId.make("message:auto");
            yield* send(messageId, "automatic", { type: "start_immediately" }, "auto");
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(projection.runs.filter((run) => run.status === "queued").length, 1);
            assert.deepInclude(deliveries(messageId)[0], {
              intent: "queue",
              route: "ownTurn",
              state: "accepted",
            });
          }),
        );
      }),
    ),
  );

  it.effect("a message with no active run carries no delivery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("no-active-run");
        yield* runWith(harness, ({ startFirst, orchestrator, threadId, settle }) =>
          Effect.gen(function* () {
            yield* startFirst;
            yield* settle;
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const item = projection.turnItems.find(
              (candidate) =>
                candidate.type === "user_message" && candidate.messageId === "message:first",
            );
            assert.equal(item?.type, "user_message");
            assert.isFalse(item !== undefined && "delivery" in item);
          }),
        );
      }),
    ),
  );

  it.effect("a promoted queued message becomes an accepted steer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("promote");
        yield* runWith(harness, ({ send, startFirst, deliveries, orchestrator, threadId }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const messageId = MessageId.make("message:promoted");
            yield* send(messageId, "promote me", { type: "queue_after_active" });
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.status === "queued",
            )!;
            yield* orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("promote"),
              threadId,
              queuedRunId: queued.id,
              targetRunId: runId,
            });
            assert.deepInclude(latest(deliveries(messageId)), {
              intent: "steer",
              route: "activeTurn",
              promotedFrom: "queue",
              state: "accepted",
            });
          }),
        );
      }),
    ),
  );

  it.effect("editing a queued message keeps it accepted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("edit");
        yield* runWith(harness, ({ send, startFirst, deliveries, orchestrator, threadId }) =>
          Effect.gen(function* () {
            yield* startFirst;
            const messageId = MessageId.make("message:edited");
            yield* send(messageId, "before edit", { type: "queue_after_active" });
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.status === "queued",
            )!;
            yield* orchestrator.dispatch({
              type: "queued-run.edit",
              commandId: CommandId.make("edit"),
              threadId,
              runId: queued.id,
              text: "after edit",
            });
            const after = deliveries(messageId);
            assert.isAbove(after.length, 1, "the edit rewrites the item");
            assert.deepInclude(latest(after), { intent: "queue", state: "accepted" });
          }),
        );
      }),
    ),
  );

  it.effect("a steer whose turn ended first becomes its own turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("turn-ended");
        yield* runWith(harness, ({ send, startFirst, deliveries, settle, runningTurn, worker }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const turn = yield* runningTurn;
            const messageId = MessageId.make("message:late-steer");
            yield* send(messageId, "too late", { type: "steer_active", targetRunId: runId });
            // The turn completes before the worker delivers the steer.
            yield* harness.endTurn(turn, "completed");
            for (let round = 0; round < 20; round += 1) {
              yield* Effect.yieldNow;
              yield* TestClock.adjust("1 millis");
            }
            yield* worker.drain();
            yield* settle;
            assert.lengthOf(harness.steered, 0, "the steer never reached the ended turn");
            const history = deliveries(messageId);
            assert.isTrue(
              history.some(
                (delivery) =>
                  delivery.state === "accepted" &&
                  delivery.route === "ownTurn" &&
                  delivery.rerouted === "turnEnded",
              ),
              JSON.stringify(history),
            );
            assert.deepInclude(latest(history), {
              intent: "steer",
              route: "ownTurn",
              rerouted: "turnEnded",
              state: "adopted",
              evidence: "turnStarted",
            });
            assert.equal(harness.started.at(-1)?.message.messageId, messageId);
          }),
        );
      }),
    ),
  );

  it.effect("a steer to a compacting turn becomes its own turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("compacting");
        yield* runWith(
          harness,
          ({ send, startFirst, deliveries, settle, runningTurn, orchestrator, threadId }) =>
            Effect.gen(function* () {
              yield* startFirst;
              yield* harness.endTurn(yield* runningTurn, "completed");
              yield* settle;
              // The run whose message is /compact is the steer's target, whatever its provider does.
              yield* send("message:compact", "/compact", { type: "start_immediately" });
              const runId = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!.id;
              const messageId = MessageId.make("message:steer-while-compacting");
              yield* send(messageId, "after compaction", {
                type: "steer_active",
                targetRunId: runId,
              });
              assert.deepInclude(deliveries(messageId)[0], {
                intent: "steer",
                route: "ownTurn",
                rerouted: "turnBusy",
                state: "accepted",
              });
            }),
        );
      }),
    ),
  );

  it.effect("a delivered steer carries the adapter's receipt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("receipt", { steerReturns: "reported" });
        yield* runWith(harness, ({ send, startFirst, deliveries, settle, runningTurn }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const turn = yield* runningTurn;
            const messageId = MessageId.make("message:receipt");
            yield* send(messageId, "steer", { type: "steer_active", targetRunId: runId });
            yield* settle;
            assert.lengthOf(harness.steered, 1);
            assert.deepInclude(latest(deliveries(messageId)), {
              state: "delivered",
              adoption: "reported",
              providerTurnId: turn.id,
            });
          }),
        );
      }),
    ),
  );

  it.effect("an adapter that returns nothing is notReported", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("void", { steerReturns: "void" });
        yield* runWith(harness, ({ send, startFirst, deliveries, settle, runningTurn }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const turn = yield* runningTurn;
            const messageId = MessageId.make("message:void");
            yield* send(messageId, "steer", { type: "steer_active", targetRunId: runId });
            yield* settle;
            assert.deepInclude(latest(deliveries(messageId)), {
              state: "delivered",
              adoption: "notReported",
              providerTurnId: turn.id,
            });
          }),
        );
      }),
    ),
  );

  it.effect("a steer whose turn ends while it is delivered is unconfirmed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("ends-during-steer", { steerEndsTurn: true });
        yield* runWith(harness, ({ send, startFirst, deliveries, settle, runningTurn }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const turn = yield* runningTurn;
            const messageId = MessageId.make("message:ends-during-steer");
            yield* send(messageId, "steer", { type: "steer_active", targetRunId: runId });
            yield* settle;
            assert.lengthOf(harness.steered, 1);
            assert.equal(harness.turns.get(turn.id)?.status, "completed");
            const history = deliveries(messageId);
            assert.isTrue(
              history.some((delivery) => delivery.state === "delivered"),
              JSON.stringify(history),
            );
            assert.deepInclude(latest(history), {
              state: "unconfirmed",
              adoption: "reported",
              providerTurnId: turn.id,
            });
          }),
        );
      }),
    ),
  );

  it.effect("a cancelled queued message is dropped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness("cancel");
        yield* runWith(harness, ({ send, startFirst, deliveries, orchestrator, threadId }) =>
          Effect.gen(function* () {
            yield* startFirst;
            const messageId = MessageId.make("message:cancelled");
            yield* send(messageId, "never mind", { type: "queue_after_active" });
            const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
              (run) => run.status === "queued",
            )!;
            yield* orchestrator.dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make("cancel"),
              threadId,
              runId: queued.id,
            });
            assert.deepInclude(latest(deliveries(messageId)), {
              intent: "queue",
              state: "dropped",
              reason: "cancelled",
            });
          }),
        );
      }),
    ),
  );

  it.effect("a message whose effect fails is dropped with the error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const steerError = "Codex refused the steer: the thread is read-only";
        const steerHarness = yield* makeHarness("steer-fails", { steerFails: steerError });
        yield* runWith(steerHarness, ({ send, startFirst, deliveries, settle }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const messageId = MessageId.make("message:steer-fails");
            yield* send(messageId, "steer", { type: "steer_active", targetRunId: runId });
            yield* settle;
            assert.isAbove(steerHarness.steered.length, 1, "the worker retried the steer");
            assert.deepInclude(latest(deliveries(messageId)), {
              state: "dropped",
              reason: "failed",
              message: steerError,
            });
          }),
        );

        // Only a terminal failure drops: a steer that fails once and is retried is delivered.
        const retriedHarness = yield* makeHarness("steer-fails-once", {
          steerFails: "Codex is busy",
          steerFailures: 1,
        });
        yield* runWith(retriedHarness, ({ send, startFirst, deliveries, settle }) =>
          Effect.gen(function* () {
            const runId = yield* startFirst;
            const messageId = MessageId.make("message:steer-fails-once");
            yield* send(messageId, "steer", { type: "steer_active", targetRunId: runId });
            yield* settle;
            assert.lengthOf(retriedHarness.steered, 2, "the worker retried the steer once");
            const history = deliveries(messageId);
            assert.isFalse(
              history.some((delivery) => delivery.state === "dropped"),
              JSON.stringify(history),
            );
            assert.deepInclude(latest(history), { state: "delivered", adoption: "reported" });
          }),
        );

        const queuedId = MessageId.make("message:start-fails");
        const startError = "Codex refused to start the turn";
        const startHarness = yield* makeHarness("start-fails", {
          startFails: { messageId: queuedId, detail: startError },
        });
        yield* runWith(
          startHarness,
          ({ send, startFirst, deliveries, settle, runningTurn, orchestrator, threadId }) =>
            Effect.gen(function* () {
              yield* startFirst;
              const turn = yield* runningTurn;
              yield* send(queuedId, "queued", { type: "queue_after_active" });
              yield* startHarness.endTurn(turn, "completed");
              yield* settle;
              const projection = yield* orchestrator.getThreadProjection(threadId);
              const failure = projection.turnItems.find(
                (item) => item.type === "error" && item.runId !== projection.runs[0]!.id,
              );
              assert.equal(failure?.type, "error");
              // The failure as the timeline shows it is the error's user-facing text.
              const shown = failure?.type === "error" ? failure.failure.message : undefined;
              assert.isDefined(shown);
              assert.deepInclude(latest(deliveries(queuedId)), {
                intent: "queue",
                state: "dropped",
                reason: "failed",
                ...(shown === undefined ? {} : { message: shown }),
              });
            }),
        );
      }),
    ),
  );
});
