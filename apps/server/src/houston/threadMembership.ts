// Gives every chat thread its workspace when it is created and forgets it when the thread is
// deleted. A thread that already has a workspace (the window recorded one before creating it)
// keeps it; a side thread has none and follows its source.
import type { OrchestrationV2DomainEvent } from "@houston-app/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { HoustonLayoutWorkspaceService } from "./layoutWorkspaces.ts";

export class HoustonThreadMembership extends Context.Service<
  HoustonThreadMembership,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("@houston-app/cli/houston/threadMembership/HoustonThreadMembership") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const workspaces = yield* HoustonLayoutWorkspaceService;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const handle: HoustonThreadMembership["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "thread.created" && event.type !== "thread.deleted") return;
      const environmentId = yield* environment.getEnvironmentId;
      if (event.type === "thread.deleted") {
        yield* workspaces.removeThread({ environmentId, threadId: event.threadId });
        return;
      }
      const thread = event.payload;
      if (thread.lineage.sideChat === true || thread.side !== undefined) return;
      const parentThreadId =
        thread.lineage.parentThreadId ??
        (thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null);
      yield* workspaces.assignCreated({
        environmentId,
        threadId: thread.id,
        parentThreadId,
        follows: thread.lineage.relationshipToParent === "subagent",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("recording a thread's workspace failed", {
            threadId: event.threadId,
            eventType: event.type,
            cause,
          }),
        ),
      ),
  );

  const start: HoustonThreadMembership["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        const environmentId = yield* environment.getEnvironmentId;
        const result = yield* workspaces.reconcileThreads(environmentId);
        if (result.assigned > 0 || result.removed > 0) {
          yield* Effect.logInfo("Thread workspaces reconciled", result);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("reconciling thread workspaces failed", { cause }),
        ),
        Effect.andThen(Stream.runForEach(engine.streamDomainEvents, handle)),
        Effect.catchCause((cause) =>
          Effect.logWarning("thread workspace event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies HoustonThreadMembership["Service"];
});

export const layer = Layer.effect(HoustonThreadMembership, make);
