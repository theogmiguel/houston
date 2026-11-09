// An in-process environment for app render scenarios: a fetch stub for its HTTP API and a
// session that answers the shell, thread and config subscriptions from fixtures. Other RPCs
// stay pending so nothing retries on timers. Everything above the wire is the app's own.
import {
  AuthStandardClientScopes,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  EventId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ServerConfig,
  type ServerProvider,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
  type VcsStatusStreamEvent,
  type OrchestrationProjectShell,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2Command,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
  type TerminalMetadataStreamEvent,
  type ThreadPullRequestLink,
} from "@houston-app/contracts";
import type {
  ConnectionAttemptError,
  ConnectionCatalogEntry,
  EnvironmentConnectionLease,
  RouteCheck,
} from "@houston-app/client-runtime/connection";
import type { WsRpcProtocolClient } from "@houston-app/client-runtime/rpc";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@houston-app/shared/keybindings";
import { APP_VERSION } from "~/branding";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcSchema } from "effect/rpc";

export const ENVIRONMENT_ID = EnvironmentId.make("environment-render");
export const PROJECT_ID = ProjectId.make("project-render");
const CODEX = ProviderInstanceId.make("codex");
const MODEL = { instanceId: CODEX, model: "gpt-5.4" };
const AT = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");

const descriptor = {
  environmentId: ENVIRONMENT_ID,
  label: "Render scenarios",
  platform: { os: "linux", arch: "x64" },
  // A matching version, since a mismatch adds an update banner a typical user never sees.
  serverVersion: APP_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "houston_session",
};

const serverConfig: ServerConfig = {
  ...Schema.decodeUnknownSync(ServerConfig)({
    environment: descriptor,
    auth,
    cwd: "/workspace/render",
    keybindingsConfigPath: "/workspace/.houston/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        instanceId: CODEX,
        driver: "codex",
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-03-17T19:12:28.000Z",
        models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/.houston/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {},
    threadSnapshotPagination: true,
    threadResumeCompletionMarker: true,
    shellResumeCompletionMarker: true,
  }),
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
};

const mutableProvider = (
  serverConfig.providers as unknown as Array<{ models: ServerProvider["models"] }>
)[0]!;
const defaultProviderModels = [...mutableProvider.models];

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "render",
  workspaceRoot: "/workspace/render",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-03-17T19:12:28.000Z",
  updatedAt: "2026-03-17T19:12:28.000Z",
};
let projectTitle = project.title;

const base = (threadId: ThreadId, runId: RunId, id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
});

function userItem(threadId: ThreadId, runId: RunId, id: string, ordinal: number, text: string) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  } satisfies OrchestrationV2TurnItem;
}

export function assistantItem(
  threadId: ThreadId,
  runId: RunId,
  id: string,
  ordinal: number,
  text: string,
  streaming = false,
) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming,
    ...(streaming ? { status: "running" as const, completedAt: null } : {}),
  } satisfies OrchestrationV2TurnItem;
}

function run(threadId: ThreadId, id: RunId, ordinal: number, userMessageId: string) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: CODEX,
    modelSelection: MODEL,
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: AT,
    startedAt: AT,
    completedAt: AT,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

export interface FakeThread {
  /** Makes this a side chat of that thread. */
  readonly sideChatOf?: ThreadId;
  /** Pull requests the thread shell reports as linked. */
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink>;
  /** Makes this a provider subagent started by that thread. */
  readonly subagentOf?: ThreadId;
  readonly id: ThreadId;
  readonly title: string;
  /** The checked-out branch the shell reports; defaults to `main`. */
  readonly branch?: string;
  /** A worktree path the shell reports, which puts the thread in worktree mode. */
  readonly worktreePath?: string;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  /** Runtime requests (pending questions, approvals) the thread projection reports. */
  readonly runtimeRequests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  /** Checkpoints the thread projection reports; the latest ready one is the pending change set. */
  readonly checkpoints?: ReadonlyArray<OrchestrationV2Checkpoint>;
  /** Reports a running provider session whose turns support native steering. */
  readonly supportsActiveSteering?: boolean;
}

/** The thread's latest run left these files changed: a ready checkpoint the composer summarises. */
export function withPendingChanges(
  thread: FakeThread,
  files: ReadonlyArray<{ path: string; additions: number; deletions: number }>,
): FakeThread {
  const latest = thread.runs.at(-1);
  if (latest === undefined) throw new Error(`thread ${thread.id} has no run to attach changes to`);
  const checkpoint: OrchestrationV2Checkpoint = {
    id: CheckpointId.make(`${thread.id}-checkpoint`),
    threadId: thread.id,
    scopeId: CheckpointScopeId.make(`${thread.id}-scope`),
    runId: latest.id,
    nodeId: NodeId.make(`${thread.id}-node`),
    parentCheckpointId: null,
    ordinalWithinScope: 1,
    appRunOrdinal: thread.runs.length,
    ref: CheckpointRef.make(`${thread.id}-ref`),
    status: "ready",
    files: files.map((file) => ({ ...file, kind: "modified" })),
    capturedAt: AT,
  };
  return { ...thread, checkpoints: [checkpoint] };
}

/** A thread of `turns` user prompts, each answered in markdown with a list and inline code. */
export function threadWithHistory(name: string, turns: number): FakeThread {
  const id = ThreadId.make(name);
  const runs: OrchestrationV2Run[] = [];
  const items: OrchestrationV2TurnItem[] = [];
  for (let turn = 0; turn < turns; turn++) {
    const runId = RunId.make(`${name}-run-${turn}`);
    runs.push(run(id, runId, turn + 1, `${name}-user-${turn}`));
    items.push(
      userItem(id, runId, `${name}-user-${turn}`, turn * 2, `${name}: question ${turn}`),
      assistantItem(
        id,
        runId,
        `${name}-assistant-${turn}`,
        turn * 2 + 1,
        `Answer ${turn} for ${name}.\n\n- checked \`Sidebar.tsx\`\n- ran the tests\n\n` +
          "The width is now `clamp(next, MIN_WIDTH, MAX_WIDTH)`, so the layout no longer jumps.",
      ),
    );
  }
  return { id, title: `Thread ${name}`, runs, items };
}

/** Every capability the projection reads, with native steering enabled. */
function fakeProviderCapabilities() {
  return {
    sessions: {
      supportsMultipleProviderThreadsPerSession: false,
      supportsModelSwitchInSession: true,
      supportsProviderSwitchingViaHandoff: false,
      supportsRuntimeModeSwitchInSession: true,
      pendingRequestsSurviveRestart: true,
    },
    threads: {
      canCreateEmptyThread: true,
      canReadThreadSnapshot: true,
      canRollbackThread: false,
      canForkThread: false,
      canForkFromTurn: false,
      canForkFromSubagentThread: false,
      exposesNativeThreadId: true,
    },
    turns: {
      exposesNativeTurnId: true,
      emitsTurnStarted: true,
      emitsTurnCompleted: true,
      supportsInterrupt: true,
      supportsActiveSteering: true,
      supportsSteeringByInterruptRestart: true,
      supportsQueuedMessages: true,
      terminalStatusQuality: "strong" as const,
    },
    streaming: {
      streamsAssistantText: true,
      streamsReasoning: false,
      streamsToolOutput: true,
      streamsPlanText: false,
      emitsMessageCompleted: true,
    },
    tools: {
      exposesToolItemIds: true,
      emitsToolStarted: true,
      emitsToolCompleted: true,
      emitsToolOutput: true,
      supportsMcpTools: false,
      supportsDynamicToolCallbacks: false,
    },
    approvals: {
      supportsCommandApproval: true,
      supportsFileReadApproval: false,
      supportsFileChangeApproval: false,
      supportsApplyPatchApproval: false,
      approvalsHaveNativeRequestIds: false,
      approvalCallbacksAreLiveOnly: true,
      approvalsCanOriginateFromSubagents: false,
    },
    planning: {
      emitsPlanUpdated: false,
      emitsTodoList: false,
      emitsProposedPlan: false,
      supportsStructuredQuestions: true,
      planDeltasHaveItemIds: false,
    },
    subagents: {
      supportsSubagents: false,
      exposesSubagentThreadIds: false,
      emitsSubagentLifecycle: false,
      canWaitForSubagents: false,
      canCloseSubagents: false,
      canForkSubagentThread: false,
    },
    context: {
      acceptsSystemContext: false,
      acceptsDeveloperContext: false,
      acceptsSyntheticUserContext: false,
      canGenerateSummaries: false,
      canConsumeHandoffSummaries: false,
      supportsDeltaHandoff: false,
      supportsFullThreadHandoff: false,
      maxRecommendedHandoffChars: null,
    },
    checkpointing: {
      appCanCheckpointFilesystem: false,
      supportsNestedCheckpointScopes: false,
      providerCanRollbackConversation: false,
      providerRollbackReturnsSnapshot: false,
      providerCanReadConversationSnapshot: false,
    },
    identity: {
      nativeThreadIds: "strong" as const,
      nativeTurnIds: "strong" as const,
      nativeItemIds: "strong" as const,
      nativeRequestIds: "weak" as const,
    },
    runtimePolicy: { enforcement: "client-boundary" as const },
  };
}

function shellOf(thread: FakeThread): OrchestrationV2ThreadShell {
  const latest = thread.runs.at(-1);
  return {
    id: thread.id,
    projectId: PROJECT_ID,
    title: thread.title,
    providerInstanceId: CODEX,
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: thread.branch ?? "main",
    worktreePath: thread.worktreePath ?? null,
    ...(thread.pullRequests ? { pullRequests: thread.pullRequests } : {}),
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: thread.sideChatOf ?? thread.subagentOf ?? thread.id,
      parentThreadId: thread.sideChatOf ?? thread.subagentOf ?? null,
      relationshipToParent: thread.subagentOf ? "subagent" : null,
      ...(thread.sideChatOf ? { sideChat: true } : {}),
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: thread.subagentOf ? "provider" : "web",
    latestRunId: latest?.id ?? null,
    activeRunId: null,
    // Idle reads as waiting on the user, which shows a per-second duration in the sidebar.
    status: latest ? "completed" : "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: AT,
    hasActionableProposedPlan: false,
    itemCount: thread.items.length,
    visibleItemCount: thread.items.length,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: AT,
    deletedAt: null,
  };
}

function projectionOf(thread: FakeThread): OrchestrationV2ThreadProjection {
  const shell = shellOf(thread);
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = thread.items.map(
    (item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: thread.id,
      sourceItemId: item.id,
      item,
    }),
  );
  return {
    thread: {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      providerInstanceId: shell.providerInstanceId,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      activeProviderThreadId: null,
      lineage: shell.lineage,
      forkedFrom: null,
      createdBy: "user",
      creationSource: shell.creationSource,
      createdAt: AT,
      updatedAt: AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: AT,
      deletedAt: null,
    },
    runs: [...thread.runs],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: thread.supportsActiveSteering
      ? [
          {
            id: ProviderSessionId.make(`${thread.id}-provider-session`),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: CODEX,
            status: "running",
            cwd: "/workspace/render",
            model: MODEL.model,
            capabilities: fakeProviderCapabilities(),
            createdAt: AT,
            updatedAt: AT,
            lastError: null,
          },
        ]
      : [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [...(thread.runtimeRequests ?? [])],
    messages: [],
    plans: [],
    turnItems: [...thread.items],
    checkpointScopes: [],
    checkpoints: [...(thread.checkpoints ?? [])],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: AT,
  };
}

/** Commands the renderer dispatched; the fake records them without answering. */
export const dispatchedCommands: OrchestrationV2Command[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Keyed by thread id: a live thread subscription's queue, for pushing events to it.
const threadSubscribers = new Map<string, Queue.Queue<OrchestrationV2ThreadStreamItem>>();
let terminalMetadataSubscriber: Queue.Queue<TerminalMetadataStreamEvent> | null = null;
let threads: ReadonlyArray<FakeThread> = [];
let deletedThreadIds: ReadonlySet<string> = new Set();
let sequence = 1;
let vcsStatusSubscriber: Queue.Queue<VcsStatusStreamEvent> | null = null;

const subscribe = <A>(first: ReadonlyArray<A>, register?: (queue: Queue.Queue<A>) => () => void) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<A>();
      yield* Queue.offerAll(queue, first);
      if (register) {
        const unregister = register(queue);
        yield* Effect.addFinalizer(() => Effect.sync(unregister));
      }
      return Stream.fromQueue(queue);
    }),
  );

const handlers: Record<string, (input: never) => unknown> = {
  // Recorded for assertions; still unanswered, like every state-changing call.
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (input: never) => {
    const command = input as OrchestrationV2Command;
    dispatchedCommands.push(command);
    // A visit is a no-op side effect; answering it lets the thread's command queue drain.
    return command.type === "thread.visit" ? Effect.succeed({ sequence: 0 }) : Effect.never;
  },
  [WS_METHODS.subscribeTerminalMetadata]: () =>
    subscribe<TerminalMetadataStreamEvent>([{ type: "snapshot", terminals: [] }], (queue) => {
      terminalMetadataSubscriber = queue;
      return () => {
        if (terminalMetadataSubscriber === queue) terminalMetadataSubscriber = null;
      };
    }),
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
    subscribe<OrchestrationV2ShellStreamItem>([
      {
        kind: "snapshot",
        snapshot: {
          schemaVersion: 1,
          snapshotSequence: sequence,
          projects: [{ ...project, title: projectTitle }],
          threads: threads.map(shellOf),
          archivedThreads: [],
        },
      },
      { kind: "synchronized" },
    ]),
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: { readonly threadId: ThreadId }) => {
    const thread = threads.find((candidate) => candidate.id === input.threadId);
    if (!thread && deletedThreadIds.has(input.threadId)) {
      // A thread the shell never lists whose detail reports it deleted.
      const projection = projectionOf(threadWithHistory(input.threadId, 0));
      return subscribe<OrchestrationV2ThreadStreamItem>([
        {
          kind: "snapshot",
          snapshotSequence: sequence,
          projection: { ...projection, thread: { ...projection.thread, deletedAt: AT } },
        },
        { kind: "synchronized" },
      ]);
    }
    if (!thread) return Stream.never;
    return subscribe<OrchestrationV2ThreadStreamItem>(
      [
        { kind: "snapshot", snapshotSequence: sequence, projection: projectionOf(thread) },
        { kind: "synchronized" },
      ],
      (queue) => {
        threadSubscribers.set(thread.id, queue);

        // A replaced subscription closes after its successor registers.
        return () => {
          if (threadSubscribers.get(thread.id) === queue) threadSubscribers.delete(thread.id);
        };
      },
    );
  },
  [WS_METHODS.subscribeVcsStatus]: () =>
    subscribe<VcsStatusStreamEvent>([], (queue) => {
      vcsStatusSubscriber = queue;
      return () => {
        if (vcsStatusSubscriber === queue) vcsStatusSubscriber = null;
      };
    }),
  [WS_METHODS.subscribeServerConfig]: () =>
    subscribe([{ version: 1 as const, type: "snapshot" as const, config: serverConfig }]),
};

// Unanswered calls stay pending, like a server that has not replied yet.
const client = new Proxy(handlers, {
  get: (target, method: string) =>
    target[method] ??
    (() => {
      const rpc = WsRpcGroup.requests.get(method);
      return rpc && RpcSchema.isStreamSchema(rpc.successSchema) ? Stream.never : Effect.never;
    }),
});

const session: EnvironmentConnectionLease["session"] = {
  client: client as unknown as WsRpcProtocolClient,
  initialConfig: Effect.succeed(serverConfig),
  subscribeServerConfig: () =>
    subscribe([{ version: 1 as const, type: "snapshot" as const, config: serverConfig }]),
  ready: Effect.void,
  probe: Effect.void,
  inboundFrames: Effect.succeed(0),
  closed: Effect.never,
};

/** Stands in for client-runtime's ConnectionDriver: every connection opens the session above. */
export const fakeDriver = {
  connect: (
    entry: ConnectionCatalogEntry,
  ): Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope> =>
    Effect.succeed({
      prepared: {
        environmentId: ENVIRONMENT_ID,
        label: descriptor.label,
        httpBaseUrl: window.location.origin,
        socketUrl: window.location.origin.replace(/^http/, "ws"),
        httpAuthorization: null,
        target: entry.target,
      },
      session,
    }),
  preflight: () => Effect.succeed(true),
  checkHost: () => Effect.succeed<RouteCheck>("unchecked"),
};
export type FakeDriver = typeof fakeDriver;

const realFetch = globalThis.fetch;
const encodedDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor)(
  Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)(descriptor),
);

/**
 * Serves the environment's HTTP API and these threads until disposed. `deletedThreadIds` names
 * threads that are absent from the shell and whose detail reports them deleted.
 */
export function installFakeEnvironment(
  fixtures: ReadonlyArray<FakeThread>,
  options: {
    readonly deletedThreadIds?: ReadonlyArray<string>;
    readonly projectTitle?: string;
    readonly providerModels?: ServerProvider["models"];
  } = {},
): Disposable {
  threads = fixtures;
  dispatchedCommands.length = 0;
  deletedThreadIds = new Set(options.deletedThreadIds ?? []);
  projectTitle = options.projectTitle ?? project.title;
  const models = options.providerModels ?? defaultProviderModels;
  mutableProvider.models = [...models];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.origin !== window.location.origin) return realFetch(input, init);
    if (url.pathname === "/.well-known/houston/environment") return json(encodedDescriptor);
    if (url.pathname === "/api/auth/session") {
      return json({
        authenticated: true,
        auth,
        scopes: AuthStandardClientScopes,
        sessionMethod: "browser-session-cookie",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    }
    // Snapshot endpoints fall back to the socket, which serves the same fixtures.
    if (/^\/(api|oauth|\.well-known)\//.test(url.pathname)) return json({}, 404);
    return realFetch(input, init);
  };
  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = realFetch;
      threads = [];
      deletedThreadIds = new Set();
      projectTitle = project.title;
      mutableProvider.models = [...defaultProviderModels];
    },
  };
}

type ThreadEvent = Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "event" }>["event"];

export async function emitTerminalMetadata(event: TerminalMetadataStreamEvent): Promise<void> {
  if (terminalMetadataSubscriber === null) throw new Error("No terminal metadata subscription");
  await Effect.runPromise(Queue.offer(terminalMetadataSubscriber, event));
}

/** Whether the app holds a live subscription to the thread, so events reach it. */
export function isThreadSubscribed(threadId: ThreadId): boolean {
  return threadSubscribers.has(threadId);
}

/** Delivers one domain event, such as a run or turn-item update, to the thread's subscription. */
export async function emitThreadEvent(
  threadId: ThreadId,
  event: Pick<ThreadEvent, "type" | "payload">,
): Promise<void> {
  const queue = threadSubscribers.get(threadId);
  if (!queue) throw new Error(`No live subscription for ${threadId}`);
  sequence += 1;
  await Effect.runPromise(
    Queue.offer(queue, {
      kind: "event",
      sequence,
      event: { ...event, id: EventId.make(`event-${sequence}`), threadId, occurredAt: AT },
    } as OrchestrationV2ThreadStreamItem),
  );
}

/**
 * The fake environment advertises no uploads, and a composer that cannot attach rejects every
 * dropped file. Call after `installFakeEnvironment`; disposing restores the fetch it wrapped.
 */
export function advertiseFileUploads(maxUploadBytes = 10 * 1024 * 1024): Disposable {
  return advertiseCapabilities({
    attachmentUploads: true,
    fileAttachments: { maxUploadBytes },
  });
}

/**
 * Adds `extra` to the capabilities the fake environment advertises. Call after
 * `installFakeEnvironment`; disposing restores the fetch it wrapped.
 */
export function advertiseCapabilities(extra: Record<string, unknown>): Disposable {
  const baseFetch = globalThis.fetch;
  const capabilities = { ...descriptor.capabilities, ...extra };
  // The server config carries its own decoded descriptor; the HTTP route serves one encoded at
  // load, so it is patched in flight.
  const configEnvironment = serverConfig.environment as { capabilities: object };
  const baseConfigCapabilities = configEnvironment.capabilities;
  configEnvironment.capabilities = capabilities;
  globalThis.fetch = async (input, init) => {
    const response = await baseFetch(input, init);
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (url.pathname !== "/.well-known/houston/environment") return response;
    const encoded = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...encoded, capabilities });
  };
  return {
    [Symbol.dispose]: () => {
      globalThis.fetch = baseFetch;
      configEnvironment.capabilities = baseConfigCapabilities;
    },
  };
}

export function runningRun(threadId: ThreadId, id: string, ordinal: number, userMessageId: string) {
  return {
    ...run(threadId, RunId.make(id), ordinal, userMessageId),
    status: "running" as const,
    completedAt: null,
  };
}

/**
 * A thread with one pending question: a user-input request and the item that carries its
 * questions, as the provider adapter reports them while a run waits for an answer.
 */
export function threadWithPendingQuestion(name: string): FakeThread {
  const history = threadWithHistory(name, 1);
  const id = ThreadId.make(name);
  const runId = RunId.make(`${name}-run-0`);
  const requestId = RuntimeRequestId.make(`${name}-question`);
  const item = {
    ...base(id, runId, `${name}-question-item`, 10),
    status: "running" as const,
    type: "user_input_request",
    requestId,
    questions: [
      {
        id: "q1",
        header: "Fixture",
        question: "Should this fixture prefer strict schemas or UI flexibility?",
        options: [
          { label: "Strict schemas (Recommended)", description: "Prefer strict schemas" },
          { label: "UI flexibility", description: "Prefer UI flexibility" },
        ],
      },
    ],
  } satisfies OrchestrationV2TurnItem;
  const request = {
    id: requestId,
    nodeId: NodeId.make(`${name}-node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: {
      type: "live",
      providerSessionId: ProviderSessionId.make(`${name}-session`),
    },
    createdAt: AT,
    resolvedAt: null,
  } satisfies OrchestrationV2RuntimeRequest;
  return { ...history, items: [...history.items, item], runtimeRequests: [request] };
}

/**
 * A thread with one pending command approval: the runtime request and the item that carries
 * its prompt, as the provider adapter reports them while a run waits for a decision.
 */
export function threadWithPendingApproval(name: string): FakeThread {
  const history = threadWithHistory(name, 1);
  const id = ThreadId.make(name);
  const runId = RunId.make(`${name}-run-0`);
  const requestId = RuntimeRequestId.make(`${name}-approval`);
  const item = {
    ...base(id, runId, `${name}-approval-item`, 10),
    status: "running" as const,
    type: "approval_request",
    requestId,
    requestKind: "command",
    prompt: "pnpm install --frozen-lockfile",
  } satisfies OrchestrationV2TurnItem;
  const request = {
    id: requestId,
    nodeId: NodeId.make(`${name}-node`),
    providerTurnId: null,
    nativeRequestRef: null,
    kind: "command",
    status: "pending",
    responseCapability: {
      type: "live",
      providerSessionId: ProviderSessionId.make(`${name}-session`),
    },
    createdAt: AT,
    resolvedAt: null,
  } satisfies OrchestrationV2RuntimeRequest;
  return { ...history, items: [...history.items, item], runtimeRequests: [request] };
}

export { userItem };

export async function emitVcsStatus(event: VcsStatusStreamEvent): Promise<void> {
  if (vcsStatusSubscriber === null) throw new Error("No VCS status subscription");
  await Effect.runPromise(Queue.offer(vcsStatusSubscriber, event));
}
