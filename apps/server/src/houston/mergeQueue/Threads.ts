// The project threads the queue may tell about an entry, the one queued note per failure
// (AD-061), and the user's Hand to a new thread, the only launch the queue makes.
import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import type { OwnerCandidate } from "./rules.ts";

export interface QueueThread extends OwnerCandidate {
  readonly projectId: string;
}

export interface LaunchRequest {
  readonly projectId: ProjectId;
  readonly threadId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly branch: string;
  /** The head branch's worktree; a new one on the branch when there is none. */
  readonly worktreePath: string | null;
  readonly messageId: string;
  readonly text: string;
}

export class HoustonMergeQueueThreads extends Context.Service<
  HoustonMergeQueueThreads,
  {
    readonly list: (projectId: ProjectId) => Effect.Effect<ReadonlyArray<QueueThread>>;
    /** One queued user message; the same `messageId` again is a replay that adds nothing. */
    readonly notify: (note: {
      readonly threadId: string;
      readonly messageId: string;
      readonly text: string;
    }) => Effect.Effect<void, string>;
    readonly launch: (request: LaunchRequest) => Effect.Effect<void, string>;
  }
>()("houston/houston/mergeQueue/Threads/HoustonMergeQueueThreads") {}

const errorText = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { readonly message: unknown }).message)
    : String(error);

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const management = yield* ThreadManagement.ThreadManagementService;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;

  const list: HoustonMergeQueueThreads["Service"]["list"] = (projectId) =>
    management.listProjectThreads({ projectId, includeSubagents: false }).pipe(
      Effect.map((shells) =>
        shells.map((shell): QueueThread => ({
          id: shell.id,
          projectId: shell.projectId,
          branch: shell.branch,
          worktreePath: shell.worktreePath,
          archived: shell.archivedAt !== null,
        })),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Merge queue: listing the project's threads failed.", cause).pipe(
          Effect.as([]),
        ),
      ),
    );

  const notify: HoustonMergeQueueThreads["Service"]["notify"] = (note) =>
    orchestrator
      .dispatch({
        type: "houston.merge-queue.notify",
        // One command per note: a second send replays the receipt and adds nothing.
        commandId: CommandId.make(`houston-merge-queue:${note.messageId}`),
        threadId: ThreadId.make(note.threadId),
        messageId: MessageId.make(note.messageId),
        text: note.text,
      })
      .pipe(Effect.asVoid, Effect.mapError(errorText));

  const launch: HoustonMergeQueueThreads["Service"]["launch"] = (request) =>
    launcher
      .launch({
        commandId: CommandId.make(`houston-merge-queue:launch:${request.threadId}`),
        threadId: ThreadId.make(request.threadId),
        projectId: request.projectId,
        title: request.title,
        modelSelection: request.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy:
          request.worktreePath === null
            ? { type: "worktree", baseRef: request.branch, branch: request.branch }
            : {
                type: "existing_worktree",
                worktreePath: request.worktreePath,
                branch: request.branch,
              },
        initialMessage: {
          messageId: MessageId.make(request.messageId),
          text: request.text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.asVoid, Effect.mapError(errorText));

  return HoustonMergeQueueThreads.of({ list, notify, launch });
});

export const layer = Layer.effect(HoustonMergeQueueThreads, make);
