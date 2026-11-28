import { CommandId } from "@houston-app/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

/**
 * A held deferred start records its workspace strategy while it waits. When a release moves
 * that run from the queue to preparation, the release command has no caller left to prepare
 * it, so start the preparation here through the same path a non-held deferred start uses.
 */
const makeWorker = Effect.gen(function* () {
  const launches = yield* ThreadLaunchService.ThreadLaunchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  yield* forkParked(
    Stream.runForEach(threads.streamDomainEvents, (event) =>
      event.type === "run.updated" && event.payload.status === "preparing"
        ? launches.prepareRun({
            commandId: CommandId.make(`workspace-preparation:${event.payload.id}`),
            threadId: event.threadId,
            runId: event.payload.id,
          })
        : Effect.void,
    ),
  );
});

export const layer = Layer.effectDiscard(makeWorker);
