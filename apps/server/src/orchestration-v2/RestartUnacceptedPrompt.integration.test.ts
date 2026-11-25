import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  ComposerContextId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type ChatAttachment,
  type OrchestrationMessageContext,
  type OrchestrationV2ThreadProjection,
} from "@houston-app/contracts";
import { checkpointWorkspace } from "@houston-app/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@houston-app/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const PROMPT = "Fix the checkout page after [log](houston-context://v1/terminal/ctx_terminal)";

const screenshot: ChatAttachment = {
  type: "image",
  id: ChatAttachmentId.make("restart-unaccepted-screenshot"),
  name: "checkout.png",
  mimeType: "image/png",
  sizeBytes: 10,
};
const terminalContext: OrchestrationMessageContext = {
  version: 1,
  records: [
    {
      version: 1,
      contextId: ComposerContextId.make("ctx_terminal"),
      kind: "terminal",
      label: "Terminal 1 lines 1-2",
      terminalId: "term-1",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text: "error: checkout failed",
    },
  ],
};

/** A provider that accepts `accepts` turns and leaves the next one unanswered. */
const makeProvider = (input: { readonly cwd: string; readonly accepts: number }) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const unanswered = yield* Deferred.make<void>();
    const accepted: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
    const now = yield* DateTime.now;
    const emitTurn = (
      turn: ProviderAdapter.ProviderAdapterV2TurnInput,
      status: "running" | "completed",
    ) =>
      Queue.offer(events, {
        type: "provider_turn.updated",
        driver,
        providerTurn: {
          id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
          providerThreadId: turn.providerThread.id,
          nodeId: turn.rootNodeId,
          runAttemptId: turn.attemptId,
          nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
          ordinal: turn.providerTurnOrdinal,
          status,
          startedAt: now,
          completedAt: status === "running" ? null : now,
        },
      });
    const complete = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      emitTurn(turn, "completed").pipe(
        Effect.andThen(
          Queue.offer(events, {
            type: "turn.terminal",
            driver,
            providerThreadId: turn.providerThread.id,
            providerTurnId: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
            runOrdinal: turn.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          }),
        ),
      );
    const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.gen(function* () {
        if (accepted.length >= input.accepts) {
          yield* Deferred.succeed(unanswered, undefined);
          return yield* Effect.never;
        }
        accepted.push(turn);
        yield* emitTurn(turn, "running");
      });
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (session) =>
        Effect.succeed({
          instanceId,
          driver,
          providerSessionId: session.providerSessionId,
          providerSession: {
            id: session.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: session.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: () => Effect.die("unused"),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.die("unused"),
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        }),
    };
    return {
      accepted,
      complete,
      emitTurn,
      events,
      unanswered: Deferred.await(unanswered),
      registry: ProviderAdapterRegistry.layerSingle(adapter),
    };
  });
type Provider = Effect.Success<ReturnType<typeof makeProvider>>;

const databaseAt = (file: string) =>
  SqlitePersistence.layerFromPath(file).pipe(Layer.provide(services));

const driveThread = (name: string, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const create = orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: name,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const send = (
      text: string,
      options: {
        readonly createdBy?: "user" | "agent";
        readonly attachments?: ReadonlyArray<ChatAttachment>;
        readonly context?: OrchestrationMessageContext;
        readonly queued?: boolean;
      } = {},
    ) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`send:${name}:${text}`),
        threadId,
        messageId: MessageId.make(`message:${name}:${text}`),
        text,
        attachments: options.attachments ?? [],
        ...(options.context ? { context: options.context } : {}),
        dispatchMode: {
          type: options.queued === true ? "queue_after_active" : "start_immediately",
        },
        createdBy: options.createdBy ?? "user",
        creationSource: options.createdBy === "agent" ? "mcp" : "web",
      });
    const projection = orchestrator.getThreadProjection(threadId);
    const until = (predicate: (current: OrchestrationV2ThreadProjection) => boolean) =>
      Effect.gen(function* () {
        const reached = yield* orchestrator.streamDomainEvents.pipe(
          Stream.mapEffect(() => projection),
          Stream.filter(predicate),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        const current = yield* projection;
        return predicate(current) ? current : Option.getOrThrow(yield* Fiber.join(reached));
      });
    // The turn start is recorded as running, then the provider leaves it unanswered.
    const startUnanswered = (provider: Provider) =>
      worker.drain().pipe(Effect.forkScoped, Effect.andThen(provider.unanswered));
    const startAccepted = worker
      .drain()
      .pipe(
        Effect.andThen(
          until((current) => current.providerTurns.some((turn) => turn.status === "running")),
        ),
      );
    return {
      orchestrator,
      worker,
      threadId,
      create,
      send,
      projection,
      until,
      startUnanswered,
      startAccepted,
    };
  });
type Thread = Effect.Success<ReturnType<typeof driveThread>>;

/** One server on `database`; what it writes while it closes never reaches `snapshot`. */
const server = <A, E, R>(
  input: {
    readonly name: string;
    readonly cwd: string;
    readonly database: string;
    readonly snapshot: string;
    readonly provider: Provider;
    readonly recovers: boolean;
  },
  body: (thread: Thread, provider: Provider) => Effect.Effect<A, E, R>,
) => {
  const database = databaseAt(input.database);
  return Effect.scoped(
    Effect.gen(function* () {
      const thread = yield* driveThread(input.name, input.cwd);
      const result = yield* body(thread, input.provider);
      const sql = yield* SqlClient.SqlClient;
      yield* sql`VACUUM INTO ${input.snapshot}`;
      return result;
    }).pipe(
      Effect.provide(
        Layer.merge(
          ProviderReplayHarness.layerWithRegistry({ name: input.name }, input.provider.registry, {
            databaseLayer: database,
            ...(input.recovers
              ? { recoverOnStartup: true, continueThreadsAfterServerUpdate: true }
              : { runEffectWorker: false }),
          }),
          database,
        ),
      ),
    ),
  );
};

/** Runs `before` in one server, crashes it, and runs `after` in one that recovers its database. */
const restart = <A, B, E, F, R, S>(input: {
  readonly name: string;
  readonly accepts?: number;
  readonly acceptsAfter?: number;
  readonly before: (thread: Thread, provider: Provider) => Effect.Effect<A, E, R>;
  readonly after: (thread: Thread, provider: Provider) => Effect.Effect<B, F, S>;
  readonly restarts?: number;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "houston-restart-unaccepted-" });
    const cwd = yield* checkpointWorkspace(input.name);
    const file = (index: number) => path.join(directory, `state-${index}.sqlite`);
    yield* server(
      {
        name: input.name,
        cwd,
        database: file(0),
        snapshot: file(1),
        provider: yield* makeProvider({ cwd, accepts: input.accepts ?? 0 }),
        recovers: false,
      },
      (thread, provider) => thread.create.pipe(Effect.andThen(input.before(thread, provider))),
    );
    for (let index = 1; index < (input.restarts ?? 1); index += 1) {
      yield* server(
        {
          name: input.name,
          cwd,
          database: file(index),
          snapshot: file(index + 1),
          provider: yield* makeProvider({ cwd, accepts: 1 }),
          recovers: true,
        },
        (thread) => thread.orchestrator.resumeQueuedRuns,
      );
    }
    const last = input.restarts ?? 1;
    return yield* server(
      {
        name: input.name,
        cwd,
        database: file(last),
        snapshot: file(last + 1),
        provider: yield* makeProvider({ cwd, accepts: input.acceptsAfter ?? 1 }),
        recovers: true,
      },
      input.after,
    );
  }).pipe(Effect.scoped, Effect.provide(services));

const cut = (
  status: "starting" | "running",
  send: (thread: Thread) => ReturnType<Thread["send"]>,
) =>
  Effect.fnUntraced(function* (thread: Thread, provider: Provider) {
    yield* send(thread);
    if (status === "running") yield* thread.startUnanswered(provider);
    const left = yield* thread.projection;
    assert.equal(left.runs.at(-1)?.status, status);
    assert.lengthOf(left.providerTurns, 0);
  });

/** Lets a recovered server act: startup queue resumption, then every effect it recorded. */
const idle = (thread: Thread) =>
  thread.orchestrator.resumeQueuedRuns.pipe(
    Effect.andThen(thread.worker.drain()),
    Effect.andThen(thread.projection),
  );

it.live.each([
  ["starting", 1],
  ["running", 1],
  ["running", 2],
] as const)(
  "a user prompt cut while %s, before the provider confirmed receiving it, is held whole through %s restarts and sent once the user sends it",
  ([status, restarts]) =>
    restart({
      name: `unaccepted-user-${status}-${restarts}`,
      restarts,
      before: cut(status, (thread) =>
        thread.send(PROMPT, { attachments: [screenshot], context: terminalContext }),
      ),
      after: Effect.fnUntraced(function* (thread, provider) {
        const held = yield* idle(thread);
        assert.deepEqual(
          held.runs.map((run) => [run.status, run.queueHeld, run.startedAt]),
          [["queued", true, null]],
        );
        assert.deepEqual(
          held.attempts.map((attempt) => [attempt.status, attempt.startedAt]),
          [["pending", null]],
        );
        assert.deepEqual(
          held.nodes.map((node) => [node.kind, node.status, node.startedAt]),
          [["root_turn", "pending", null]],
        );
        assert.deepEqual(
          held.messages.map((message) => [message.text, message.attachments, message.context]),
          [[PROMPT, [screenshot], terminalContext]],
        );
        assert.deepEqual(
          held.turnItems.map((item) => [item.type, item.status]),
          [["user_message", "pending"]],
        );
        assert.lengthOf(provider.accepted, 0);

        yield* thread.orchestrator.dispatch({
          type: "queued-run.start",
          commandId: CommandId.make("send-now"),
          threadId: thread.threadId,
          runId: held.runs[0]!.id,
        });
        const sent = yield* thread.until((current) =>
          current.providerTurns.some((turn) => turn.status === "running"),
        );
        assert.deepEqual(
          sent.runs.map((run) => run.status),
          ["running"],
        );
        assert.lengthOf(sent.messages, 1);
        assert.lengthOf(provider.accepted, 1);
        const delivered = provider.accepted[0]!.message;
        assert.include(delivered.text, "Fix the checkout page after [Terminal: log");
        assert.include(delivered.text, "error: checkout failed");
        assert.lengthOf(delivered.text.split("Fix the checkout page").slice(1), 1);
        assert.deepEqual(delivered.attachments, [screenshot]);
      }),
    }),
);

it.live("a prompt held by a restart keeps its place ahead of the messages queued behind it", () =>
  restart({
    name: "unaccepted-user-queue",
    before: Effect.fnUntraced(function* (thread, provider) {
      yield* thread.send("first");
      yield* thread.startUnanswered(provider);
      yield* thread.send("second", { queued: true });
    }),
    after: Effect.fnUntraced(function* (thread, provider) {
      const held = yield* idle(thread);
      assert.deepEqual(
        held.runs.map((run) => [run.status, run.queueHeld, run.queuePosition]),
        [
          ["queued", true, 1],
          ["queued", true, 2],
        ],
      );
      assert.lengthOf(provider.accepted, 0);
    }),
  }),
);

it.live("a prompt the provider confirmed receiving, cut by a restart, is continued, not held", () =>
  restart({
    name: "accepted-running",
    accepts: 1,
    before: Effect.fnUntraced(function* (thread) {
      yield* thread.send("first");
      yield* thread.startAccepted;
    }),
    after: Effect.fnUntraced(function* (thread, provider) {
      const continued = yield* thread.until(() => provider.accepted.length === 1);
      assert.equal(continued.runs[0]?.status, "cancelled");
      assert.isFalse(continued.runs.some((run) => run.status === "queued"));
      assert.equal(continued.runs[1]?.restartContinuationOfRunId, continued.runs[0]?.id);
      assert.include(provider.accepted[0]!.message.text, "Continue where you left off.");
    }),
  }),
);

it.live("a prompt whose confirmed turn already ended is cancelled, not held", () =>
  restart({
    name: "accepted-turn-ended",
    accepts: 1,
    before: Effect.fnUntraced(function* (thread, provider) {
      yield* thread.send("first");
      yield* thread.startAccepted;
      // The crash falls between the turn's end and the run's.
      yield* provider.emitTurn(provider.accepted[0]!, "completed");
      const left = yield* thread.until((current) =>
        current.providerTurns.some((turn) => turn.status === "completed"),
      );
      assert.equal(left.runs[0]?.status, "running");
    }),
    after: Effect.fnUntraced(function* (thread, provider) {
      const recovered = yield* idle(thread);
      assert.deepEqual(
        recovered.runs.map((run) => run.status),
        ["cancelled"],
      );
      assert.lengthOf(provider.accepted, 0);
    }),
  }),
);

it.live.each(["starting", "running"] as const)(
  "an agent's prompt cut while %s, before the provider confirmed receiving it, is still cancelled",
  (status) =>
    restart({
      name: `unaccepted-agent-${status}`,
      before: cut(status, (thread) => thread.send("Review it", { createdBy: "agent" })),
      after: Effect.fnUntraced(function* (thread, provider) {
        const recovered = yield* idle(thread);
        assert.deepEqual(
          recovered.runs.map((run) => run.status),
          ["cancelled"],
        );
        assert.lengthOf(provider.accepted, 0);
      }),
    }),
);

it.live.each([
  ["starting", "queued"],
  ["running", "cancelled"],
] as const)(
  "a compaction cut while %s, before the provider confirmed receiving it, is %s",
  ([status, recoveredStatus]) =>
    restart({
      name: `unaccepted-compaction-${status}`,
      before: cut(status, (thread) => thread.send("/compact keep the API notes")),
      after: Effect.fnUntraced(function* (thread, provider) {
        const recovered = yield* idle(thread);
        assert.deepEqual(
          recovered.runs.map((run) => [run.status, run.queueHeld ?? false]),
          [[recoveredStatus, recoveredStatus === "queued"]],
        );
        assert.lengthOf(provider.accepted, 0);
      }),
    }),
);

it.live(
  "a message sent past a prompt held by a restart runs first, then the held prompt is sent",
  () =>
    restart({
      name: "unaccepted-user-retyped",
      acceptsAfter: 2,
      before: cut("running", (thread) => thread.send("Fix the checkout page")),
      after: Effect.fnUntraced(function* (thread, provider) {
        const held = yield* idle(thread);
        assert.deepEqual(
          held.runs.map((run) => [run.status, run.queueHeld]),
          [["queued", true]],
        );
        yield* thread.send("Fix the checkout page, retyped");
        const first = yield* thread.until((current) =>
          current.providerTurns.some((turn) => turn.status === "running"),
        );
        assert.lengthOf(provider.accepted, 1);
        assert.include(provider.accepted[0]!.message.text, "Fix the checkout page, retyped");
        assert.deepInclude(
          first.runs.find((run) => run.id === held.runs[0]!.id),
          { status: "queued", queueHeld: false },
        );
        yield* provider.complete(provider.accepted[0]!);
        const second = yield* thread.until(
          (current) =>
            current.providerTurns.filter((turn) => turn.status === "running").length === 1 &&
            current.providerTurns.length === 2,
        );
        assert.lengthOf(provider.accepted, 2);
        assert.equal(provider.accepted[1]!.runId, held.runs[0]!.id);
        assert.isTrue(provider.accepted[1]!.message.text.endsWith("Fix the checkout page"));
        assert.lengthOf(second.runs, 2);
      }),
    }),
);

it.live("background work cut beside a held prompt is noted on the run that started it", () =>
  restart({
    name: "unaccepted-background",
    accepts: 1,
    before: Effect.fnUntraced(function* (thread, provider) {
      yield* thread.send("Start the dev server");
      const running = yield* thread.startAccepted;
      yield* Queue.offer(provider.events, {
        type: "provider_thread.updated",
        driver,
        providerThread: {
          ...running.providerThreads[0]!,
          pendingBackgroundTasks: [{ taskId: "task-1", kind: "command", description: "pnpm dev" }],
        },
      });
      yield* provider.complete(provider.accepted[0]!);
      yield* thread.until((current) => current.runs[0]?.status !== "running");
      yield* thread.worker.drain();
      const finished = yield* thread.projection;
      assert.equal(finished.runs[0]?.status, "completed");
      assert.lengthOf(finished.providerThreads[0]?.pendingBackgroundTasks ?? [], 1);
      yield* thread.send("Now fix the checkout page");
      yield* thread.startUnanswered(provider);
    }),
    after: Effect.fnUntraced(function* (thread, provider) {
      const held = yield* idle(thread);
      assert.deepEqual(
        held.runs.map((run) => [run.status, run.restartCancelledBackgroundWork?.length ?? 0]),
        [
          ["completed", 1],
          ["queued", 0],
        ],
      );
      yield* thread.orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-queue"),
        threadId: thread.threadId,
      });
      yield* thread.until(() => provider.accepted.length === 1);
      assert.include(provider.accepted[0]!.message.text, "pnpm dev");
    }),
  }),
);
