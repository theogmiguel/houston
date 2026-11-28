import { RunId, ThreadId, type OrchestrationV2ServerCommand } from "@houston-app/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

const nowMs = Date.parse("2026-10-19T12:00:00.000Z");
const threadId = ThreadId.make("thread:reset-release");
const runId = RunId.make("run:reset-release");

it.effect("releases a due held start with only the account-wide hold setting on", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const commands: OrchestrationV2ServerCommand[] = [];
    const sweeps = new Map<string, Effect.Effect<void>>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(Scheduler.Scheduler, {
            register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
              Effect.gen(function* () {
                const context = yield* Effect.context<R>();
                sweeps.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () => Effect.succeed([]),
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getHeldQueuedRuns: () =>
              Effect.succeed([
                {
                  id: runId,
                  threadId,
                  status: "queued",
                  queueHeld: true,
                  queueHeldReason: {
                    kind: "usage_limit",
                    message: "held",
                    providerInstanceId: "codex",
                    releaseAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 1_000)),
                  },
                  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
                },
              ]) as never,
            getThreadShell: () =>
              Effect.succeed({
                lastErrorClass: "usage_limit",
                limitRecovery: { autoResume: false },
                usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 1_000)),
              } as never),
            getLimitRecoveryWakeAt: () => Effect.succeed(null),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command: OrchestrationV2ServerCommand) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: commands.length, storedEvents: [] };
              }) as never,
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: false,
              snoozeLimitedThreads: false,
              holdUnlimitedThreads: true,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      yield* sweeps.get("usage-limit-recovery")!;
      assert.lengthOf(commands, 1);
      assert.equal(commands[0]?.type, "queued-run.release");
      assert.equal((commands[0] as { runId: RunId }).runId, runId);
      // A second sweep is a new command, not a replay of the first receipt.
      yield* TestClock.adjust("1 millis");
      yield* sweeps.get("usage-limit-recovery")!;
      assert.lengthOf(commands, 2);
      assert.notEqual(commands[0]?.commandId, commands[1]?.commandId);
    }).pipe(Effect.provide(layer));
  }),
);
