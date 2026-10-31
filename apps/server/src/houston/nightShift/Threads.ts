// What Night shift does to threads: launch the orchestrator, stop crew members the way task_cancel
// stops a delegated child, stop the orchestrator, queue Houston's messages, and read a thread's runs.
import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

export interface ThreadState {
  /** False when the thread does not exist or was deleted. */
  readonly present: boolean;
  readonly activeRun: boolean;
  readonly lastRunStatus: string | null;
}

export interface Launched {
  readonly threadId: ThreadId;
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

export class NightShiftThreads extends Context.Service<
  NightShiftThreads,
  {
    readonly launch: (
      input: ThreadLaunchService.ThreadLaunchInput,
    ) => Effect.Effect<Launched, string>;
    /** Stops a crew member and every task under it, as task_cancel stops a delegated child. */
    readonly cancelCrew: (threadId: ThreadId, commandId: CommandId) => Effect.Effect<void, string>;
    /** Stops the orchestrator's active run and its delegated tasks. */
    readonly stop: (threadId: ThreadId, commandId: CommandId) => Effect.Effect<void, string>;
    /** Appends one queued message; a repeated `messageId` appends nothing. */
    readonly notify: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly text: string;
    }) => Effect.Effect<void, string>;
    readonly state: (threadId: ThreadId) => Effect.Effect<ThreadState>;
  }
>()("houston/houston/nightShift/Threads/NightShiftThreads") {}

const STOP_REASON = "Night shift stopped the run";

const text = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);

export const layer = Layer.effect(
  NightShiftThreads,
  Effect.gen(function* () {
    const launcher = yield* ThreadLaunchService.ThreadLaunchService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    return NightShiftThreads.of({
      launch: Effect.fn("NightShiftThreads.launch")((input) =>
        launcher.launch(input).pipe(
          Effect.map((launched) => ({
            threadId: launched.threadId,
            worktreePath: launched.projection.thread.worktreePath,
            branch: launched.projection.thread.branch,
          })),
          Effect.mapError(text),
        ),
      ),
      cancelCrew: Effect.fn("NightShiftThreads.cancelCrew")(
        function* (threadId, commandId) {
          yield* threads.dispatch({
            type: "thread.stop",
            commandId,
            threadId,
            stopDelegatedTasks: false,
            reason: STOP_REASON,
          });
          yield* threads.stopDelegatedTasks({ threadId, commandId, reason: STOP_REASON });
        },
        Effect.mapError(text),
      ),
      stop: Effect.fn("NightShiftThreads.stop")((threadId, commandId) =>
        threads
          .dispatch({ type: "thread.stop", commandId, threadId, reason: STOP_REASON })
          .pipe(Effect.asVoid, Effect.mapError(text)),
      ),
      notify: Effect.fn("NightShiftThreads.notify")((input) =>
        threads
          .dispatch({
            type: "houston.night-shift.notify",
            commandId: CommandId.make(`night-shift-notify:${input.messageId}`),
            threadId: input.threadId,
            messageId: input.messageId,
            text: input.text,
          })
          .pipe(Effect.asVoid, Effect.mapError(text)),
      ),
      state: Effect.fn("NightShiftThreads.state")(
        function* (threadId) {
          const shell = yield* threads.getThreadShell(threadId);
          if (shell === null || shell.deletedAt !== null) {
            return { present: false, activeRun: false, lastRunStatus: null };
          }
          const records = yield* threads.getThreadRecords(threadId, ["runs"]);
          const last = records.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
          return {
            present: true,
            activeRun: ThreadManagementService.latestActiveRun(records) !== undefined,
            lastRunStatus: last?.status ?? null,
          };
        },
        // A failed read is not an ended thread: read as busy, so nothing settles on it.
        Effect.orElseSucceed(() => ({ present: true, activeRun: true, lastRunStatus: null })),
      ),
    });
  }),
);

export const messageId = (runId: number, kind: string, key = "") =>
  MessageId.make(`message:night-shift:${runId}:${kind}:${key}`);
