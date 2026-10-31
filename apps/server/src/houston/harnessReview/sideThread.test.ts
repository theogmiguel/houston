// The review thread as a read-only side thread: started only by the server, replayed through each
// family's own adapter with no policy override (the policy must come from the side record, or the
// recorded frames differ), and refused every write path.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  OrchestrationV2RpcSchemas,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  type ProviderReplayTranscript,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  materializeReplayTranscriptWorkspace,
  readProviderReplayTranscript,
} from "@t3tools/provider-testing/replayTranscript";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as ClaudeAdapterV2 from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  ClaudeOrchestratorReplayHarness,
  makeClaudeObservedReplayHarness,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import { CodexOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import { OpenCode2OrchestratorReplayHarness } from "../../orchestration-v2/Adapters/OpenCode2AdapterV2.testkit.ts";
import { OpenCodeOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/OpenCodeAdapterV2.testkit.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { provideDeterministicTestRuntime } from "../../orchestration-v2/testkit/DeterministicRuntime.ts";
import { houstonSideReadOnly } from "../../orchestration-v2/testkit/fixtures/houston_side_read_only/input.ts";
import { TOOL_CALL_READ_ONLY_PROMPT } from "../../orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../../orchestration-v2/testkit/OrchestratorScenario.ts";
import {
  layerProviderReplay,
  type OrchestratorV2ProviderReplayHarness,
} from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import { selection } from "../sideThreads.testkit.ts";
import {
  HoustonHarnessService,
  HoustonHarnessStore,
  createProject,
  makeKit,
  model,
  runKit,
  settle,
} from "./harnessReview.testkit.ts";
import { reviewPrompt } from "./rules.ts";
import { reviewMessageId } from "./Runner.ts";

const decodeDispatch = Schema.decodeUnknownExit(OrchestrationV2RpcSchemas.dispatchCommand.input);

const REVIEW_SEND_REFUSAL =
  "A harness review's result reaches Houston when its run ends; it is not sent to a thread";
const SIDE_SOURCE_REFUSAL =
  "A side thread is read-only; it cannot be the source of an aside or a second opinion.";

/** An aside and a second opinion (on Claude, another provider) taken from a side thread's run. */
const fromSideThread = (
  source: ThreadId,
  runId: RunId,
  prefix: string,
): ReadonlyArray<OrchestrationV2ServerCommand> => [
  {
    type: "houston.aside.start",
    commandId: CommandId.make(`${prefix}:aside`),
    sourceThreadId: source,
    asideThreadId: ThreadId.make(`${prefix}-aside`),
    messageId: MessageId.make(`message:${prefix}-aside`),
    text: "What did you read?",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  },
  {
    type: "houston.second-opinion.request",
    commandId: CommandId.make(`${prefix}:second-opinion`),
    sourceThreadId: source,
    runId,
    reviewThreadId: ThreadId.make(`${prefix}-second-opinion`),
    modelSelection: model("claudeAgent"),
    createdBy: "user",
    creationSource: "web",
  },
];

/** The capability a refused command names, at any depth of its cause. */
const refusedCapability = (error: unknown): string | undefined => {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (record._tag === "CommandPolicyCapabilityUnsupportedError") {
      return typeof record.capability === "string" ? record.capability : undefined;
    }
    current = record.cause;
  }
  return undefined;
};

/** A fresh project whose review is set up on `instance`, paused. */
const startReview = (name: string, instance = "claudeAgent") =>
  Effect.gen(function* () {
    const harness = yield* HoustonHarnessService.HoustonHarnessService;
    const project = yield* createProject(name);
    yield* harness.setup({
      projectId: project.projectId,
      modelSelection: model(instance),
      schedule: "manual",
    });
    return { project, harness };
  });

describe("starting the review thread", () => {
  it.effect("the review thread is started only by the server", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("start-command");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { project, harness } = yield* startReview("start-command");
          kit.harness.script.hold.add(reviewMessageId(1));
          const started = yield* harness.runNow({ projectId: project.projectId });
          yield* settle;
          const projection = yield* orchestrator.getThreadProjection(
            ThreadId.make(started.threadId),
          );
          assert.deepEqual(projection.thread.side, {
            kind: "harnessReview",
            reviewId: started.reviewId,
          });
          assert.deepEqual(projection.thread.modelSelection, model("claudeAgent"));
          assert.equal(projection.thread.worktreePath, project.root);
          assert.equal(projection.thread.projectId, project.projectId);
          const first = projection.messages.find((message) => message.role === "user");
          assert.equal(
            first?.text,
            reviewPrompt({
              reviewId: started.reviewId,
              runDir: (yield* (yield* HoustonHarnessStore.HoustonHarnessStore).getReview(
                started.reviewId,
              ))!.runDir,
            }),
          );
          assert.equal(first?.id, reviewMessageId(started.reviewId));
          const turn = kit.harness.log.started.find(
            (entry) => entry.input.threadId === started.threadId,
          );
          assert.isDefined(turn);
          assert.isTrue(turn!.input.message.text.startsWith("What this run sends"));

          // The same command from a client is not a client command and creates nothing.
          const fromClient = {
            type: "houston.harness-review.start",
            commandId: "command:client-start",
            threadId: "thread:client-review",
            projectId: project.projectId,
            reviewId: 99,
            modelSelection: model("claudeAgent"),
            messageId: "message:client-review",
            text: "What this run sends",
          };
          const decoded = decodeDispatch(fromClient);
          assert.equal(decoded._tag, "Failure");
          const missing = yield* Effect.exit(
            orchestrator.getThreadProjection(ThreadId.make("thread:client-review")),
          );
          assert.equal(missing._tag, "Failure");
        }),
      );
    }),
  );
});

const READ_ONLY_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
  interactionMode: "default",
} as const;

const fixture = (path: string) =>
  new URL(`../../orchestration-v2/testkit/fixtures/${path}`, import.meta.url);

const readFixture = (file: URL) =>
  readProviderReplayTranscript(file).pipe(Effect.provide(NodeServices.layer));

const withRuntimeInstructions = (
  transcript: ProviderReplayTranscript,
  modelSelection: ModelSelection,
  driver: string,
) =>
  materializeReplayTranscriptRuntimeInstructions(transcript, {
    driver: ProviderDriverKind.make(driver),
    model: modelSelection.model,
  });

/** A review thread as the server stores it, with the modes of a Full access, Plan scheduled task. */
const reviewThreadRecord = (input: {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly worktreePath: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread => ({
  createdBy: "system",
  creationSource: "server",
  id: input.threadId,
  projectId: ProjectId.make("project:harness-families"),
  title: "Harness review",
  providerInstanceId: input.modelSelection.instanceId,
  modelSelection: input.modelSelection,
  runtimeMode: "full-access",
  interactionMode: "plan",
  branch: null,
  worktreePath: input.worktreePath,
  activeProviderThreadId: null,
  lineage: { rootThreadId: input.threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  side: { kind: "harnessReview", reviewId: 1 },
  createdAt: input.now,
  updatedAt: input.now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Seeds a review thread and replays one turn on it through the provider's own adapter. */
const replayOnReviewThread = <Transcript extends ProviderReplayTranscript, E>(input: {
  readonly name: string;
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, E>;
  readonly transcript: Transcript;
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly prompt: string;
  readonly worktreePath: string;
}) =>
  Effect.gen(function* () {
    const command = {
      type: "message.dispatch",
      createdBy: "system",
      creationSource: "server",
      commandId: CommandId.make(`command:${input.name}:message`),
      threadId: input.threadId,
      messageId: MessageId.make(`message:${input.name}`),
      text: input.prompt,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    } as const;
    const scenario = {
      name: input.name,
      transcript: input.transcript,
      commands: [command],
      steps: [
        { type: "dispatch" as const, command, await: true },
        { type: "await_thread_idle" as const, threadId: input.threadId },
      ],
      projectionThreadIds: [input.threadId],
    };
    return yield* Effect.gen(function* () {
      const eventSink = yield* EventSink.EventSinkV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const thread = reviewThreadRecord({ ...input, now });
      yield* eventSink.write({
        events: [
          {
            id: yield* ids.allocate.event({ threadId: input.threadId }),
            type: "thread.created",
            threadId: input.threadId,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: thread,
          } as OrchestrationV2DomainEvent,
        ],
      });
      return yield* runOrchestratorV2Scenario(scenario);
    }).pipe(
      Effect.provide(
        Layer.merge(
          IdAllocator.layer,
          layerProviderReplay(scenario, input.harness, {
            configureMcp: true,
            mcpSessionRegistry: McpSessionRegistryTestkit.layer,
          }),
        ),
      ),
      provideDeterministicTestRuntime,
    );
  });

const workspace = (name: string) => checkpointWorkspace(`harness-families-${name}`);

describe("the review thread runs read-only", () => {
  it.effect("a review thread runs read-only with no t3 tools", () =>
    Effect.gen(function* () {
      // Claude: the query opens in dontAsk with read tools only and no T3 MCP server.
      const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
      const claudeSelection = selection("claudeAgent", "claude-sonnet-4-6");
      const claudeTranscript = yield* ClaudeOrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(
          yield* readFixture(fixture("tool_call_read_only/claude_transcript.ndjson")),
          claudeSelection,
          "claudeAgent",
        ),
      );
      const claude = makeClaudeObservedReplayHarness(claudeTranscript, (input) =>
        opened.push(input),
      );
      const claudeThread = ThreadId.make("thread:claude-review");
      const claudeResult = yield* replayOnReviewThread({
        name: "harness_review_read_only/claude",
        harness: claude.harness,
        transcript: claudeTranscript,
        threadId: claudeThread,
        modelSelection: claudeSelection,
        prompt: TOOL_CALL_READ_ONLY_PROMPT,
        worktreePath: yield* workspace("claude"),
      });
      yield* claude.assertComplete;
      assert.equal(claudeResult.projections.get(claudeThread)?.runs[0]?.status, "completed");
      assert.lengthOf(opened, 1);
      assert.equal(opened[0]!.options.permissionMode, "dontAsk");
      assert.deepEqual(opened[0]!.options.tools, ["Read", "Glob", "Grep"]);
      assert.isUndefined(opened[0]!.options.allowDangerouslySkipPermissions);
      assert.isFalse(Object.keys(opened[0]!.options.mcpServers ?? {}).includes("t3-code"));

      // Codex: the recorded read-only turn/start, sandbox read-only with network off, matches.
      const codexCwd = yield* workspace("codex");
      const codexRaw = yield* readFixture(houstonSideReadOnly.codex.transcriptFile);
      const firstTurnEnd = codexRaw.entries.findIndex(
        (entry) =>
          entry.type === "emit_inbound" &&
          (entry as { readonly label?: string }).label === "turn/completed",
      );
      const codexTranscript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
        materializeReplayTranscriptWorkspace(
          { ...codexRaw, entries: codexRaw.entries.slice(0, firstTurnEnd + 1) },
          codexCwd,
        ),
      );
      const codexThread = ThreadId.make("thread:codex-review");
      const codexResult = yield* replayOnReviewThread({
        name: "harness_review_read_only/codex",
        harness: CodexOrchestratorReplayHarness,
        transcript: codexTranscript,
        threadId: codexThread,
        modelSelection: houstonSideReadOnly.codex.modelSelection,
        prompt: houstonSideReadOnly.codex.sourcePrompt,
        worktreePath: codexCwd,
      });
      assert.equal(codexResult.projections.get(codexThread)?.runs[0]?.status, "completed");
      const turnStart = codexTranscript.entries.find(
        (entry) =>
          entry.type === "expect_outbound" &&
          (entry as { readonly label?: string }).label === "turn/start",
      ) as { readonly frame: { readonly params: Record<string, unknown> } };
      assert.equal(turnStart.frame.params.approvalPolicy, "never");
      assert.deepEqual(turnStart.frame.params.sandboxPolicy, {
        type: "readOnly",
        networkAccess: false,
      });

      // OpenCode 1 and 2: the recorded session denies every write and asks nothing.
      const opencodeSpec = houstonSideReadOnly.opencode;
      const opencodeTranscript = yield* OpenCodeOrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(
          yield* readFixture(opencodeSpec.transcriptFile),
          opencodeSpec.modelSelection,
          "opencode",
        ),
      );
      const opencodeThread = ThreadId.make("thread:opencode-review");
      const opencodeResult = yield* replayOnReviewThread({
        name: "harness_review_read_only/opencode",
        harness: OpenCodeOrchestratorReplayHarness,
        transcript: opencodeTranscript,
        threadId: opencodeThread,
        modelSelection: opencodeSpec.modelSelection,
        prompt: opencodeSpec.prompt,
        worktreePath: yield* workspace("opencode"),
      });
      assert.equal(opencodeResult.projections.get(opencodeThread)?.runs[0]?.status, "completed");

      const opencode2Spec = houstonSideReadOnly.opencode2;
      const opencode2Transcript = yield* OpenCode2OrchestratorReplayHarness.decodeTranscript(
        withRuntimeInstructions(
          yield* readFixture(opencode2Spec.transcriptFile),
          opencode2Spec.modelSelection,
          "opencode",
        ),
      );
      const opencode2Thread = ThreadId.make("thread:opencode2-review");
      const opencode2Result = yield* replayOnReviewThread({
        name: "harness_review_read_only/opencode2",
        harness: OpenCode2OrchestratorReplayHarness,
        transcript: opencode2Transcript,
        threadId: opencode2Thread,
        modelSelection: opencode2Spec.modelSelection,
        prompt: opencode2Spec.prompt,
        worktreePath: yield* workspace("opencode2"),
      });
      assert.equal(opencode2Result.projections.get(opencode2Thread)?.runs[0]?.status, "completed");

      // Every read-only family through the orchestrator: the read-only policy and no credential.
      const kit = yield* makeKit("read-only-families");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const harness = yield* HoustonHarnessService.HoustonHarnessService;
          for (const instance of ["claudeAgent", "codex", "opencode", "opencode2"]) {
            const project = yield* createProject(`read-only-${instance}`);
            yield* harness.setup({
              projectId: project.projectId,
              modelSelection: model(instance),
              schedule: "manual",
            });
            const started = yield* harness.runNow({ projectId: project.projectId });
            yield* settle;
            const turns = kit.harness.log.started.filter(
              (entry) => entry.input.threadId === started.threadId,
            );
            assert.isAbove(turns.length, 0, instance);
            for (const turn of turns) {
              assert.deepInclude(turn.input.runtimePolicy, READ_ONLY_POLICY, instance);
              assert.isUndefined(turn.mcp, instance);
            }
            assert.notInclude(kit.harness.log.mcpIssued, started.threadId, instance);
          }
        }),
      );
    }).pipe(Effect.scoped),
  );
});

describe("the review thread id namespace", () => {
  it.effect("no client thread takes a harness review thread id", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("reserved-ids");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { project, harness } = yield* startReview("reserved-ids", "codex");
          const reserved = ThreadId.make("harness-review:1");
          const refusal = yield* Effect.flip(
            orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("client:squat"),
              threadId: reserved,
              projectId: project.projectId,
              title: "Squatter",
              modelSelection: model("codex"),
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: project.root,
              createdBy: "user",
              creationSource: "web",
            }),
          );
          assert.include(
            userFacingDispatchErrorMessage(refusal) ?? "",
            'Thread id harness-review:1 is reserved: ids starting "harness-review:" belong to harness review threads.',
          );
          const forked = yield* Effect.flip(
            orchestrator.dispatch({
              type: "thread.fork",
              commandId: CommandId.make("client:squat-fork"),
              sourceThreadId: ThreadId.make("thread:anything"),
              targetThreadId: ThreadId.make("harness-review:2"),
              sourcePoint: { type: "latest_stable" },
              createdBy: "user",
              creationSource: "web",
            }),
          );
          assert.include(userFacingDispatchErrorMessage(forked) ?? "", "is reserved");

          // Review 1 still gets its thread.
          const started = yield* harness.runNow({ projectId: project.projectId });
          assert.equal(started.threadId, "harness-review:1");
          const projection = yield* orchestrator.getThreadProjection(reserved);
          assert.equal(projection.thread.side?.kind, "harnessReview");
        }),
      );
    }),
  );
});

describe("the review thread's write paths", () => {
  it.effect("a review thread refuses every write path", () =>
    Effect.gen(function* () {
      const kit = yield* makeKit("write-paths");
      yield* runKit(
        kit,
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const { project, harness } = yield* startReview("write-paths", "codex");
          const started = yield* harness.runNow({ projectId: project.projectId });
          yield* settle;
          const review = ThreadId.make(started.threadId);
          const projection = yield* orchestrator.getThreadProjection(review);
          const runId = projection.runs[0]!.id;
          const commands: ReadonlyArray<OrchestrationV2ServerCommand> = [
            {
              type: "thread.fork",
              commandId: CommandId.make("review:fork"),
              sourceThreadId: review,
              targetThreadId: ThreadId.make("review-fork"),
              sourcePoint: { type: "latest_stable" },
              createdBy: "user",
              creationSource: "web",
            },
            {
              type: "thread.merge_back",
              commandId: CommandId.make("review:merge"),
              sourceThreadId: review,
              targetThreadId: ThreadId.make("review-target"),
              sourcePoint: { type: "latest_stable" },
              createdBy: "user",
              creationSource: "web",
            },
            {
              type: "delegated_task.request",
              commandId: CommandId.make("review:delegate"),
              parentThreadId: review,
              parentRunId: runId,
              parentNodeId: NodeId.make("node:review"),
              task: "Edit the harness",
              modelSelection: model("codex"),
              runtimeMode: "full-access",
              interactionMode: "default",
              createdBy: "agent",
              creationSource: "mcp",
            },
            {
              type: "checkpoint.rollback",
              commandId: CommandId.make("review:rollback"),
              threadId: review,
              scopeId: CheckpointScopeId.make("scope:review"),
              checkpointId: CheckpointId.make("checkpoint:review"),
            },
          ];
          for (const command of commands) {
            const error = yield* Effect.flip(orchestrator.dispatch(command));
            assert.match(
              userFacingDispatchErrorMessage(error) ?? "",
              /read-only|only through Send to thread/,
              command.type,
            );
          }
          const send = yield* Effect.flip(
            orchestrator.dispatch({
              type: "houston.side-thread.send",
              commandId: CommandId.make("review:send"),
              sideThreadId: review,
              runId,
            }),
          );
          assert.include(userFacingDispatchErrorMessage(send) ?? "", REVIEW_SEND_REFUSAL);
          const moved = yield* Effect.flip(
            orchestrator.dispatch({
              type: "provider.switch",
              commandId: CommandId.make("review:switch"),
              threadId: review,
              modelSelection: model("antigravity"),
            }),
          );
          assert.equal(refusedCapability(moved), "read_only_run");
          const after = yield* orchestrator.getThreadProjection(review);
          assert.equal(after.thread.providerInstanceId, "codex");
          // Its content never starts an aside or reaches another provider as a second opinion.
          const turnsBefore = kit.harness.log.started.length;
          for (const command of fromSideThread(review, runId, "review")) {
            const error = yield* Effect.flip(orchestrator.dispatch(command));
            assert.include(
              userFacingDispatchErrorMessage(error) ?? "",
              SIDE_SOURCE_REFUSAL,
              command.type,
            );
          }
          yield* settle;
          assert.lengthOf(kit.harness.log.started, turnsBefore);
          for (const missing of [
            "review-fork",
            "review-target",
            "review-aside",
            "review-second-opinion",
          ]) {
            const exit = yield* Effect.exit(
              orchestrator.getThreadProjection(ThreadId.make(missing)),
            );
            assert.equal(exit._tag, "Failure", missing);
          }

          // An aside of an ordinary thread keeps its behaviour.
          const sourceId = ThreadId.make("thread:ordinary");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("ordinary:create"),
            threadId: sourceId,
            projectId: project.projectId,
            title: "Ordinary",
            modelSelection: model("codex"),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: project.root,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("ordinary:send"),
            threadId: sourceId,
            messageId: MessageId.make("message:ordinary"),
            text: "Do the work",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* settle;
          yield* orchestrator.dispatch({
            type: "houston.aside.start",
            commandId: CommandId.make("ordinary:aside"),
            sourceThreadId: sourceId,
            asideThreadId: ThreadId.make("thread:ordinary-aside"),
            messageId: MessageId.make("message:ordinary-aside"),
            text: "Why?",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          });
          yield* settle;
          const aside = yield* orchestrator.getThreadProjection(
            ThreadId.make("thread:ordinary-aside"),
          );
          assert.equal(aside.thread.side?.kind, "aside");

          // Any side thread, an aside included, is refused as a source the same way.
          const asideRun = aside.runs[0]!.id;
          for (const command of fromSideThread(aside.thread.id, asideRun, "aside")) {
            const error = yield* Effect.flip(orchestrator.dispatch(command));
            assert.include(
              userFacingDispatchErrorMessage(error) ?? "",
              SIDE_SOURCE_REFUSAL,
              command.type,
            );
          }
        }),
      );
    }),
  );
});
