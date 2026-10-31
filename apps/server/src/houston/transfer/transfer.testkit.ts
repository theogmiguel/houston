// @effect-diagnostics nodeBuiltinImport:off - builds temporary git repositories and reads files back.
// Workspace transfer over one database, real git and the real project service. A test that needs two
// computers builds this layer twice, each with its own database and base dir.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RunStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { HostedLaunch } from "../baseDir.ts";
import { git } from "../mergeQueue/mergeQueue.testkit.ts";
import * as HoustonKeychain from "../secrets/HoustonKeychain.ts";
import * as HoustonTaskStore from "../tasks/TaskStore.ts";
import {
  CONFIGURED_INSTANCES,
  layerInstances,
  layerProjectMetadata,
  layerWorkspacePaths,
} from "../tasks/tasks.testkit.ts";
import type { FormatLimits } from "./format.ts";
import * as HoustonTransferService from "./Service.ts";

export { createProject } from "../mergeQueue/mergeQueue.testkit.ts";
export { git, makeRepos, addManagedWorktree } from "../mergeQueue/mergeQueue.testkit.ts";

export const PASSPHRASE = "transfer test passphrase 31";

export interface TransferTestOptions {
  /** A database file that outlives the layer; in memory when absent. */
  readonly databaseFile?: string;
  /** The server base dir; a fresh temporary directory when absent. */
  readonly baseDir?: string;
  readonly keychain?: HoustonKeychain.MemoryKeychain;
  /** Format bounds smaller than the contract's, so a test reaches them with small files. */
  readonly limits?: Partial<FormatLimits>;
  /** The scrypt work factor of written files; the contract's 18 when absent. */
  readonly workFactor?: number;
}

/** The transfer service as the server assembles it, over a fresh database and base dir. */
export const layerTransferTest = (options: TransferTestOptions = {}) =>
  HoustonTransferService.layer({
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    ...(options.workFactor === undefined ? {} : { workFactor: options.workFactor }),
  }).pipe(
    Layer.provideMerge(RuntimeLayer.layerProjectService),
    Layer.provideMerge(Layer.merge(RuntimeLayer.layerEventSink, ProjectionStore.layer)),
    Layer.provideMerge(ProjectStore.layer),
    Layer.provideMerge(HoustonTaskStore.layer),
    Layer.provideMerge(HoustonKeychain.layerMemory(options.keychain ?? HoustonKeychain.makeMemory())),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(layerInstances(CONFIGURED_INSTANCES)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(layerWorkspacePaths),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(
      options.databaseFile === undefined
        ? Layer.fresh(SqlitePersistence.layerMemory)
        : Layer.fresh(SqlitePersistence.layerFromPath(options.databaseFile)),
    ),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), options.baseDir ?? { prefix: "houston-transfer-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Layer.succeed(HostedLaunch, false)),
  );

export const write = (root: string, relative: string, contents: string | Uint8Array) => {
  const path = NodePath.join(root, ...relative.split("/"));
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, contents);
  return path;
};

/** Commits every change in `checkout`. */
export const commitAll = (checkout: string, message: string) => {
  git(checkout, ["add", "-A"]);
  git(checkout, ["commit", "--quiet", "-m", message]);
};

// Threads, written as the orchestrator writes them: events through the event sink.

let events = 0;
const nextEventId = (label: string) => {
  events += 1;
  return EventId.make(`event:transfer-test:${label}:${events}`);
};

export interface SeedThreadInput {
  readonly threadId: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly worktreePath?: string | null;
  readonly branch?: string | null;
  readonly instanceId?: string;
  readonly archived?: boolean;
  readonly deleted?: boolean;
  readonly parentThreadId?: string | null;
  /** Alternating user and assistant messages, in order. */
  readonly messages?: ReadonlyArray<string>;
}

export const seedThread = Effect.fn("HoustonTransferTest.seedThread")(function* (
  input: SeedThreadInput,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(input.threadId);
  const instanceId = ProviderInstanceId.make(input.instanceId ?? "codex");
  const parent = input.parentThreadId ?? null;
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: input.projectId,
    title: input.title,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    activeProviderThreadId: null,
    lineage:
      parent === null
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
        : {
            parentThreadId: ThreadId.make(parent),
            relationshipToParent: "side",
            rootThreadId: ThreadId.make(parent),
          },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: input.archived === true ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: input.deleted === true ? now : null,
  } as OrchestrationV2AppThread;
  const written: Array<OrchestrationV2DomainEvent> = [
    {
      id: nextEventId("thread"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread,
    },
  ];
  (input.messages ?? []).forEach((text, index) => {
    const role = index % 2 === 0 ? "user" : "assistant";
    const messageId = MessageId.make(`${input.threadId}:message:${index}`);
    const common = {
      id: TurnItemId.make(`${input.threadId}:item:${index}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    written.push(
      {
        id: nextEventId("message"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: role === "user" ? "user" : "agent",
          creationSource: "server",
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role,
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: nextEventId("item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload:
          role === "user"
            ? {
                ...common,
                createdBy: "user",
                creationSource: "server",
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text,
                attachments: [],
              }
            : { ...common, type: "assistant_message", messageId, text, streaming: false },
      } as OrchestrationV2DomainEvent,
    );
  });
  yield* eventSink.write({ events: written });
  return threadId;
});

/** A run of `threadId` in `status`, with its attempt, as the orchestrator records one. */
export const seedRun = Effect.fn("HoustonTransferTest.seedRun")(function* (
  threadId: ThreadId,
  status: OrchestrationV2RunStatus,
  options: { readonly attemptStatus?: string; readonly pendingRequest?: boolean } = {},
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  events += 1;
  const suffix = `${threadId}:${events}`;
  const runId = RunId.make(`run:${suffix}`);
  const attemptId = RunAttemptId.make(`attempt:${suffix}`);
  const nodeId = NodeId.make(`node:${suffix}`);
  const instanceId = ProviderInstanceId.make("codex");
  const finished = !["preparing", "queued", "starting", "running", "waiting"].includes(status);
  const written: Array<OrchestrationV2DomainEvent> = [
    {
      id: nextEventId("run"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: events,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "default" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:${suffix}`),
        rootNodeId: nodeId,
        activeAttemptId: attemptId,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: finished ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    } as OrchestrationV2DomainEvent,
    {
      id: nextEventId("attempt"),
      type: "run-attempt.created",
      threadId,
      occurredAt: now,
      payload: {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId: nodeId,
        providerInstanceId: instanceId,
        providerThreadId: null,
        providerTurnId: null,
        reason: "initial",
        status: options.attemptStatus ?? (finished ? status : "running"),
        startedAt: now,
        completedAt: finished ? now : null,
      },
    } as OrchestrationV2DomainEvent,
  ];
  if (options.pendingRequest === true) {
    written.push({
      id: nextEventId("request"),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(`request:${suffix}`),
        nodeId,
        providerTurnId: ProviderTurnId.make(`turn:${suffix}`),
        nativeRequestRef: null,
        kind: "command",
        status: "pending",
        responseCapability: { type: "none" },
        createdAt: now,
        resolvedAt: null,
      },
    } as OrchestrationV2DomainEvent);
  }
  yield* eventSink.write({ events: written });
  return runId;
});
